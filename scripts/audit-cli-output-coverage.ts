#!/usr/bin/env bun
/**
 * CLI output-coverage audit (mt#3870).
 *
 * Enumerates every command in the shared command registry, subtracts the ones
 * the CLI renders deliberately — a per-command `outputFormatter` in
 * `src/adapters/cli/customizations/*.ts`, or a case in `formatObjectResult`'s
 * switch — and classifies what the generic fallback does with the rest.
 *
 * Background: mt#3478 found two commands (`config doctor`, `config validate`)
 * whose entire payload was replaced by `✅ Success` at the CLI surface, and
 * scoped the sweep out. This is that sweep. `workspace info` and `git status`
 * were two more, confirmed live before mt#3870's fix landed.
 *
 * Usage:
 *   bun scripts/audit-cli-output-coverage.ts           # human-readable report
 *   bun scripts/audit-cli-output-coverage.ts --json    # machine-readable
 *   bun scripts/audit-cli-output-coverage.ts --bucket payload-rendered
 */
import "reflect-metadata";
import { Glob } from "bun";
import { registerAllSharedCommands } from "../src/adapters/shared/commands/index";
import { sharedCommandRegistry } from "../src/adapters/shared/command-registry";
import { SWITCH_HANDLED_COMMAND_IDS } from "../src/adapters/shared/bridges/cli/result-formatter";
import { getTasksCustomizations } from "../src/adapters/cli/customizations/tasks-customizations";
import { getGitCustomizations } from "../src/adapters/cli/customizations/git-customizations";
import { getSessionCustomizations } from "../src/adapters/cli/customizations/session-customizations";
import {
  getConfigCustomizations,
  getPersistenceCustomizations,
} from "../src/adapters/cli/customizations/config-customizations";
import { getToolsCustomizations } from "../src/adapters/cli/customizations/tools-customizations";
import { getMcpCustomizations } from "../src/adapters/cli/customizations/mcp-customizations";
import { getInitCustomizations } from "../src/adapters/cli/customizations/init-customizations";
import { getCompileCustomizations } from "../src/adapters/cli/customizations/compile-customizations";
import { getAiCustomizations } from "../src/adapters/cli/customizations/ai-customizations";

/**
 * How the generic fallback treats a command's result.
 *
 * The names describe the OUTPUT PATH taken, not a quality judgment: a command
 * in `json-dump` is not broken, it is merely unstyled.
 */
type Bucket =
  | /** The command prints its own report; the fallback stays out of the way. */ "renders-own-report"
  | /** The result carries `message`/`output` — a projection the fallback prints. */ "projection"
  | /** `success` plus payload keys; the fallback prints the status line then the keys. */ "payload-rendered"
  | /** No `success` key, so the whole result prints as JSON. */ "json-dump";

interface Classification {
  id: string;
  category: string;
  bucket: Bucket;
  /** Whether the command declares a `json` parameter, i.e. has a `--json` escape hatch. */
  hasJsonFlag: boolean;
  /** Where the classified source text came from — see `readCommandSource`. */
  basis: "execute-source" | "defining-file";
  /**
   * Whether a return literal spread keys in (`...rest`). The reading is then a
   * lower bound on the payload, not a full picture.
   */
  keysBehindSpread: boolean;
}

/** Any of the three operator-visible CLI output channels — see the logger's line counter. */
const SELF_PRINT_RE = /log\.(cli|cliWarn|cliError)\(/;
const RETURN_LITERAL = "return {";

/**
 * Longest `execute` body still treated as a thin delegation when it contains no
 * return literal. Above this the body is substantial enough that its own text
 * is the better reading even without a literal — see `readCommandSource` for
 * the measurements behind keeping this narrow.
 */
const THIN_BODY_MAX_LENGTH = 200;

/**
 * Top-level keys of every `return { … }` object literal in `text`.
 *
 * Depth matters: the formatter reads `result.message`, so only a key at the
 * literal's own top level counts. A token scan that ignored nesting classified
 * `config doctor` as already-projected because each of its nine diagnostics
 * carries an inner `message` field — while the top-level result carried none,
 * which is precisely why mt#3478 found it printing a bare success line. That
 * false negative is what this walker exists to prevent, and the pre-mt#3478
 * acceptance run is what catches it if this regresses.
 *
 * Keys behind a spread (`...rest`) are invisible here; `hasSpread` reports that
 * so the caller can treat the reading as incomplete rather than authoritative.
 */
function topLevelReturnKeys(text: string): { keys: Set<string>; hasSpread: boolean } {
  const keys = new Set<string>();
  let hasSpread = false;

  for (let start = text.indexOf(RETURN_LITERAL); start !== -1; ) {
    let depth = 0;
    let quote: string | null = null;
    let index = start + RETURN_LITERAL.length - 1;

    for (; index < text.length; index++) {
      const char = text[index];
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{" || char === "[" || char === "(") depth++;
      else if (char === "}" || char === "]" || char === ")") {
        depth--;
        if (depth === 0) break;
      } else if (depth === 1) {
        // Depth 1 is the returned literal's own key list.
        const rest = text.slice(index);
        const key = rest.match(/^([A-Za-z_$][\w$]*)\s*[:,}]/);
        if (key?.[1] && /[{,\s]/.test(text[index - 1] ?? "")) {
          keys.add(key[1]);
          index += key[1].length - 1;
          continue;
        }
        if (rest.startsWith("...")) hasSpread = true;
      }
    }
    start = text.indexOf(RETURN_LITERAL, index + 1);
  }

  return { keys, hasSpread };
}

/**
 * Index every non-test source file once, so the defining-file fallback below is
 * a map lookup per command rather than a repo scan per command.
 */
async function indexSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for await (const path of new Glob("src/**/*.ts").scan(".")) {
    if (path.includes(".test.")) continue;
    sources.set(path, await Bun.file(path).text());
  }
  return sources;
}

/**
 * The source text to classify a command from.
 *
 * `execute.toString()` is preferred because it is exact — it is the function
 * actually registered, with no name-collision risk. It falls down for a thin
 * body that delegates elsewhere, where the registered function's own text says
 * nothing about the payload: `(p, c) => command.execute(p, c)`, or
 * `async () => getRulesPresets()`.
 *
 * The fallback is the file declaring `id: "<the id>"`, scanned WHOLE — a
 * deliberately coarse reading, since one file often defines several commands
 * and their text bleeds together. That coarseness is why the trigger is kept
 * narrow rather than widened to every body lacking a return literal. Both
 * wider alternatives were tried and measured against this tree:
 *
 * - Matching only the `x.execute(…)` forwarding shape misses a delegation to a
 *   plain function; `rules.config`, `rules.presets`, and `reviewer.retrigger`
 *   all fell through to `json-dump` on an empty reading.
 * - Falling back whenever no return literal is present — which also catches a
 *   body returning an already-built variable — puts 80 of 189 commands on the
 *   whole-file scan, and inflates `renders-own-report` from 13 to 23 as one
 *   command's `log.cli` is attributed to every command sharing its file.
 *
 * So the trigger stays "thin AND no return literal", which leaves 13 of 189 on
 * the coarse path. Those are marked `basis: "defining-file"` and reported as
 * such, because the honest handling of an approximate reading is to label it,
 * not to hide it behind a wider one.
 */
function readCommandSource(
  id: string,
  execute: unknown,
  sources: Map<string, string>
): { text: string; basis: Classification["basis"] } {
  const executeSource = String(execute);
  const isThinDelegation =
    executeSource.length < THIN_BODY_MAX_LENGTH &&
    topLevelReturnKeys(executeSource).keys.size === 0;
  if (!isThinDelegation) {
    return { text: executeSource, basis: "execute-source" };
  }
  for (const [, text] of sources) {
    if (text.includes(`id: "${id}"`)) {
      return { text, basis: "defining-file" };
    }
  }
  return { text: executeSource, basis: "execute-source" };
}

function classify(text: string): { bucket: Bucket; hasSpread: boolean } {
  const { keys, hasSpread } = topLevelReturnKeys(text);
  if (SELF_PRINT_RE.test(text)) return { bucket: "renders-own-report", hasSpread };
  if (keys.has("message") || keys.has("output")) return { bucket: "projection", hasSpread };
  if (keys.has("success")) return { bucket: "payload-rendered", hasSpread };
  return { bucket: "json-dump", hasSpread };
}

/** Command ids carrying a per-command `outputFormatter`, across every CLI category. */
function collectFormatterIds(): Set<string> {
  const configs = [
    getTasksCustomizations(),
    getGitCustomizations(),
    getSessionCustomizations(),
    getConfigCustomizations(),
    getPersistenceCustomizations(),
    getToolsCustomizations(),
    getMcpCustomizations(),
    getInitCustomizations(),
    getCompileCustomizations(),
    getAiCustomizations(),
  ];
  const ids = new Set<string>();
  for (const config of configs) {
    for (const [id, commandOptions] of Object.entries(config.options?.commandOptions ?? {})) {
      if ((commandOptions as { outputFormatter?: unknown })?.outputFormatter) ids.add(id);
    }
  }
  return ids;
}

export interface AuditReport {
  totalRegistered: number;
  withOutputFormatter: string[];
  switchHandled: string[];
  /** Commands reaching the generic fallback, classified by output path. */
  fallthrough: Classification[];
  /** Commands declaring no `json` parameter, for which the fallback is the only output path. */
  withoutJsonFlag: number;
}

export async function runAudit(): Promise<AuditReport> {
  await registerAllSharedCommands();
  const sources = await indexSources();
  const formatterIds = collectFormatterIds();
  const switchHandled = new Set(SWITCH_HANDLED_COMMAND_IDS);

  const all = sharedCommandRegistry.getAllCommands();
  const fallthrough: Classification[] = [];
  for (const command of all) {
    if (formatterIds.has(command.id) || switchHandled.has(command.id)) continue;
    const { text, basis } = readCommandSource(command.id, command.execute, sources);
    const { bucket, hasSpread } = classify(text);
    fallthrough.push({
      id: command.id,
      category: String(command.category),
      bucket,
      hasJsonFlag: "json" in (command.parameters ?? {}),
      basis,
      keysBehindSpread: hasSpread,
    });
  }

  return {
    totalRegistered: all.length,
    withOutputFormatter: [...formatterIds].sort(),
    switchHandled: [...switchHandled].sort(),
    fallthrough: fallthrough.sort((a, b) => a.id.localeCompare(b.id)),
    withoutJsonFlag: all.filter((command) => !("json" in (command.parameters ?? {}))).length,
  };
}

const BUCKET_ORDER: Bucket[] = [
  "payload-rendered",
  "json-dump",
  "renders-own-report",
  "projection",
];

function printReport(report: AuditReport, bucketFilter?: string): void {
  console.log(`Registered commands:        ${report.totalRegistered}`);
  console.log(`  with an outputFormatter:  ${report.withOutputFormatter.length}`);
  console.log(`  handled by the switch:    ${report.switchHandled.length}`);
  console.log(`  reaching the fallback:    ${report.fallthrough.length}`);
  console.log(`Commands with no --json flag: ${report.withoutJsonFlag}`);

  for (const bucket of BUCKET_ORDER) {
    if (bucketFilter && bucket !== bucketFilter) continue;
    const members = report.fallthrough.filter((entry) => entry.bucket === bucket);
    console.log(`\n## ${bucket} (${members.length})`);
    for (const entry of members) {
      const flags = [entry.hasJsonFlag ? "--json" : "no --json"];
      if (entry.basis === "defining-file") flags.push("classified from defining file");
      console.log(`  ${entry.id}  [${flags.join(", ")}]`);
    }
  }
}

if (import.meta.main) {
  const report = await runAudit();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const bucketIndex = process.argv.indexOf("--bucket");
    printReport(report, bucketIndex === -1 ? undefined : process.argv[bucketIndex + 1]);
  }
}
