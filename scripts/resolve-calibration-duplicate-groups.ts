#!/usr/bin/env bun
/**
 * mt#3866 SC3 — resolve a duplicate group by borrowing a sibling stream's digest.
 *
 * ## What this is for
 *
 * The digest coupling shipped with mt#3866 makes records written FROM NOW ON
 * groupable. It does nothing for the corpus already on disk, which carries no
 * identity at all — and that historical corpus is what every recorded duplicate
 * group lives in.
 *
 * `## Evidence 2026-08-16` on mt#3866 found the route: an evaluation stream that
 * hashes its judged input is a distinct-fire oracle for every OTHER detector
 * that ran on the same turn, joinable on `(session_id, timestamp ± tolerance)`.
 * This script is that join, generalized from the one-off it was found by.
 *
 * ## The coverage bound, measured — read this before trusting a zero
 *
 * Exactly ONE evaluation stream carries a digest today. Counted with `has()`
 * rather than a null read, because a projection over a missing key returns
 * `null` and reads exactly like a present-but-empty field:
 *
 * ```
 * causal-premise-evaluations.jsonl          659 / 659   <- the only oracle
 * operator-deferral-evaluations.jsonl         0 / 1556
 * retrospective-trigger-evaluations.jsonl     0 / 668
 * untaken-action-evaluations.jsonl            0 / 613
 * …and seven more, all 0
 * ```
 *
 * So `unresolvable` is the EXPECTED verdict wherever `causal-premise` did not
 * happen to run on the same turn — it means "no oracle covered this", never
 * "these are distinct". Widening the oracle is a separate change (the same
 * adoption campaign as mt#4001) and is not attempted here.
 *
 * USAGE
 *   bun scripts/resolve-calibration-duplicate-groups.ts <detector-name> [--tolerance-ms N]
 *
 * Exit 0 when the join ran. Exit 1 when a required log is missing — "could not
 * check" and "checked, nothing found" must never render as the same result.
 */

import { readFileSync, existsSync } from "node:fs";

// The WRITER's own resolvers, not a hand-rolled state-dir key. mt#4971 fixed
// exactly this in ten replay scripts: each had reconstructed the pre-mt#4748
// repo path and printed `SKIP: calibration log not found`, which exits 0 and
// reads as "nothing to do". Deriving the key here from `process.cwd()` would
// re-create it one step further along — a session workspace hashes to a
// DIFFERENT project key than the main checkout, so the script would find an
// empty corpus and report a clean zero.
import { calibrationLogPath, evaluationLogPath } from "../.minsky/hooks/dispatcher";

/** Default join window. The observed offsets were 20-24ms; 1s is generous. */
const DEFAULT_TOLERANCE_MS = 1000;

/** The one stream that hashes its judged input — see the coverage bound above. */
const ORACLE_STREAM = "causal-premise";

interface OracleEntry {
  readonly sessionId: string;
  readonly atMs: number;
  readonly hash: string;
  readonly length: number;
}

interface CalibrationEntry {
  readonly sessionId: string;
  readonly atMs: number;
  readonly timestamp: string;
  /** The joined key a reviewer sees a duplicate of — the match context. */
  readonly context: string;
}

/**
 * Parse a JSONL corpus, REPORTING what it could not parse.
 *
 * PR #3656 R3 (non-blocking). The first cut swallowed malformed lines silently,
 * which is the same shape this whole script exists to make visible: a truncated
 * or partially-written log would shrink the corpus and the run would print a
 * confident, smaller answer with nothing marking the loss. A calibration log is
 * append-only from several processes, so a torn final line is a real state, not
 * a hypothetical.
 *
 * Skips are counted and surfaced on stderr rather than thrown on: one bad line
 * should not make the other 1,555 unreadable. The count is what turns a silent
 * shrink into something a reader can weigh.
 */
function readJsonl(path: string): Record<string, unknown>[] {
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let skipped = 0;
  const parsed = lines.flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      skipped += 1;
      return [];
    }
  });

  if (skipped > 0) {
    console.error(
      `[resolve-duplicate-groups] WARNING: skipped ${skipped} of ${lines.length} unparseable ` +
        `line(s) in ${path}. Counts below are over ${parsed.length} records, not ${lines.length}.`
    );
  }
  return parsed;
}

function loadOracle(): OracleEntry[] {
  const path = evaluationLogPath(ORACLE_STREAM);
  if (!existsSync(path)) {
    console.error(`[resolve-duplicate-groups] oracle stream missing: ${path}`);
    process.exit(1);
  }
  return readJsonl(path).flatMap((r) => {
    const judged = r["judgedInput"] as { hash?: unknown; length?: unknown } | undefined;
    const sessionId = r["session_id"];
    const timestamp = r["timestamp"];
    if (
      typeof judged?.hash !== "string" ||
      typeof sessionId !== "string" ||
      typeof timestamp !== "string"
    ) {
      return [];
    }
    return [
      {
        sessionId,
        atMs: Date.parse(timestamp),
        hash: judged.hash,
        length: typeof judged.length === "number" ? judged.length : -1,
      },
    ];
  });
}

function loadCalibration(detector: string): CalibrationEntry[] {
  const path = calibrationLogPath(detector);
  if (!existsSync(path)) {
    console.error(`[resolve-duplicate-groups] calibration log missing: ${path}`);
    process.exit(1);
  }
  return readJsonl(path).flatMap((r) => {
    const sessionId = r["session_id"];
    const timestamp = r["timestamp"];
    if (typeof sessionId !== "string" || typeof timestamp !== "string") return [];
    const matches = Array.isArray(r["matches"]) ? (r["matches"] as Record<string, unknown>[]) : [];
    const context = matches
      .map((m) => (typeof m["context"] === "string" ? m["context"] : ""))
      .join(" || ");
    return [{ sessionId, atMs: Date.parse(timestamp), timestamp, context }];
  });
}

/**
 * Group the oracle by session once, so the join is not O(records x oracle).
 *
 * PR #3656 R1 (non-blocking). The scan was linear over all 659 oracle entries
 * per record; at the corpus sizes this reads — 1,556 records against 659 oracle
 * entries is the largest pairing today — that is fine, and it is fine only
 * because the corpus is small. Both grow monotonically (these logs are
 * append-only), so the index is the version that stays correct rather than the
 * version that is currently fast enough.
 */
function indexBySession(oracle: OracleEntry[]): Map<string, OracleEntry[]> {
  const bySession = new Map<string, OracleEntry[]>();
  for (const o of oracle) {
    const bucket = bySession.get(o.sessionId);
    if (bucket === undefined) bySession.set(o.sessionId, [o]);
    else bucket.push(o);
  }
  // Sorted so the windowed scan below can stop early rather than read the
  // whole session's history for every record.
  for (const bucket of bySession.values()) bucket.sort((x, y) => x.atMs - y.atMs);
  return bySession;
}

/** Nearest oracle entry in the same session within `toleranceMs`, or undefined. */
function borrowDigest(
  entry: CalibrationEntry,
  bySession: Map<string, OracleEntry[]>,
  toleranceMs: number
): OracleEntry | undefined {
  const bucket = bySession.get(entry.sessionId);
  if (bucket === undefined) return undefined;

  let best: OracleEntry | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const o of bucket) {
    const delta = o.atMs - entry.atMs;
    // Sorted ascending, so once an entry is past the window every later one is
    // too.
    if (delta > toleranceMs) break;
    const absDelta = Math.abs(delta);
    if (absDelta <= toleranceMs && absDelta < bestDelta) {
      best = o;
      bestDelta = absDelta;
    }
  }
  return best;
}

function main(): void {
  const detector = process.argv[2];
  if (detector === undefined || detector.startsWith("--")) {
    console.error("usage: bun scripts/resolve-calibration-duplicate-groups.ts <detector-name>");
    process.exit(1);
  }
  // PR #3656 R1 (non-blocking): `--tolerance-ms` with no value made
  // `Number(undefined)` → NaN, and every `delta <= NaN` is false — so the join
  // would find nothing and print a clean "unresolvable: N" that reads exactly
  // like a genuine coverage gap. A flag typo silently inverting the result is
  // worse than an error, so this fails loudly instead.
  const toleranceIdx = process.argv.indexOf("--tolerance-ms");
  let toleranceMs = DEFAULT_TOLERANCE_MS;
  if (toleranceIdx > 0) {
    const raw = process.argv[toleranceIdx + 1];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(
        `[resolve-duplicate-groups] --tolerance-ms needs a non-negative number, got ${
          raw === undefined ? "(nothing)" : JSON.stringify(raw)
        }`
      );
      process.exit(1);
    }
    toleranceMs = parsed;
  }

  const oracle = loadOracle();
  const records = loadCalibration(detector);
  const oracleBySession = indexBySession(oracle);

  // A GROUP is records sharing a session AND a byte-identical match context —
  // the shape a reviewer sees and cannot resolve. Singletons are not ambiguous
  // and are excluded rather than reported as trivially resolved.
  const groups = new Map<string, CalibrationEntry[]>();
  for (const r of records) {
    if (r.context === "") continue;
    const key = `${r.sessionId}::${r.context}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const duplicates = [...groups.values()].filter((g) => g.length > 1);

  console.log(`detector:            ${detector}`);
  console.log(`records:             ${records.length}`);
  console.log(`oracle entries:      ${oracle.length} (${ORACLE_STREAM})`);
  console.log(`duplicate groups:    ${duplicates.length}`);
  console.log(`join tolerance:      ${toleranceMs}ms\n`);

  let resolvedRescan = 0;
  let resolvedDistinct = 0;
  let unresolvable = 0;

  for (const group of duplicates) {
    const borrowed = group.map((e) => ({ e, o: borrowDigest(e, oracleBySession, toleranceMs) }));
    const digests = new Set(borrowed.map(({ o }) => o?.hash).filter((h): h is string => !!h));
    const missing = borrowed.filter(({ o }) => o === undefined).length;

    const first = group[0];
    if (first === undefined) continue;
    console.log(`group: ${group.length} records, session ${first.sessionId.slice(0, 8)}`);
    console.log(
      `  context: ${first.context.slice(0, 110)}${first.context.length > 110 ? "…" : ""}`
    );
    for (const { e, o } of borrowed) {
      console.log(
        `    ${e.timestamp}  ${o ? `hash=${o.hash} len=${o.length}` : "no oracle entry in window"}`
      );
    }

    if (missing > 0) {
      unresolvable += 1;
      console.log(`  VERDICT: unresolvable — ${missing} of ${group.length} have no oracle entry.`);
      console.log("    Not evidence they are distinct; evidence the oracle did not cover them.\n");
    } else if (digests.size === 1) {
      resolvedRescan += 1;
      const len = borrowed[0]?.o?.length ?? -1;
      console.log(
        `  VERDICT: RE-SCAN — one message judged ${group.length} times. All borrowed digests\n` +
          `    are identical over ${len} characters, which repeat authoring could not produce.\n`
      );
    } else {
      resolvedDistinct += 1;
      console.log(
        `  VERDICT: DISTINCT — ${digests.size} different judged messages, so these are\n` +
          `    genuinely separate fires that happen to share a matched sentence.\n`
      );
    }
  }

  console.log("--- summary ---");
  console.log(`  resolved as RE-SCAN:   ${resolvedRescan}`);
  console.log(`  resolved as DISTINCT:  ${resolvedDistinct}`);
  console.log(`  unresolvable:          ${unresolvable}`);
  console.log(
    `\n  'unresolvable' means ${ORACLE_STREAM} did not run on that turn. It is the expected\n` +
      "  verdict for most of the corpus and must not be read as a distinctness finding."
  );
}

if (import.meta.main) main();
