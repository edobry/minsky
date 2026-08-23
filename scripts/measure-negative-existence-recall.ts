#!/usr/bin/env bun
/**
 * mt#4162 — measure `negative-existence-claim`'s claim-SHAPE recall-miss rate
 * against ADR-024 §(b), so the rung is chosen on a rate rather than on two
 * anecdotes.
 *
 * ## Why this cannot read the evaluation stream alone
 *
 * `.minsky/negative-existence-claim-evaluations.jsonl` records one row per
 * evaluated turn, but its fields are counts and flags — `claimPresent`,
 * `thinSearchPresent`, `proseChars`, `session_id` — and **no text**. The
 * question this task asks is "does a `claimPresent: false` turn actually carry
 * a negative-existence claim the corpus missed?", and that is unanswerable from
 * a row that records only the matcher's verdict. A claim-shape miss is
 * invisible to the matcher that missed it.
 *
 * So the judged input is RECONSTRUCTED: the turn is recovered from the local
 * transcript store and re-run through the detector's own `evaluateTurn`.
 *
 * ## The join is checkable, and checked
 *
 * `evaluateTurn` returns the same evaluation record the hook wrote, so a
 * recovered turn can be compared to its stored row FIELD BY FIELD —
 * `proseChars` is an exact integer and `claimPresent` a boolean with both
 * values well represented in the corpus. `--validate` reports that agreement
 * over BOTH strata before any rate is computed.
 *
 * That ordering is the point. mt#4085's first recovery agreed with its
 * detector on 68.8% of records while producing a perfectly plausible-looking
 * percentage; a rate computed on an unvalidated recovery is not evidence
 * (mem#704).
 *
 * ## What leaves this machine
 *
 * Enumerated per channel rather than summarised, because a data-flow claim
 * scoped to the one channel its author was designing is the failure
 * `claim-confidence.mdc` records for mem#1056:
 *
 * - **stdout** — counts, rates, ISO timestamps and session ids. No prose.
 * - **files written** — none, EXCEPT the path given to `--dump`, which is the
 *   whole point of that flag: it writes recovered artifact prose locally so a
 *   human can label it. Nothing writes without that flag.
 * - **the network** — nothing. This script opens no socket on any path. It
 *   performs no embedding and no upload; if a later rung decision introduces
 *   one, that is an egress over operator data and must be GATED, not described.
 * - **subprocess argv** — none. It spawns nothing.
 *
 * Usage:
 *   bun scripts/measure-negative-existence-recall.ts --validate --until <iso>
 *   bun scripts/measure-negative-existence-recall.ts --until <iso> --dump labels.todo.json
 *   bun scripts/measure-negative-existence-recall.ts --until <iso> --labels labels.json
 *
 * Exit 0 when it completes, including a clean SKIP when the transcript store is
 * absent (CI has none).
 *
 * @see mt#4126 — the same measurement for `causal-premise`; this follows its
 *      method (pinned window, label enum, `--labels` JSON) but cannot share its
 *      harness, because its stream carries an excerpt and this one does not.
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { evaluateTurn } from "../.minsky/hooks/negative-existence-claim-detector";
import {
  buildArtifactProseCorpus,
  elideBlocksAndQuotes,
} from "../.minsky/hooks/code-mechanism-assertion-detector";
import {
  parseTranscript,
  findRealPromptIndices,
  type TranscriptLine,
} from "../.minsky/hooks/transcript";

const REPO_ROOT = join(import.meta.dir, "..");
const DEFAULT_LOG = ".minsky/negative-existence-claim-evaluations.jsonl";
const ARGV = process.argv.slice(2);

function flag(name: string): string | undefined {
  const at = ARGV.indexOf(name);
  const value = at >= 0 ? ARGV[at + 1] : undefined;
  return value !== undefined && value !== "" ? value : undefined;
}

const LOG_PATH = resolve(REPO_ROOT, flag("--log") ?? DEFAULT_LOG);
const UNTIL = flag("--until");

/**
 * How a hand-classified `claimPresent: false` record was judged.
 *
 * Deliberately the same shape as mt#4126's `Label`, including `indeterminate`:
 * a labeler who cannot settle a record must be able to say so rather than be
 * forced into a bucket, or the rate absorbs the labeler's uncertainty silently.
 */
/**
 * The labeling pass's candidate predicate, deliberately WIDER than
 * `NEGATIVE_EXISTENCE_PATTERNS`.
 *
 * It proposes sentences for judgment; it does not decide. A sentence is counted
 * only after the SHIPPED `extractNegativeExistenceClaims` is confirmed to return
 * zero claims for it, so this can never mark something the detector already
 * catches.
 *
 * Exported and tested rather than left as an ad-hoc regex in a scratch file,
 * because SC1 requires the labeling METHOD to be recorded and SC3 requires a
 * fixture to be verified against it (PR #3053 R2). A method that exists only in
 * the labeler's shell is not recorded.
 *
 * **Its recall bound, stated:** a claim carrying none of these tokens is
 * invisible to this predicate exactly as it is to the detector, which is why the
 * reported rate is a LOWER bound. `RECURRENCE_B` below is precisely that case.
 */
export const LABELING_CANDIDATE_RE =
  /\b(never (?:committed|reads?|reached?|ran|runs?|fires?|executes?)|is absent|are absent|has no|have no|there (?:is|are|was|were) no|does not (?:import|exist|touch)|no such|nothing (?:for|handles|matches))\b/i;

/** Does the labeling pass propose this sentence as a candidate miss? */
export function isCandidateMiss(sentence: string): boolean {
  return LABELING_CANDIDATE_RE.test(sentence) && sentence.length > 30;
}

/**
 * mt#4121's two recorded recurrences, verbatim, pinned as fixtures (SC3).
 *
 * They are NOT symmetric, and the asymmetry is the finding rather than a gap in
 * the measurement:
 *
 * - **A** is a negative-existence claim in the simple past. The corpus's
 *   `never`-family pattern is present-tense only, so it misses — and the
 *   labeling predicate proposes it, which is what makes it a usable fixture.
 * - **B** asserts a mechanism is PRESENT. It is a derived-view failure but not a
 *   negative-existence claim at all, so no negation-keyed corpus can reach it
 *   and neither can the labeling predicate. It is pinned as a NEGATIVE fixture:
 *   the thing this detector is not the mechanism for.
 */
export const RECURRENCE_A = "the handler's own catch never ran";
export const RECURRENCE_B = "this test fails on a `waitFor` timeout";

export type Label =
  /** The artifact prose volunteers no negative-existence claim. Correctly quiet. */
  | "no-claim"
  /** It volunteers one the pattern corpus did not match. A claim-SHAPE MISS. */
  | "claim-missed"
  /** The prose alone cannot settle it. */
  | "indeterminate";

/**
 * Claude Code derives its per-project transcript directory from the checkout
 * path with separators replaced by `-`. This usually runs from a SESSION
 * workspace, whose path is NOT that key, so deriving from cwd alone would
 * silently take the SKIP branch and report nothing.
 */
function resolveTranscriptDir(): string | null {
  const explicit = flag("--transcripts") ?? process.env["MINSKY_TRANSCRIPTS_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;

  const projects = join(homedir(), ".claude", "projects");
  if (!existsSync(projects)) return null;
  try {
    const matches = readdirSync(projects).filter((n) => n.endsWith("-minsky"));
    if (matches.length === 1) return join(projects, matches[0] as string);
    process.stderr.write(
      `Ambiguous transcript store: ${matches.length} candidates under ${projects}.\n` +
        `Pass --transcripts <dir> to choose one.\n`
    );
    return null;
  } catch {
    // intentional-swallow: an unreadable projects dir is the same as an absent
    // one here; the caller reports a SKIP either way.
    return null;
  }
}

export interface EvaluationRecord {
  timestamp?: string;
  session_id?: string;
  claimPresent?: boolean;
  proseChars?: number;
  fired?: boolean;
  [key: string]: unknown;
}

/**
 * Rejects, counted rather than swallowed (PR #3053 R1).
 *
 * A silently-dropped row shrinks the denominator without saying so, which is
 * the shape that turns a data-quality problem into a confident rate. These are
 * printed with every run.
 */
const rejects = { jsonlUnparseable: 0, transcriptUnreadable: 0, turnEvaluationThrew: 0 };

function readJsonl(path: string): EvaluationRecord[] {
  if (!existsSync(path)) return [];
  const out: EvaluationRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as EvaluationRecord);
    } catch {
      // A torn final line is expected in a live-appended log; counted so an
      // unexpected VOLUME of them is visible rather than inferred.
      rejects.jsonlUnparseable += 1;
      continue;
    }
  }
  return out;
}

/** A turn recovered from the store, re-evaluated by the detector's own code. */
export interface RecoveredTurn {
  sessionId: string;
  /** Last timestamp in the turn — what the hook's record timestamp follows. */
  endedAt: string;
  proseChars: number;
  claimPresent: boolean;
  prose: string;
}

/**
 * The DONE lookup, stubbed. Conjunct 3 is irrelevant here — this measures
 * conjunct 1 (claim shape), and the stream already proves conjunct 3 has never
 * eliminated a candidate (172 turns, 0 eliminations). Returning null is the
 * detector's own "lookup unavailable" path, so nothing is fabricated.
 */
const noLookup = async (): Promise<null> => null;

async function recoverTurns(dir: string): Promise<RecoveredTurn[]> {
  const out: RecoveredTurn[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    // intentional-swallow: reported as a SKIP by the caller.
    return out;
  }

  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "");
    let lines: TranscriptLine[];
    try {
      lines = parseTranscript(join(dir, file));
    } catch {
      // One unreadable transcript must not abort the sweep — but it is counted,
      // because a store that silently stops being readable would otherwise show
      // up only as a smaller, still-plausible denominator.
      rejects.transcriptUnreadable += 1;
      continue;
    }
    if (lines.length === 0) continue;

    const prompts = findRealPromptIndices(lines);
    for (let i = 0; i < prompts.length; i++) {
      const start = (prompts[i] as number) + 1;
      const end = i + 1 < prompts.length ? (prompts[i + 1] as number) : lines.length;
      const turn = lines.slice(start, end);
      if (turn.length === 0) continue;

      let evaluated: Awaited<ReturnType<typeof evaluateTurn>>;
      try {
        evaluated = await evaluateTurn(turn, noLookup);
      } catch {
        // A malformed turn produces no comparable record. Counted, so "the
        // detector threw on N turns" is reportable rather than inferred from a
        // gap between the store and the join count.
        rejects.turnEvaluationThrew += 1;
        continue;
      }
      if (evaluated === null) continue;

      const evaluation = evaluated.evaluation;
      // The turn's last line of ANY kind — measured, not assumed.
      //
      // Anchoring on the last ASSISTANT line instead was tried and is WORSE:
      // median record-to-turn gap 472s vs 8s. The hook writes its record after
      // the harness's own trailing entries for the turn, so the final line is
      // what the record timestamp actually follows.
      const endedAt = [...turn].reverse().find((l) => l.timestamp !== undefined)?.timestamp;
      if (endedAt === undefined) continue;

      out.push({
        sessionId,
        endedAt,
        proseChars: Number(evaluation["proseChars"] ?? -1),
        claimPresent: evaluation["claimPresent"] === true,
        // The judged text, rebuilt with the SAME two exported helpers the
        // adapter itself composes (`negative-existence-claim-detector.ts`
        // imports both from this module) — not a reimplementation that can
        // drift from what the detector actually saw.
        prose: elideBlocksAndQuotes(buildArtifactProseCorpus(turn)),
      });
    }
  }
  return out;
}

export interface Joined {
  record: EvaluationRecord;
  turn: RecoveredTurn | undefined;
  /** |record.timestamp - turn.endedAt| for the accepted join, for the bound audit. */
  gapMs?: number;
}

/**
 * How far apart a stored row's timestamp and its turn's last line may be.
 *
 * Derived from the measured distribution, which `--validate` prints so it can be
 * re-derived rather than trusted. Unbounded, over this corpus: **min 2.0s, p50
 * 8.0s, p95 17h, max 2.8 days.** The bulk sits in single-digit seconds and there
 * is a long tail — and critically **no knee**: join counts climb smoothly
 * (117 / 118 / 122 / 131 / 139 / 148 / 171 / 220 at 15s / 30s / 60s / 2m / 5m /
 * 15m / 1h / unbounded), so gap alone does not cleanly separate a real join from
 * a same-length coincidence.
 *
 * 15 minutes therefore excludes the multi-hour tail PR #3053 R1 flagged while
 * keeping the whole dense region, and is deliberately generous rather than
 * tuned: a bound with no knee behind it should not pretend to precision.
 *
 * **What licenses it is not the gap, it is the verdict.** Recovery agreement is
 * 100% on BOTH strata at every bound tried, including unbounded — so the bound
 * is a defensive narrowing that provably does not change the measurement, and
 * `--validate` reports the rejected count so the narrowing is visible.
 *
 * A rejected join is reported as unjoined, never silently resolved.
 */
const MAX_JOIN_GAP_MS = Number(process.env["MT4162_MAX_JOIN_GAP_MS"] ?? 900_000);

/**
 * Join each stored row to a recovered turn on `(session_id, proseChars)`.
 *
 * `proseChars` is an exact integer over the ELIDED artifact corpus, so within a
 * session it is a near-unique key; where several turns share a length, the one
 * ending nearest the row's timestamp wins. A row that joins to nothing is
 * reported as unjoined and never counted as agreement.
 */
export function joinRecords(records: EvaluationRecord[], turns: RecoveredTurn[]): Joined[] {
  const bySession = new Map<string, RecoveredTurn[]>();
  for (const t of turns) {
    const list = bySession.get(t.sessionId) ?? [];
    list.push(t);
    bySession.set(t.sessionId, list);
  }

  return records.map((record) => {
    const candidates = bySession.get(String(record.session_id ?? "")) ?? [];
    const sameLength = candidates.filter((t) => t.proseChars === record.proseChars);
    if (sameLength.length === 0) return { record, turn: undefined };
    if (sameLength.length === 1) {
      // A unique length match still has to clear the bound — a lone same-length
      // turn from hours away is the same coincidence as a tie-broken one.
      const only = sameLength[0] as RecoveredTurn;
      const at1 = new Date(String(record.timestamp ?? "")).getTime();
      const ended1 = new Date(only.endedAt).getTime();
      if (Number.isNaN(at1) || Number.isNaN(ended1)) return { record, turn: undefined };
      const gap1 = Math.abs(ended1 - at1);
      return gap1 > MAX_JOIN_GAP_MS
        ? { record, turn: undefined }
        : { record, turn: only, gapMs: gap1 };
    }

    // A record with no usable timestamp cannot be tie-broken, so it is left
    // UNJOINED rather than resolved to an arbitrary same-length turn (PR #3053
    // R1). `Math.abs(x - NaN)` is NaN and every `NaN < best` comparison is
    // false, so the old loop silently kept `sameLength[0]` — a guess that would
    // have entered the rate looking like a join.
    const at = new Date(String(record.timestamp ?? "")).getTime();
    if (Number.isNaN(at)) return { record, turn: undefined };

    let best: RecoveredTurn | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const t of sameLength) {
      const ended = new Date(t.endedAt).getTime();
      if (Number.isNaN(ended)) continue;
      const gap = Math.abs(ended - at);
      if (gap < bestGap) {
        bestGap = gap;
        best = t;
      }
    }
    // Beyond the bound, a same-length turn is a coincidence rather than the
    // record's own turn. See MAX_JOIN_GAP_MS for how the number was chosen.
    if (best === undefined || bestGap > MAX_JOIN_GAP_MS) return { record, turn: undefined };
    return { record, turn: best, gapMs: bestGap };
  });
}

function withinWindow(record: EvaluationRecord): boolean {
  if (UNTIL === undefined) return true;
  const ts = String(record.timestamp ?? "");
  return ts !== "" && ts <= UNTIL;
}

const pct = (n: number, of: number): string =>
  of === 0 ? "n/a" : `${((n / of) * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const dir = resolveTranscriptDir();
  if (dir === null || !existsSync(dir)) {
    process.stdout.write(
      "SKIP: local transcript store not found — the judged prose is reconstructed from it.\n" +
        "Pass --transcripts <dir> or set MINSKY_TRANSCRIPTS_DIR.\n"
    );
    return;
  }

  const all = readJsonl(LOG_PATH);
  const records = all.filter(withinWindow);
  const turns = await recoverTurns(dir);
  const joined = joinRecords(records, turns);

  const withTurn = joined.filter((j) => j.turn !== undefined);
  const unjoined = joined.length - withTurn.length;

  const agreeOn = (predicate: (j: Joined) => boolean, subset: Joined[]): number =>
    subset.filter(predicate).length;

  const claimTrue = withTurn.filter((j) => j.record.claimPresent === true);
  const claimFalse = withTurn.filter((j) => j.record.claimPresent === false);
  const agrees = (j: Joined): boolean => j.turn?.claimPresent === j.record.claimPresent;

  process.stdout.write(
    `log records: ${all.length}   in window (--until ${UNTIL ?? "none"}): ${records.length}\n` +
      `turns recovered from store: ${turns.length}\n` +
      `joined on (session_id, proseChars): ${withTurn.length}   unjoined: ${unjoined}\n` +
      `rejects — jsonl unparseable: ${rejects.jsonlUnparseable}, ` +
      `transcript unreadable: ${rejects.transcriptUnreadable}, ` +
      `turn evaluation threw: ${rejects.turnEvaluationThrew}\n\n` +
      `## Recovery agreement — re-running the detector's own evaluateTurn\n\n` +
      `claimPresent=true  stratum: ${agreeOn(agrees, claimTrue)}/${claimTrue.length} ` +
      `(${pct(agreeOn(agrees, claimTrue), claimTrue.length)})\n` +
      `claimPresent=false stratum: ${agreeOn(agrees, claimFalse)}/${claimFalse.length} ` +
      `(${pct(agreeOn(agrees, claimFalse), claimFalse.length)})\n` +
      `(both strata are reported because agreement on one alone cannot show the\n` +
      ` recovery discriminates — a join that always returned a quiet turn would\n` +
      ` score 100% on the false stratum and 0% on the true one.)\n`
  );

  if (ARGV.includes("--validate")) {
    // The bound's own audit: print the distribution MAX_JOIN_GAP_MS was derived
    // from, so a reader can re-derive it instead of trusting the constant.
    const gaps = withTurn
      .map((j) => j.gapMs ?? 0)
      .slice()
      .sort((a, b) => a - b);
    const at = (q: number): number =>
      gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] ?? 0;
    process.stdout.write(
      `\n## Join-gap distribution (bound = ${MAX_JOIN_GAP_MS} ms)\n\n` +
        `accepted joins: ${gaps.length}\n` +
        `min ${gaps[0] ?? 0} ms   p50 ${at(0.5)} ms   p95 ${at(0.95)} ms   max ${gaps[gaps.length - 1] ?? 0} ms\n`
    );
    return;
  }

  /**
   * The population a claim-shape fix could actually change.
   *
   * The detector fires on conjunct 1 AND conjunct 2 AND a DONE citation. So a
   * `claimPresent: false` turn where `thinSearchPresent` is ALSO false would not
   * fire even under a perfect claim matcher — widening claim shape cannot
   * produce a fire there. Labeling those measures "does the corpus miss claims"
   * in the abstract; labeling the intersection measures the thing the rung
   * decision turns on, which is what ADR-024 §(b) asks for.
   *
   * Both denominators are printed, because reporting only the narrow one would
   * overstate what was examined and only the wide one would overstate the work.
   */
  const actionable = claimFalse.filter((j) => j.record["thinSearchPresent"] === true);
  process.stdout.write(
    `\n## Labeling population (JOINED rows only — ${withTurn.length} of ${records.length} in window)\n\n` +
      `claimPresent=false, joined             : ${claimFalse.length}\n` +
      `  ... AND thinSearchPresent=true       : ${actionable.length}  <- a claim-shape fix could flip these\n` +
      `  ... AND thinSearchPresent=false      : ${claimFalse.length - actionable.length}  <- cannot fire regardless; conjunct 2 fails\n`
  );

  const dumpPath = flag("--dump");
  if (dumpPath !== undefined) {
    const wide = ARGV.includes("--all-claim-false");
    const payload = (wide ? claimFalse : actionable).map((j) => ({
      timestamp: j.record.timestamp,
      session_id: j.record.session_id,
      proseChars: j.record.proseChars,
      label: null as Label | null,
      prose: j.turn?.prose ?? "",
    }));
    writeFileSync(dumpPath, `${JSON.stringify(payload, null, 2)}\n`);
    process.stdout.write(
      `\nWrote ${payload.length} unlabeled records to ${dumpPath} (LOCAL FILE — contains\n` +
        `recovered artifact prose; this is the only path on which this script writes).\n`
    );
    return;
  }

  const labelsPath = flag("--labels");
  if (labelsPath === undefined) {
    process.stdout.write(
      `\nNo --labels supplied, so no rate is reported. Run --dump first, label the\n` +
        `records, then pass the file back with --labels.\n`
    );
    return;
  }

  const labeled = JSON.parse(readFileSync(labelsPath, "utf8")) as Array<{
    timestamp?: string;
    label?: Label | null;
  }>;
  const counts = new Map<string, number>();
  for (const row of labeled) {
    const key = row.label ?? "unlabeled";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const missed = counts.get("claim-missed") ?? 0;
  const noClaim = counts.get("no-claim") ?? 0;
  const indeterminate = counts.get("indeterminate") ?? 0;
  const decided = missed + noClaim;

  process.stdout.write(
    `\n## Claim-shape recall-miss rate (ADR-024 §(b))\n\n` +
      `labeled records: ${labeled.length}\n` +
      `  claim-missed  : ${missed}\n` +
      `  no-claim      : ${noClaim}\n` +
      `  indeterminate : ${indeterminate}\n` +
      `  unlabeled     : ${counts.get("unlabeled") ?? 0}\n\n` +
      `miss rate over DECIDED records: ${missed}/${decided} (${pct(missed, decided)})\n` +
      `(indeterminate rows are excluded from the denominator and reported, rather\n` +
      ` than folded into either bucket.)\n`
  );
}

// Guarded so the test can import `joinRecords` without the module sweeping the
// transcript store as a side effect of being loaded.
if (import.meta.main) await main();
