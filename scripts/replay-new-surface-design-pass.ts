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
  specDeclaresVisualJudgment,
} from "../.minsky/hooks/new-surface-design-pass";
import { isRenderPathFile } from "../.minsky/hooks/render-path-evidence";

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
  /** The bound task id from the call params — what the live guard reads. */
  taskId: string | null;
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
    // The bound task comes from the call's `task` PARAM, which is what the live
    // guard reads (`taskIdFromInput`). Deriving it from the title instead
    // silently yields null on every real PR, because `session_pr_create` titles
    // are description-only by convention — the `fix(mt#NNNN):` prefix is added by
    // the tool afterwards. That mistake made the first mt#4356 replay report
    // NOT-APPLICABLE for two PRs that the live guard fires on: a zero produced by
    // the harness, indistinguishable from a clean corpus.
    const taskId = typeof call.input["task"] === "string" ? (call.input["task"] as string) : null;
    out.push({
      index: out.length,
      lineIndex: call.index,
      prNumber: match?.[1] ? Number(match[1]) : null,
      title,
      taskId,
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

/**
 * A PR's added AND modified file paths, from `gh api`. `null` when unfetchable.
 *
 * Both statuses since mt#4356: the guard now has two triggers and they read
 * different halves of the diff, so a replay that fetched only `added` could
 * measure trigger 1 and would report trigger 2 as universally silent — a zero
 * produced by the harness rather than by the corpus.
 */
async function fetchTouchedFiles(
  prNumber: number
): Promise<{ added: string[]; modified: string[] } | null> {
  const proc = Bun.spawn(
    [
      "gh",
      "api",
      `repos/edobry/minsky/pulls/${prNumber}/files`,
      "--paginate",
      "--jq",
      '.[] | select(.status=="added" or .status=="modified") | "\\(.status)\\t\\(.filename)"',
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  const added: string[] = [];
  const modified: string[] = [];
  for (const line of out.split("\n")) {
    const [status, filename] = line.split("\t");
    if (!filename) continue;
    if (status === "added") added.push(filename.trim());
    else if (status === "modified") modified.push(filename.trim());
  }
  return { added, modified };
}

/**
 * The bound task's spec markdown, via the `minsky` CLI. `null` when unavailable.
 *
 * Mirrors the guard's own fetch, including its failure direction: an unreadable
 * spec yields `null`, the caller treats that as "not visual", and trigger 2
 * cannot fire on it. A replay that guessed otherwise would report fires the live
 * guard would not produce.
 */
async function fetchSpec(taskId: string): Promise<string | null> {
  const proc = Bun.spawn(["minsky", "tasks", "spec", "get", taskId, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  try {
    const parsed = JSON.parse(out) as { content?: unknown };
    return typeof parsed.content === "string" ? parsed.content : null;
  } catch {
    return null;
  }
}

/** `fix(mt#4251): …` / `task/mt-4251` → `mt#4251`. Null when the title names none. */
export function taskIdFromTitle(title: string): string | null {
  const m = /\bmt#(\d+)\b/.exec(title) ?? /\bmt-(\d+)\b/.exec(title);
  return m?.[1] ? `mt#${m[1]}` : null;
}

type Verdict = "FIRES" | "SILENT" | "NOT-APPLICABLE" | "UNKNOWN";

interface Record_ {
  index: number;
  prNumber: number | null;
  title: string;
  verdict: Verdict;
  /** Which trigger applied — reported per record so the two rates can be split. */
  trigger: string | null;
  surfaces: string[];
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
      trigger: null,
      surfaces: [],
      designSkillsInvoked: skillNames,
      reason: "PR number not resolvable from the call result",
    });
    continue;
  }

  const touched = await fetchTouchedFiles(target.prNumber);
  if (touched === null) {
    records.push({
      index: target.index,
      prNumber: target.prNumber,
      title: target.title,
      verdict: "UNKNOWN",
      trigger: null,
      surfaces: [],
      designSkillsInvoked: skillNames,
      reason: "gh api could not fetch the file list (unavailable, unauthed, or PR gone)",
    });
    continue;
  }

  // Fetched only when it can change the answer, mirroring the guard's own
  // ordering — and so a corpus run does not issue one CLI call per PR for
  // nothing.
  const needsSpec =
    touched.added.filter((f) => isRenderPathFile(f)).length === 0 &&
    touched.modified.some((f) => isRenderPathFile(f));
  const taskId = needsSpec ? (target.taskId ?? taskIdFromTitle(target.title)) : null;
  const spec = taskId ? await fetchSpec(taskId) : null;
  const specIsVisual = spec !== null && specDeclaresVisualJudgment(spec);

  const result = checkNewSurfaceDesignPass(
    touched.added,
    touched.modified,
    skillNames,
    specIsVisual
  );
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
    trigger: result.trigger,
    surfaces: result.surfaces,
    designSkillsInvoked: result.designSkillsInvoked,
  });
}

if (wantJson) {
  process.stdout.write(`${JSON.stringify({ transcript: transcriptPath, records }, null, 2)}\n`);
} else {
  for (const r of records) {
    const surfaces = r.surfaces.length > 0 ? ` surfaces=[${r.surfaces.join(", ")}]` : "";
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
