#!/usr/bin/env bun
/**
 * mt#4309 — the replay sweep behind the negative-control RUN recognizers.
 *
 * `evidence-record-provenance` discharges a `Negative control:` record by
 * joining it against the runs in the writer's own transcript that were observed
 * FAILING. Which calls count as such a run is the question this script measures:
 * it walks every parent and subagent transcript modified in the window, replays
 * every `session_commit` / `session_pr_create` / `session_pr_edit` that carried a
 * control record against the calls that preceded it (the writer's own prefix,
 * per mt#5108), and reports:
 *
 *   - how many distinct control CLAIMS are still undischarged under the current
 *     joins (a claim re-written across commit + PR create + PR edit counts once);
 *   - for each DISCHARGED claim, which recognizer shape produced the red run it
 *     joined against — test runner (`failingTestRuns`), script harness / probe
 *     (`failingHarnessRuns`), or typecheck-shaped (`failingTypecheckRuns`) — so a
 *     widening can be attributed rather than merely counted;
 *   - for each undischarged claim, what the prefix holds instead, so the residue
 *     is classifiable: a runner went red but no join reaches it (mt#4306's
 *     vocabulary class), a read of a log the run wrote (deliberately unrecognized,
 *     see the table module), a green run, or nothing naming the subject.
 *
 * The planning baseline (2026-09-13, `--days 21`, pre-mt#4309 tree): 725 writes,
 * 955 records, 123 distinct undischarged claims. Run on a tree WITHOUT the
 * widened recognizers, the harness/typecheck attribution columns are zero by
 * construction, which is what makes before/after two runs of one script.
 *
 * USAGE
 *   bun scripts/measure-control-recognizer-classes.ts [--days N] [--list]
 *
 *   --days N   window over transcript mtime (default 21)
 *   --list     print one line per discharged-by-new-shape and per undischarged
 *              claim (transcript prefix, record label, the discharging command's
 *              leading words) — the inspection SC2 asks for, without transcript text
 *
 * Emits aggregate counts and short per-claim labels only — never a transcript's
 * text, never a tool result. Transcripts are local harness state, so a missing
 * project directory is a SKIP (exit 0), not a failure.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findToolCallsWithResults, parseTranscript } from "../.minsky/hooks/transcript";
import type { ToolCallWithResult, TranscriptLine } from "../.minsky/hooks/transcript";
import {
  judgeClaims,
  resolveArtifactText,
  workspaceScopeFor,
} from "../.minsky/hooks/evidence-record-provenance";
import { extractNegativeControlRecords } from "../.minsky/hooks/test-first-evidence";
import { safeTruncate } from "../src/utils/safe-truncate";
import * as table from "../.minsky/hooks/evidence-provenance-table";

const {
  callContainsQuotedFailure,
  callMatchesCountClaim,
  callNamesSubject,
  extractBareIdentifiers,
  extractCountClaims,
  extractQuotedFailures,
  extractSubjectTokens,
  failingTestRuns,
  isTestRunningCall,
} = table;

// The three shape recognizers are read off the module namespace with a fallback,
// so the SAME script runs against a tree that predates mt#4309 (the planning
// baseline) and reports zero for the shapes that tree does not have — a named
// import of a missing export would refuse to load instead. This is what makes
// before/after two runs of one script rather than two scripts.
const noRuns = (_calls: readonly ToolCallWithResult[]): ToolCallWithResult[] => [];
const failingHarnessRuns: (calls: readonly ToolCallWithResult[]) => ToolCallWithResult[] =
  (table as Partial<typeof table>).failingHarnessRuns ?? noRuns;
const failingTypecheckRuns: (calls: readonly ToolCallWithResult[]) => ToolCallWithResult[] =
  (table as Partial<typeof table>).failingTypecheckRuns ?? noRuns;
const leadingPrograms: (command: string) => string[] =
  (table as Partial<typeof table>).leadingPrograms ??
  ((command) => command.split(/\s+/).slice(0, 1));

const REPLAYABLE = new Set([
  "mcp__minsky__session_commit",
  "mcp__minsky__session_pr_create",
  "mcp__minsky__session_pr_edit",
]);

/** A test runner's own failure vocabulary, for classifying the residue. */
const RUNNER_RED_RE = /\(fail\)|\b[1-9]\d*\s+fail(?:ed|ing|ures?)?\b|\bFAIL\b|error:\s*expect\(/;
/** A read whose target is a log file — the class the table module deliberately leaves unrecognized. */
const LOG_READ_RE = /\b(?:tail|sed|cat|head|grep)\b[^;&|]*\.log\b/;

interface Options {
  days: number;
  list: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { days: 21, list: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--days") opts.days = Number(argv[++i]);
    else if (flag === "--list") opts.list = true;
    else {
      process.stderr.write(`unknown flag: ${String(flag)}\n`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) {
    process.stderr.write("--days must be a positive number\n");
    process.exit(2);
  }
  return opts;
}

type DischargeShape = "runner" | "runner-widened" | "harness" | "typecheck";

/**
 * The two runner spellings mt#4309 added to `TEST_RUN_COMMAND_RE`, as
 * INVOCATIONS — `bun test …/run-related-tests.test.ts` names the script as a test
 * file argument and is a classic runner, so the script name alone is not the tell.
 */
const WIDENED_RUNNER_RE =
  /\bbun\s+--cwd\s+\S+\s+(?:run\s+)?test\b|\bbun\s+scripts\/run-related-tests/;
type Residue = "runner-red-no-join" | "log-read" | "runner-green" | "nothing";

interface Tally {
  writes: number;
  records: number;
  claims: number;
  discharged: Record<DischargeShape, number>;
  undischarged: number;
  residue: Record<Residue, number>;
}

function freshTally(): Tally {
  return {
    writes: 0,
    records: 0,
    claims: 0,
    discharged: { runner: 0, "runner-widened": 0, harness: 0, typecheck: 0 },
    undischarged: 0,
    residue: { "runner-red-no-join": 0, "log-read": 0, "runner-green": 0, nothing: 0 },
  };
}

/** The joins `judgeClaims` runs, applied to one record against one call. */
function recordJoinsCall(record: string, call: ToolCallWithResult): boolean {
  const tokens = extractSubjectTokens(record);
  return (
    callContainsQuotedFailure(call, extractQuotedFailures(record)) ||
    callNamesSubject(call, tokens) ||
    callMatchesCountClaim(call, extractCountClaims(record)) ||
    callNamesSubject(call, extractBareIdentifiers(record))
  );
}

/**
 * Which recognizer shape produced the red run this record joined against. A
 * runner discharge counts as `runner-widened` only when NO classic-spelled
 * runner also discharges it — the widening is credited with what it alone
 * recovered.
 */
function dischargeShape(record: string, prior: ToolCallWithResult[]): DischargeShape | null {
  const runners = failingTestRuns(prior).filter((c) => recordJoinsCall(record, c));
  if (runners.length > 0) {
    const classic = runners.some((c) => {
      const command = typeof c.input["command"] === "string" ? c.input["command"] : "";
      return !WIDENED_RUNNER_RE.test(command);
    });
    return classic ? "runner" : "runner-widened";
  }
  if (failingHarnessRuns(prior).some((c) => recordJoinsCall(record, c))) return "harness";
  if (failingTypecheckRuns(prior).some((c) => recordJoinsCall(record, c))) return "typecheck";
  return null;
}

/** What an UNDISCHARGED record's prefix holds, so the residue is classifiable. */
function residueOf(record: string, prior: ToolCallWithResult[]): Residue {
  const tokens = [...extractSubjectTokens(record), ...extractBareIdentifiers(record)];
  const names = (c: ToolCallWithResult) => callNamesSubject(c, tokens);
  // The most specific reason first: a log read naming the subject with a red
  // runner line in it is the deliberately-unrecognized class, and it should not
  // be hidden behind an unrelated red runner elsewhere in the prefix.
  if (
    prior.some((c) => {
      const command = typeof c.input["command"] === "string" ? c.input["command"] : "";
      return LOG_READ_RE.test(command) && RUNNER_RED_RE.test(c.resultText) && names(c);
    })
  )
    return "log-read";
  if (prior.some((c) => isTestRunningCall(c) && RUNNER_RED_RE.test(c.resultText)))
    return "runner-red-no-join";
  if (prior.some((c) => isTestRunningCall(c) && names(c))) return "runner-green";
  return "nothing";
}

function commandHead(call: ToolCallWithResult | undefined): string {
  if (!call) return "";
  const command = typeof call.input["command"] === "string" ? call.input["command"] : "";
  return `${leadingPrograms(command).slice(0, 3).join(" · ")} :: ${safeTruncate(command.replace(/\s+/g, " "), 80, "head")}`;
}

function walk(
  lines: TranscriptLine[],
  label: string,
  tally: Tally,
  seen: Set<string>,
  opts: Options
): void {
  const calls = findToolCallsWithResults(lines);
  for (const c of calls) {
    if (!REPLAYABLE.has(c.toolName)) continue;
    const text = resolveArtifactText(c.input);
    if (text === null) continue;
    const records = extractNegativeControlRecords(text);
    if (records.length === 0) continue;
    tally.writes++;
    const cwd = (lines[c.index] as { cwd?: unknown })?.cwd;
    const prior = findToolCallsWithResults(lines.slice(0, c.index));
    const verdicts = judgeClaims(
      text,
      prior,
      workspaceScopeFor(typeof cwd === "string" ? cwd : undefined)
    ).filter((v) => v.kind === "negative-control");
    verdicts.forEach((v, i) => {
      tally.records++;
      const record = records[i];
      if (!record) return;
      const key = `${label}|${record.label.slice(0, 80)}`;
      if (seen.has(key)) return;
      seen.add(key);
      tally.claims++;
      const full = `${record.label}\n${record.body}`;
      const short = safeTruncate(record.label.replace(/\s+/g, " "), 56, "head");
      if (v.verdict === "discharged") {
        const shape = dischargeShape(full, prior) ?? "runner";
        tally.discharged[shape]++;
        if (opts.list && shape !== "runner") {
          const via =
            shape === "harness"
              ? failingHarnessRuns(prior).find((x) => recordJoinsCall(full, x))
              : shape === "typecheck"
                ? failingTypecheckRuns(prior).find((x) => recordJoinsCall(full, x))
                : failingTestRuns(prior).find((x) => recordJoinsCall(full, x));
          process.stdout.write(
            `  discharged/${shape.padEnd(14)} ${label} :: ${short} :: ${commandHead(via)}\n`
          );
        }
        return;
      }
      if (v.verdict !== "undischarged") return;
      tally.undischarged++;
      const residue = residueOf(full, prior);
      tally.residue[residue]++;
      if (opts.list)
        process.stdout.write(`  undischarged/${residue.padEnd(18)} ${label} :: ${short}\n`);
    });
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const projectDir = join(homedir(), ".claude", "projects", "-Users-edobry-Projects-minsky");
  if (!existsSync(projectDir)) {
    process.stdout.write(`SKIP: no transcripts at ${projectDir}\n`);
    process.exit(0);
  }
  const since = Date.now() - opts.days * 86_400_000;
  const tally = freshTally();
  const seen = new Set<string>();
  let transcripts = 0;

  for (const entry of readdirSync(projectDir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const parentPath = join(projectDir, entry);
    if (statSync(parentPath).mtimeMs >= since) {
      transcripts++;
      walk(parseTranscript(parentPath), entry.slice(0, 8), tally, seen, opts);
    }
    const subagentsDir = join(projectDir, entry.slice(0, -".jsonl".length), "subagents");
    if (!existsSync(subagentsDir)) continue;
    for (const file of readdirSync(subagentsDir)) {
      if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) continue;
      const agentPath = join(subagentsDir, file);
      if (statSync(agentPath).mtimeMs < since) continue;
      transcripts++;
      walk(
        parseTranscript(agentPath),
        `${entry.slice(0, 8)}/${file.slice(6, 14)}`,
        tally,
        seen,
        opts
      );
    }
  }

  const d = tally.discharged;
  process.stdout.write(
    `window=${opts.days}d transcripts=${transcripts} writes-with-control=${tally.writes} ` +
      `records=${tally.records} distinct-claims=${tally.claims}\n` +
      `  discharged: runner=${d.runner} runner-widened=${d["runner-widened"]} harness=${d.harness} typecheck=${d.typecheck}\n` +
      `  undischarged: ${tally.undischarged}` +
      ` (runner-red-no-join=${tally.residue["runner-red-no-join"]} log-read=${tally.residue["log-read"]}` +
      ` runner-green=${tally.residue["runner-green"]} nothing=${tally.residue.nothing})\n`
  );
}

main();
