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
 *     (`failingHarnessRuns`), typecheck-shaped (`failingTypecheckRuns`), or a
 *     detached run read back through its own log (`failingLogReads`, mt#5140) —
 *     so a widening can be attributed rather than merely counted;
 *   - for each undischarged claim, what the prefix holds instead, so the residue
 *     is classifiable: a runner went red but no join reaches it (mt#4306's
 *     vocabulary class), a read of a log no in-transcript run redirected into
 *     (the CI-log half mt#5140 leaves unrecognized, or a paired read that joins
 *     nothing), a green run, or nothing naming the subject.
 *
 * The planning baseline (2026-09-13, `--days 21`, pre-mt#4309 tree): 725 writes,
 * 955 records, 123 distinct undischarged claims. Run on a tree WITHOUT the
 * widened recognizers, the harness/typecheck/log-read attribution columns are
 * zero by construction, which is what makes before/after two runs of one script.
 *
 * USAGE
 *   bun scripts/measure-control-recognizer-classes.ts [--days N] [--list]
 *
 *   --days N   window over transcript mtime (default 21)
 *   --list     print one line per discharged-by-new-shape and per undischarged
 *              claim (transcript prefix, record label, the discharging command's
 *              leading words — for a log-read discharge, the RUN's and the READ's
 *              separately) — the inspection SC2 asks for, without transcript text
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
// mt#5140's shape, read the same way so the pre-mt#5140 tree reports zero for it.
const failingLogReads: (calls: readonly ToolCallWithResult[]) => ToolCallWithResult[] =
  (table as Partial<typeof table>).failingLogReads ?? noRuns;
const logReadsOfRedirectedRuns: (calls: readonly ToolCallWithResult[]) => table.LogReadPair[] =
  (table as Partial<typeof table>).logReadsOfRedirectedRuns ?? (() => []);
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
/** The programs a log is read back through, and an operand that names a log file. */
const LOG_READ_PROGRAM_RE = /^(?:tail|sed|cat|head|grep|rg|awk|less|more)$/;
const LOG_OPERAND_RE = /(?:^|[\s"'])[^\s"']+\.log(?:[\s"']|$)/;

/**
 * A read whose operand is a log file. Judged per statement by LEADING PROGRAM
 * plus operand, not by a single regex over the command: the mt#5131 instance is
 * `grep -E '^\(fail\)|…' …/negctl.log | head -30`, and the `[^;&|]*` gap the
 * previous pattern used could not cross the `|` inside the grep's own pattern
 * argument, so the one live instance of this class was filed under
 * `runner-red-no-join` (planning, 2026-09-14).
 */
function isLogReadCommand(command: string): boolean {
  return command.split(/\s*(?:&&|\|\||;|\n)\s*/).some((statement) => {
    const program = leadingPrograms(statement)[0] ?? "";
    return LOG_READ_PROGRAM_RE.test(program) && LOG_OPERAND_RE.test(statement);
  });
}

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

type DischargeShape = "runner" | "runner-widened" | "harness" | "typecheck" | "log-read";

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
    discharged: { runner: 0, "runner-widened": 0, harness: 0, typecheck: 0, "log-read": 0 },
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
  if (failingLogReads(prior).some((c) => recordJoinsCall(record, c))) return "log-read";
  return null;
}

/**
 * For a log-read discharge, the pair behind the synthesized call: the run that
 * redirected and the read that displayed, so `--list` can name both.
 */
function logReadPairFor(
  record: string,
  prior: ToolCallWithResult[]
): table.LogReadPair | undefined {
  const via = failingLogReads(prior).find((c) => recordJoinsCall(record, c));
  if (!via) return undefined;
  return logReadsOfRedirectedRuns(prior).find((p) => p.read.index === via.index);
}

/** What an UNDISCHARGED record's prefix holds, so the residue is classifiable. */
function residueOf(record: string, prior: ToolCallWithResult[]): Residue {
  const tokens = [...extractSubjectTokens(record), ...extractBareIdentifiers(record)];
  const names = (c: ToolCallWithResult) => callNamesSubject(c, tokens);
  // The most specific reason first: a log read naming the subject with a red
  // runner line in it is the class mt#5140 recognizes only when an earlier run
  // in the transcript redirected into that file — so what remains here is the
  // CI-log half, or a paired read whose output joins nothing — and it should
  // not be hidden behind an unrelated red runner elsewhere in the prefix.
  if (
    prior.some((c) => {
      const command = typeof c.input["command"] === "string" ? c.input["command"] : "";
      return isLogReadCommand(command) && RUNNER_RED_RE.test(c.resultText) && names(c);
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

/**
 * One distinct claim's outcome across every write that carried it. A claim is
 * `discharged` if ANY of its writes is — the LAST write is judged against the
 * fullest prefix, and this script measures whether the transcript holds a run
 * the joins can see, not whether the first write pre-narrated it (that is the
 * `pre-narration` detector's axis). Until mt#5140 the first write's verdict
 * stood for the claim, which mis-filed the live mt#5131 instance: its first
 * `session_pr_create` replays a `bodyPath` re-read from disk — a body that a
 * later perl edit gave the control — against a prefix in which the control had
 * not yet run, and the `session_pr_edit` that actually carried it was skipped
 * as a duplicate.
 */
interface ClaimOutcome {
  verdict: "discharged" | "undischarged" | "unadjudicable";
  shape: DischargeShape | null;
  residue: Residue | null;
  /** The `--list` line, rendered when the outcome was decided. */
  line: string;
}

function walk(
  lines: TranscriptLine[],
  label: string,
  tally: Tally,
  claims: Map<string, ClaimOutcome>
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
      const previous = claims.get(key);
      // A discharge is sticky. An undischarged claim is re-judged by every later
      // write, so its residue describes the FULLEST prefix that still failed to
      // discharge it — the first write's prefix may predate the read entirely.
      if (previous && (previous.verdict !== "undischarged" || v.verdict === "unadjudicable"))
        return;
      const full = `${record.label}\n${record.body}`;
      const short = safeTruncate(record.label.replace(/\s+/g, " "), 56, "head");
      if (v.verdict === "discharged") {
        const shape = dischargeShape(full, prior) ?? "runner";
        let line = "";
        if (shape === "log-read") {
          const pair = logReadPairFor(full, prior);
          line = `  discharged/${shape.padEnd(14)} ${label} :: ${short} :: run ${commandHead(pair?.run)} :: read ${commandHead(pair?.read)}\n`;
        } else if (shape !== "runner") {
          const via =
            shape === "harness"
              ? failingHarnessRuns(prior).find((x) => recordJoinsCall(full, x))
              : shape === "typecheck"
                ? failingTypecheckRuns(prior).find((x) => recordJoinsCall(full, x))
                : failingTestRuns(prior).find((x) => recordJoinsCall(full, x));
          line = `  discharged/${shape.padEnd(14)} ${label} :: ${short} :: ${commandHead(via)}\n`;
        }
        claims.set(key, { verdict: "discharged", shape, residue: null, line });
        return;
      }
      if (v.verdict !== "undischarged") {
        claims.set(key, { verdict: "unadjudicable", shape: null, residue: null, line: "" });
        return;
      }
      const residue = residueOf(full, prior);
      claims.set(key, {
        verdict: "undischarged",
        shape: null,
        residue,
        line: `  undischarged/${residue.padEnd(18)} ${label} :: ${short}\n`,
      });
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
  const claims = new Map<string, ClaimOutcome>();
  let transcripts = 0;

  for (const entry of readdirSync(projectDir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const parentPath = join(projectDir, entry);
    if (statSync(parentPath).mtimeMs >= since) {
      transcripts++;
      walk(parseTranscript(parentPath), entry.slice(0, 8), tally, claims);
    }
    const subagentsDir = join(projectDir, entry.slice(0, -".jsonl".length), "subagents");
    if (!existsSync(subagentsDir)) continue;
    for (const file of readdirSync(subagentsDir)) {
      if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) continue;
      const agentPath = join(subagentsDir, file);
      if (statSync(agentPath).mtimeMs < since) continue;
      transcripts++;
      walk(parseTranscript(agentPath), `${entry.slice(0, 8)}/${file.slice(6, 14)}`, tally, claims);
    }
  }

  // Tally once every write has had its say, so a claim's outcome is its best one.
  for (const outcome of claims.values()) {
    tally.claims++;
    if (outcome.verdict === "discharged" && outcome.shape) tally.discharged[outcome.shape]++;
    if (outcome.verdict === "undischarged" && outcome.residue) {
      tally.undischarged++;
      tally.residue[outcome.residue]++;
    }
    if (opts.list && outcome.line) process.stdout.write(outcome.line);
  }

  const d = tally.discharged;
  process.stdout.write(
    `window=${opts.days}d transcripts=${transcripts} writes-with-control=${tally.writes} ` +
      `records=${tally.records} distinct-claims=${tally.claims}\n` +
      `  discharged: runner=${d.runner} runner-widened=${d["runner-widened"]} harness=${d.harness} typecheck=${d.typecheck} log-read=${d["log-read"]}\n` +
      `  undischarged: ${tally.undischarged}` +
      ` (runner-red-no-join=${tally.residue["runner-red-no-join"]} log-read=${tally.residue["log-read"]}` +
      ` runner-green=${tally.residue["runner-green"]} nothing=${tally.residue.nothing})\n`
  );
}

main();
