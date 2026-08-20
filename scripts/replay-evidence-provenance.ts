#!/usr/bin/env bun
/**
 * mt#4044 — replay `evidence-record-provenance` over a REAL transcript.
 *
 * The task's fourth acceptance test says the check must be OBSERVED firing on
 * mt#4024's commit `98e2ac5fd`, not asserted to fire. A unit fixture cannot
 * discharge that: a fixture asserts that a fixture agrees with the author, which
 * is the one thing that cannot fail. This script reconstructs the guard's actual
 * inputs from a recorded conversation — the artifact text the tool was called
 * with, and the tool calls that had already happened at that moment — and reports
 * the verdict the live guard would have reached.
 *
 * It is also the general form: any `session_commit` / `session_pr_create` /
 * `session_pr_edit` call in any transcript can be replayed, which is how the
 * calibration window's fires get re-judged after a matcher change.
 *
 * USAGE
 *   bun scripts/replay-evidence-provenance.ts <transcript.jsonl> [options]
 *
 *   --commit <sha>      Replay the session_commit whose RESULT carried this
 *                       commitHash (prefix match). The honest target selector:
 *                       it identifies the call by what it produced.
 *   --index <n>         Replay the nth (0-based) matching tool call instead.
 *   --list              List the replayable calls and exit.
 *   --all               Replay EVERY replayable call and print a tally. This is
 *                       the false-positive sweep: the fire RATE over real
 *                       history is the number that decides whether a
 *                       calibration-first guard graduates, and it cannot be
 *                       estimated from the cases the author thought of.
 *   --as-of-line <n>    Judge the target's text against the transcript prefix up
 *                       to line n instead of the call's own position. The
 *                       counterfactual knob: "what would the guard have said had
 *                       this been written later?" A check that fires on the real
 *                       ordering and STILL fires against the whole session is not
 *                       discriminating on order — it is just firing.
 *   --expect fires|silent
 *                       Exit non-zero unless the verdict matches. Without it the
 *                       script reports and exits 0.
 *
 * A missing transcript file is a SKIP (exit 0), not a failure — transcripts are
 * local harness state and are not present in CI.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseTranscript, findToolCallsWithResults } from "../.minsky/hooks/transcript";
import type { TranscriptLine } from "../.minsky/hooks/transcript";
import { judgeClaims, resolveArtifactText } from "../.minsky/hooks/evidence-record-provenance";
import type { ClaimVerdict } from "../.minsky/hooks/evidence-record-provenance";

/** The tools whose input carries an evidence record — the guard's own matcher. */
const REPLAYABLE = new Set([
  "mcp__minsky__session_commit",
  "mcp__minsky__session_pr_create",
  "mcp__minsky__session_pr_edit",
]);

interface Options {
  transcript: string;
  commit?: string;
  index?: number;
  list: boolean;
  all: boolean;
  asOfLine?: number;
  expect?: "fires" | "silent";
}

function parseArgs(argv: string[]): Options {
  const [transcript, ...rest] = argv;
  if (!transcript) {
    process.stderr.write("usage: replay-evidence-provenance.ts <transcript.jsonl> [options]\n");
    process.exit(2);
  }
  const opts: Options = { transcript, list: false, all: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--list") opts.list = true;
    else if (flag === "--all") opts.all = true;
    else if (flag === "--commit") opts.commit = rest[++i];
    else if (flag === "--index") opts.index = Number(rest[++i]);
    else if (flag === "--as-of-line") opts.asOfLine = Number(rest[++i]);
    else if (flag === "--expect") {
      const value = rest[++i];
      if (value !== "fires" && value !== "silent") {
        process.stderr.write(`--expect takes "fires" or "silent", got ${String(value)}\n`);
        process.exit(2);
      }
      opts.expect = value;
    } else {
      process.stderr.write(`unknown flag: ${String(flag)}\n`);
      process.exit(2);
    }
  }
  return opts;
}

/**
 * Every replayable call, with the transcript PREFIX that preceded it.
 *
 * The prefix is what makes this a replay rather than a re-judgement. At
 * PreToolUse the transcript holds exactly the calls that already happened, so
 * slicing at the call's own line index reproduces the guard's view — and it is
 * the whole reason the mt#4024 verdict differs from what the completed
 * transcript would say: the control's failing run is at a LATER index than the
 * commit that claimed it.
 */
function replayableCalls(
  lines: TranscriptLine[]
): Array<{ index: number; lineIndex: number; toolName: string; text: string | null; sha: string }> {
  const calls = findToolCallsWithResults(lines);
  const out: Array<{
    index: number;
    lineIndex: number;
    toolName: string;
    text: string | null;
    sha: string;
  }> = [];
  for (const c of calls) {
    if (!REPLAYABLE.has(c.toolName)) continue;
    // The sha the call actually produced, read off its own result rather than
    // guessed from the message — a commit message is not unique across amends.
    const sha = /"(?:commitHash|shortHash)":\s*"([0-9a-f]+)"/.exec(c.resultText)?.[1] ?? "";
    out.push({
      index: out.length,
      lineIndex: c.index,
      toolName: c.toolName,
      text: resolveArtifactText(c.input),
      sha,
    });
  }
  return out;
}

function describeVerdicts(verdicts: ClaimVerdict[]): string {
  if (verdicts.length === 0) return "    (no evidence record in this text)\n";
  return verdicts
    .map(
      (v) =>
        `    ${v.verdict.toUpperCase().padEnd(14)} ${v.kind}${v.check ? `/${v.check}` : ""}` +
        // The ordering axis is rendered beside the discharge one (mt#4236): a
        // DISCHARGED record with `stale-evidence` is the finding this script has
        // to be able to SHOW, since the task's replay criterion is discharged by
        // reading its output.
        `  ordering=${v.ordering}${v.detail ? `  (${v.detail})` : ""}` +
        `${v.tokens.length > 0 ? `  subject: ${v.tokens.slice(0, 4).join(" | ")}` : ""}`
    )
    .join("\n")
    .concat("\n");
}

const opts = parseArgs(process.argv.slice(2));

if (!existsSync(opts.transcript)) {
  process.stdout.write(`SKIP: transcript not found: ${opts.transcript}\n`);
  process.exit(0);
}

// `parseTranscript` reads the path itself; the readFileSync here is only to fail
// loudly on an unreadable file rather than on an empty parse.
readFileSync(opts.transcript, "utf8");
const lines = parseTranscript(opts.transcript);
const candidates = replayableCalls(lines);

if (candidates.length === 0) {
  process.stdout.write(`SKIP: no session_commit / session_pr_* calls in ${opts.transcript}\n`);
  process.exit(0);
}

if (opts.list) {
  process.stdout.write(`${candidates.length} replayable call(s) in ${opts.transcript}:\n`);
  for (const c of candidates) {
    const subject = (c.text ?? "").split("\n")[0]?.slice(0, 68) ?? "(no text)";
    process.stdout.write(
      `  [${String(c.index).padStart(2)}] line ${String(c.lineIndex).padStart(5)}  ` +
        `${(c.sha || "-").padEnd(10)} ${subject}\n`
    );
  }
  process.exit(0);
}

if (opts.all) {
  // Per-outcome, not just fired/not: `unadjudicable` is the population a future
  // widening would target, and folding it into either bucket hides it.
  // `stale` is counted SEPARATELY from `fired` and NOT folded into `discharged`
  // (mt#4236): it is a discharged record with a real run behind it, so counting
  // it as a discharge would hide exactly the population this sweep now exists to
  // size, and counting it as a fire would merge it with "no run happened".
  const tally = { records: 0, fired: 0, discharged: 0, stale: 0, unadjudicable: 0, noRecord: 0 };
  for (const c of candidates) {
    if (c.text === null) continue;
    const priorCalls = findToolCallsWithResults(lines.slice(0, c.lineIndex));
    const verdicts = judgeClaims(c.text, priorCalls);
    if (verdicts.length === 0) {
      tally.noRecord++;
      continue;
    }
    tally.records += verdicts.length;
    for (const v of verdicts) {
      if (v.ordering === "stale-evidence") tally.stale++;
      if (v.verdict === "undischarged") tally.fired++;
      else if (v.verdict === "discharged") tally.discharged++;
      else tally.unadjudicable++;
    }
    process.stdout.write(
      `  [${String(c.index).padStart(2)}] ${(c.sha || "-").padEnd(10)} ` +
        `${verdicts
          .map(
            (v) =>
              `${v.kind}${v.check ? `/${v.check}` : ""}=${v.verdict}` +
              `${v.ordering === "stale-evidence" ? "(stale)" : ""}`
          )
          .join(" ")}\n`
    );
  }
  process.stdout.write(
    `${opts.transcript}\n  calls=${candidates.length} with-record=${
      candidates.length - tally.noRecord
    } records=${tally.records} fired=${tally.fired} discharged=${tally.discharged} ` +
      `stale=${tally.stale} unadjudicable=${tally.unadjudicable}\n`
  );
  process.exit(0);
}

const target = opts.commit
  ? candidates.find((c) => c.sha.startsWith(opts.commit as string))
  : candidates[opts.index ?? candidates.length - 1];

if (!target) {
  process.stderr.write(
    `FAIL: no replayable call matched ${
      opts.commit ? `--commit ${opts.commit}` : `--index ${String(opts.index)}`
    }. Run with --list.\n`
  );
  process.exit(1);
}

if (target.text === null) {
  process.stdout.write(`SKIP: call [${target.index}] carried no readable artifact text\n`);
  process.exit(0);
}

// The guard's view: only what had already happened.
const cutoff = opts.asOfLine ?? target.lineIndex;
const priorCalls = findToolCallsWithResults(lines.slice(0, cutoff));
const verdicts = judgeClaims(target.text, priorCalls);
// Mirrors `run()`'s own outcome rule, including the mt#4236 stale class — a
// replay that reported SILENT where the live guard records `matched` would be a
// probe measuring a different thing than the mechanism it stands in for.
const undischarged = verdicts.filter((v) => v.verdict === "undischarged");
const staleVerdicts = verdicts.filter((v) => v.ordering === "stale-evidence");
const fires = undischarged.length > 0 || staleVerdicts.length > 0;

process.stdout.write(
  `transcript : ${opts.transcript}\n` +
    `call       : [${target.index}] ${target.toolName}${target.sha ? ` -> ${target.sha}` : ""}\n` +
    `prior calls: ${priorCalls.length} (of ${findToolCallsWithResults(lines).length} in the session)` +
    `${opts.asOfLine === undefined ? "" : ` — counterfactual, as of line ${cutoff}`}\n` +
    `subject    : ${(target.text.split("\n")[0] ?? "").slice(0, 72)}\n` +
    `verdicts   :\n${describeVerdicts(verdicts)}` +
    `RESULT     : ${fires ? "FIRES" : "SILENT"}\n`
);

if (opts.expect && (opts.expect === "fires") !== fires) {
  process.stderr.write(`FAIL: expected ${opts.expect}, got ${fires ? "fires" : "silent"}\n`);
  process.exit(1);
}
process.exit(0);
