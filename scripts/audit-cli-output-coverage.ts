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
}

/**
 * A command whose `execute` is a thin wrapper delegating to a class method
 * (`(params, ctx) => command.execute(params, ctx)`) exposes nothing useful via
 * `Function.prototype.toString`. Anything shorter than this with no object
 * literal in it is treated as a wrapper and resolved through its defining file
 * instead.
 */
const DELEGATING_WRAPPER_MAX_LENGTH = 200;

const SELF_PRINT_RE = /log\.cli\(/;
const MESSAGE_KEY_RE = /\bmessage\s*[:,]/;
const OUTPUT_KEY_RE = /\boutput\s*[:,]/;
const SUCCESS_KEY_RE = /\bsuccess\s*[:,]/;

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
 * actually registered, with no name-collision risk. It falls down only for
 * delegating wrappers, where the whole implementation lives in a class the
 * closure captures and `toString` cannot reach; there the defining file (the
 * one declaring `id: "<the id>"`) is the next best whole-file approximation,
 * and is marked as such so a reader can weigh it accordingly.
 */
function readCommandSource(
  id: string,
  execute: unknown,
  sources: Map<string, string>
): { text: string; basis: Classification["basis"] } {
  const executeSource = String(execute);
  const isDelegatingWrapper =
    executeSource.length < DELEGATING_WRAPPER_MAX_LENGTH && !executeSource.includes("return {");
  if (!isDelegatingWrapper) {
    return { text: executeSource, basis: "execute-source" };
  }
  for (const [, text] of sources) {
    if (text.includes(`id: "${id}"`)) {
      return { text, basis: "defining-file" };
    }
  }
  return { text: executeSource, basis: "execute-source" };
}

function classify(text: string): Bucket {
  if (SELF_PRINT_RE.test(text)) return "renders-own-report";
  if (MESSAGE_KEY_RE.test(text) || OUTPUT_KEY_RE.test(text)) return "projection";
  if (SUCCESS_KEY_RE.test(text)) return "payload-rendered";
  return "json-dump";
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
    fallthrough.push({
      id: command.id,
      category: String(command.category),
      bucket: classify(text),
      hasJsonFlag: "json" in (command.parameters ?? {}),
      basis,
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
