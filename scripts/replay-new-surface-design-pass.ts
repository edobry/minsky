#!/usr/bin/env bun
/**
 * mt#4124 — replay `new-surface-design-pass` over a REAL transcript.
 *
 * The task's acceptance tests ask for three things this script produces rather
 * than asserts: PR #2942 must FLAG, a small render-path edit must NOT, and the
 * fire rate over recent render-path PRs must be COUNTED before any posture above
 * log-only is proposed. A unit fixture cannot discharge those — a fixture asserts
 * that a fixture agrees with its author, which is the one thing that cannot fail.
 *
 * Both of the guard's inputs are reconstructed from primary sources, never
 * inferred:
 *
 *   - **the skill half** from the transcript, exactly as the live guard reads it
 *     (`Skill` tool_use blocks), bounded to the prefix BEFORE the
 *     `session_pr_create` call so the replay sees what the guard saw;
 *   - **the added-surface half** from the PR's own file list via `gh api`, with
 *     real per-file statuses — not from today's git tree, which has moved.
 *
 * A PR whose file list cannot be fetched is reported **UNKNOWN**, never as a fire
 * or a pass. That distinction is the whole point of the guard's own
 * absent-transcript rule, and a measurement script that blurred it would report a
 * fire rate built partly on missing data.
 *
 * USAGE
 *   bun scripts/replay-new-surface-design-pass.ts <transcript.jsonl> [options]
 *
 *   --list        List the replayable `session_pr_create` calls and exit.
 *   --index <n>   Replay the nth (0-based) call instead of all of them.
 *   --all         Replay every call and print a tally (the default).
 *   --json        Emit the records as JSON for further analysis.
 *   --expect fires|silent
 *                 Exit non-zero unless every replayed call matches. Without it
 *                 the script reports and exits 0.
 *
 * A missing transcript is a SKIP (exit 0), not a failure — transcripts are local
 * harness state and are not present in CI. `gh` being unavailable or unauthed is
 * likewise a SKIP rather than a false measurement.
 *
 * @see .minsky/hooks/new-surface-design-pass.ts — the guard being replayed
 * @see scripts/replay-evidence-provenance.ts — the sibling whose shape this follows
 */
import { existsSync } from "node:fs";
import { parseTranscript, findToolCallsWithResults } from "../.minsky/hooks/transcript";
import type { TranscriptLine } from "../.minsky/hooks/transcript";
import {
  checkNewSurfaceDesignPass,
  extractSkillNames,
} from "../.minsky/hooks/new-surface-design-pass";

const args = process.argv.slice(2);
const transcriptPath = args.find((a) => !a.startsWith("--"));
const wantList = args.includes("--list");
const wantJson = args.includes("--json");
const expectIdx = args.indexOf("--expect");
const expected = expectIdx >= 0 ? args[expectIdx + 1] : undefined;
const indexIdx = args.indexOf("--index");
const onlyIndex = indexIdx >= 0 ? Number(args[indexIdx + 1]) : undefined;

if (!transcriptPath) {
  console.log("USAGE: bun scripts/replay-new-surface-design-pass.ts <transcript.jsonl> [options]");
  process.exit(2);
}
if (!existsSync(transcriptPath)) {
  console.log(`SKIP: transcript not found: ${transcriptPath}`);
  process.exit(0);
}

const lines = parseTranscript(transcriptPath);

/**
 * The `session_pr_create` calls, with the PR number their RESULT reported.
 *
 * Identifying the PR by what the call PRODUCED, rather than by a branch name
 * parsed out of its input, is the same discipline the sibling script's
 * `--commit` selector uses: the result is the fact, the input is the intent.
 */
interface Replayable {
  index: number;
  lineIndex: number;
  prNumber: number | null;
  title: string;
}

function collectReplayables(): Replayable[] {
  const calls = findToolCallsWithResults(lines);
  const out: Replayable[] = [];
  for (const call of calls) {
    if (!call.toolName.includes("session_pr_create")) continue;
    // The PR number comes from what the call RETURNED, not from its input — the
    // result is the fact, the input is the intent. Both spellings the result
    // carries are accepted: the `prNumber` field and the `/pull/<n>` URL.
    const match = /"?(?:prNumber|pull\/)"?[":\s/]*(\d+)/.exec(call.resultText);
    const title = typeof call.input["title"] === "string" ? (call.input["title"] as string) : "";
    out.push({
      index: out.length,
      lineIndex: call.index,
      prNumber: match?.[1] ? Number(match[1]) : null,
      title,
    });
  }
  return out;
}

const replayables = collectReplayables();

if (replayables.length === 0) {
  console.log(`SKIP: no session_pr_create calls in ${transcriptPath}`);
  process.exit(0);
}

if (wantList) {
  for (const r of replayables) {
    console.log(`[${r.index}] PR ${r.prNumber ?? "<unresolved>"} — ${r.title.slice(0, 70)}`);
  }
  process.exit(0);
}

/** A PR's added file paths, from `gh api`. `null` when it cannot be fetched. */
async function fetchAddedFiles(prNumber: number): Promise<string[] | null> {
  const proc = Bun.spawn(
    [
      "gh",
      "api",
      `repos/edobry/minsky/pulls/${prNumber}/files`,
      "--paginate",
      "--jq",
      '.[] | select(.status=="added") | .filename',
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type Verdict = "FIRES" | "SILENT" | "NOT-APPLICABLE" | "UNKNOWN";

interface Record_ {
  index: number;
  prNumber: number | null;
  title: string;
  verdict: Verdict;
  addedSurfaces: string[];
  designSkillsInvoked: string[];
  reason?: string;
}

const records: Record_[] = [];
const targets =
  onlyIndex === undefined ? replayables : replayables.filter((r) => r.index === onlyIndex);

for (const target of targets) {
  // Bound the skill half to the prefix BEFORE the call, so the replay sees what
  // the guard saw. Judging against the whole session would let a design skill
  // invoked AFTER the PR was created discharge the check retroactively.
  const prefix: TranscriptLine[] = lines.slice(0, target.lineIndex);
  const skillNames = extractSkillNames(prefix);

  if (target.prNumber === null) {
    records.push({
      index: target.index,
      prNumber: null,
      title: target.title,
      verdict: "UNKNOWN",
      addedSurfaces: [],
      designSkillsInvoked: skillNames,
      reason: "PR number not resolvable from the call result",
    });
    continue;
  }

  const added = await fetchAddedFiles(target.prNumber);
  if (added === null) {
    records.push({
      index: target.index,
      prNumber: target.prNumber,
      title: target.title,
      verdict: "UNKNOWN",
      addedSurfaces: [],
      designSkillsInvoked: skillNames,
      reason: "gh api could not fetch the file list (unavailable, unauthed, or PR gone)",
    });
    continue;
  }

  const result = checkNewSurfaceDesignPass(added, skillNames);
  const verdict: Verdict = !result.applicable
    ? "NOT-APPLICABLE"
    : result.designSkillsInvoked.length > 0
      ? "SILENT"
      : "FIRES";

  records.push({
    index: target.index,
    prNumber: target.prNumber,
    title: target.title,
    verdict,
    addedSurfaces: result.addedSurfaces,
    designSkillsInvoked: result.designSkillsInvoked,
  });
}

if (wantJson) {
  process.stdout.write(`${JSON.stringify({ transcript: transcriptPath, records }, null, 2)}\n`);
} else {
  for (const r of records) {
    const surfaces = r.addedSurfaces.length > 0 ? ` surfaces=[${r.addedSurfaces.join(", ")}]` : "";
    const skills =
      r.designSkillsInvoked.length > 0 ? ` design=[${r.designSkillsInvoked.join(", ")}]` : "";
    const why = r.reason ? ` (${r.reason})` : "";
    console.log(`[${r.index}] PR ${r.prNumber ?? "?"}: ${r.verdict}${surfaces}${skills}${why}`);
  }
}

const tally = records.reduce<globalThis.Record<string, number>>((acc, r) => {
  acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
  return acc;
}, {});
console.log(
  `\nTally: ${Object.entries(tally)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}`
);

// UNKNOWN is reported separately and never folded into either side. A fire rate
// computed over records that include "could not measure" is not a fire rate.
const measured = records.filter((r) => r.verdict !== "UNKNOWN");
const applicable = measured.filter((r) => r.verdict !== "NOT-APPLICABLE");
if (applicable.length > 0) {
  const fires = applicable.filter((r) => r.verdict === "FIRES").length;
  console.log(
    `Fire rate over APPLICABLE, MEASURED calls: ${fires}/${applicable.length} ` +
      `(${records.length - measured.length} unmeasurable, excluded)`
  );
}

if (expected) {
  const want = expected === "fires" ? "FIRES" : "SILENT";
  const mismatched = records.filter((r) => r.verdict !== want);
  if (mismatched.length > 0) {
    console.error(
      `FAIL: expected every replayed call to be ${want}; ` +
        `${mismatched.length} were not (${mismatched.map((m) => m.verdict).join(", ")})`
    );
    process.exit(1);
  }
}

process.exit(0);
