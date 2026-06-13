/**
 * Calibration Review Sweep — pure logic module (mt#2483).
 *
 * Enumerates known hook-calibration JSONLs via a registry, counts fires,
 * computes diversity signals, checks watermarks, and returns per-log results.
 *
 * ALL functions here are pure (side-effect-free) relative to I/O: they accept
 * parsed data and return structured results. Filesystem I/O lives in the
 * command adapter (`calibration-commands.ts`), keeping this module unit-testable.
 *
 * Threshold grounding (CLAUDE.md §Thresholds: ground in observed cadence):
 *   - FIRES_THRESHOLD: 10 — per the explicit spec language in mt#2057 and mt#2216
 *     ("review after ~10 fires, then decide"). Matches the observation window
 *     where calibration log accumulation is meaningful (one session may produce
 *     1–3 fires; 10 represents roughly 4–10 sessions of data).
 *   - DIVERSITY_THRESHOLD: 3 — the log is more informative when the matched
 *     phrases are NOT all the same pattern. 3 distinct phrases across 10 fires
 *     is the minimum diversity signal (≤2/10 distinct → single-pattern rut;
 *     ≥3/10 → genuine variety worth an FP-review round).
 *
 * @see mt#2483 — tracking task
 * @see mt#2057 — retrospective-trigger calibration log origin
 * @see mt#2216 — causal-premise calibration log origin
 */

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry entry describing one hook-calibration JSONL log.
 *
 * Adding a third log is a one-line change: append a new entry here.
 * Every entry must include the path (repo-relative), a display name for
 * operator-facing output, and the record kind (drives the parse path).
 */
export interface CalibrationLogEntry {
  /** Repo-relative path to the JSONL log file. */
  path: string;
  /** Human-readable name for display (no spaces; use kebab). */
  name: string;
  /**
   * Record kind — drives how matched phrases are extracted from each record.
   * "causal-premise"     → record.matchedPhrases: string[]
   * "retrospective-trigger" → record.matches: {family, phrase}[]
   */
  kind: "causal-premise" | "retrospective-trigger";
}

/**
 * Registry of all known hook-calibration JSONL logs.
 *
 * V1 entries (mt#2483):
 *   - causal-premise-calibration.jsonl (mt#2216)
 *   - retrospective-trigger-calibration.jsonl (mt#2057)
 *
 * To add a third log: append one CalibrationLogEntry here.
 */
export const CALIBRATION_LOG_REGISTRY: CalibrationLogEntry[] = [
  {
    path: ".minsky/causal-premise-calibration.jsonl",
    name: "causal-premise",
    kind: "causal-premise",
  },
  {
    path: ".minsky/retrospective-trigger-calibration.jsonl",
    name: "retrospective-trigger",
    kind: "retrospective-trigger",
  },
];

// ---------------------------------------------------------------------------
// Threshold constants (documented per CLAUDE.md threshold-grounding rule)
// ---------------------------------------------------------------------------

/**
 * Minimum fires-since-last-review to trigger a past-threshold report.
 * Grounded in: mt#2057 ("review after ~10 fires") and mt#2216 ("~10 fires").
 * At Minsky's session cadence (~1/day workaround invocation), 10 represents
 * ~4–10 sessions of data — enough to compute a meaningful FP rate.
 */
export const FIRES_THRESHOLD = 10;

/**
 * Minimum distinct matched-phrase count (diversity signal) to trigger a
 * past-threshold report alongside FIRES_THRESHOLD.
 *
 * Rationale: a log with 10 fires but all on the same single phrase may simply
 * reflect a single recurring false-positive pattern; 3 distinct phrases means
 * the hook is firing across diverse contexts, making the FP-rate review
 * meaningful. When fires >= FIRES_THRESHOLD AND distinctPhrases < DIVERSITY_THRESHOLD,
 * `pastThreshold` is still true (the fires count alone warrants a review), but
 * the report includes a `lowDiversity` flag so the operator knows the sample is
 * pattern-concentrated.
 */
export const DIVERSITY_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Watermark store types
// ---------------------------------------------------------------------------

/**
 * Watermark record for a single log. Keyed by log path → watermark state.
 * Written to `.minsky/calibration-review-watermarks.json`.
 */
export interface LogWatermark {
  /**
   * The number of records present in the log at the time of the last review.
   * Fires-since-last-review = current record count - lastReviewedCount.
   */
  lastReviewedCount: number;
  /** ISO-8601 timestamp of the last review. */
  lastReviewedAt: string;
}

/** Shape of the full watermark store (path → mark). */
export type WatermarkStore = Record<string, LogWatermark>;

// ---------------------------------------------------------------------------
// Parsed record types
// ---------------------------------------------------------------------------

/** Parsed causal-premise calibration record. */
export interface CausalPremiseRecord {
  timestamp: string;
  session_id?: string;
  matchedPhrases: string[];
  hadSameTurnVerification: boolean;
}

/** Parsed retrospective-trigger calibration record. */
export interface RetrospectiveTriggerRecord {
  timestamp: string;
  session_id?: string;
  matches: Array<{ family: string; phrase: string }>;
  transcript_excerpt?: string;
}

/** Union of all record types. */
export type CalibrationRecord = CausalPremiseRecord | RetrospectiveTriggerRecord;

// ---------------------------------------------------------------------------
// Per-log result
// ---------------------------------------------------------------------------

/** Result for a single calibration log. */
export interface CalibrationLogResult {
  /** Registry entry this result corresponds to. */
  entry: CalibrationLogEntry;
  /** Whether the log file was found on disk. */
  exists: boolean;
  /** Total records in the log (all-time). */
  totalFires: number;
  /** Records added since the last acknowledged review (= total - watermark). */
  firesSinceLastReview: number;
  /** Number of distinct matched phrases across all fires-since-last-review records. */
  distinctPhrases: number;
  /** Whether distinctPhrases < DIVERSITY_THRESHOLD while pastThreshold is true. */
  lowDiversity: boolean;
  /** True when fires-since-last-review >= FIRES_THRESHOLD. */
  pastThreshold: boolean;
  /** The un-reviewed records (since last watermark). Empty when not past threshold. */
  newRecords: CalibrationRecord[];
  /** The watermark at review time (may be zero if never reviewed). */
  watermarkCount: number;
}

// ---------------------------------------------------------------------------
// Record parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSONL line into a typed record, or return null on failure.
 *
 * @param line - raw JSONL line string
 * @param kind - log kind (drives parse path)
 */
export function parseCalibrationRecord(
  line: string,
  kind: CalibrationLogEntry["kind"]
): CalibrationRecord | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (kind === "causal-premise") {
      // Shape: { timestamp, session_id?, matchedPhrases: string[], hadSameTurnVerification: boolean }
      if (!Array.isArray(raw["matchedPhrases"])) return null;
      return {
        timestamp: String(raw["timestamp"] ?? ""),
        session_id: raw["session_id"] !== undefined ? String(raw["session_id"]) : undefined,
        matchedPhrases: (raw["matchedPhrases"] as unknown[]).map(String),
        hadSameTurnVerification: Boolean(raw["hadSameTurnVerification"]),
      } satisfies CausalPremiseRecord;
    } else {
      // retrospective-trigger
      // Shape: { timestamp, session_id?, matches: [{family, phrase}][], transcript_excerpt? }
      const matches = Array.isArray(raw["matches"])
        ? (raw["matches"] as unknown[]).map((m) => {
            const obj = m as Record<string, unknown>;
            return { family: String(obj["family"] ?? ""), phrase: String(obj["phrase"] ?? "") };
          })
        : [];
      return {
        timestamp: String(raw["timestamp"] ?? ""),
        session_id: raw["session_id"] !== undefined ? String(raw["session_id"]) : undefined,
        matches,
        transcript_excerpt:
          raw["transcript_excerpt"] !== undefined ? String(raw["transcript_excerpt"]) : undefined,
      } satisfies RetrospectiveTriggerRecord;
    }
  } catch {
    return null;
  }
}

/**
 * Parse all lines of a JSONL log, skipping blank lines and unparseable lines.
 */
export function parseCalibrationLines(
  content: string,
  kind: CalibrationLogEntry["kind"]
): CalibrationRecord[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseCalibrationRecord(line, kind))
    .filter((r): r is CalibrationRecord => r !== null);
}

// ---------------------------------------------------------------------------
// Diversity signal
// ---------------------------------------------------------------------------

/**
 * Extract the set of distinct matched phrases from a slice of records.
 *
 * For causal-premise records: each entry in `matchedPhrases` is a phrase.
 * For retrospective-trigger records: each entry in `matches[].phrase` is a phrase.
 */
export function extractDistinctPhrases(records: CalibrationRecord[]): Set<string> {
  const phrases = new Set<string>();
  for (const rec of records) {
    if ("matchedPhrases" in rec) {
      for (const p of rec.matchedPhrases) {
        phrases.add(p);
      }
    } else {
      for (const m of rec.matches) {
        phrases.add(m.phrase);
      }
    }
  }
  return phrases;
}

// ---------------------------------------------------------------------------
// Core sweep logic (pure)
// ---------------------------------------------------------------------------

/**
 * Compute the calibration review result for a single log.
 *
 * @param entry     - registry entry describing the log
 * @param content   - raw JSONL file content (empty string if file absent)
 * @param exists    - whether the log file exists on disk
 * @param watermark - previously persisted watermark for this log (or undefined)
 */
export function computeLogResult(
  entry: CalibrationLogEntry,
  content: string,
  exists: boolean,
  watermark: LogWatermark | undefined
): CalibrationLogResult {
  const allRecords = exists ? parseCalibrationLines(content, entry.kind) : [];
  const watermarkCount = watermark?.lastReviewedCount ?? 0;
  const totalFires = allRecords.length;
  const firesSinceLastReview = Math.max(0, totalFires - watermarkCount);
  const newRecords = allRecords.slice(watermarkCount);

  const distinctPhrases = extractDistinctPhrases(newRecords).size;
  const pastThreshold = firesSinceLastReview >= FIRES_THRESHOLD;
  const lowDiversity = pastThreshold && distinctPhrases < DIVERSITY_THRESHOLD;

  return {
    entry,
    exists,
    totalFires,
    firesSinceLastReview,
    distinctPhrases,
    lowDiversity,
    pastThreshold,
    newRecords: pastThreshold ? newRecords : [],
    watermarkCount,
  };
}

/**
 * Compute results for all entries in the registry.
 *
 * @param entries      - registry (defaults to CALIBRATION_LOG_REGISTRY)
 * @param readContent  - function to read a log file; returns null if absent
 * @param watermarks   - current watermark store
 */
export async function runSweep(
  entries: CalibrationLogEntry[],
  readContent: (path: string) => Promise<string | null>,
  watermarks: WatermarkStore
): Promise<CalibrationLogResult[]> {
  const results: CalibrationLogResult[] = [];
  for (const entry of entries) {
    const content = await readContent(entry.path);
    const exists = content !== null;
    const watermark = watermarks[entry.path];
    results.push(computeLogResult(entry, content ?? "", exists, watermark));
  }
  return results;
}

/**
 * Produce an updated watermark store by advancing marks for all logs that
 * have been acknowledged (acked).
 *
 * Only advances the mark for logs whose path is in `ackedPaths`.
 * Returns a new store (does not mutate the input).
 *
 * @param current    - current watermark store
 * @param results    - sweep results (used to read current total counts)
 * @param ackedPaths - set of log paths whose watermarks should be advanced
 * @param now        - timestamp string to use for lastReviewedAt
 */
export function advanceWatermarks(
  current: WatermarkStore,
  results: CalibrationLogResult[],
  ackedPaths: Set<string>,
  now: string
): WatermarkStore {
  const updated: WatermarkStore = { ...current };
  for (const result of results) {
    if (ackedPaths.has(result.entry.path)) {
      updated[result.entry.path] = {
        lastReviewedCount: result.totalFires,
        lastReviewedAt: now,
      };
    }
  }
  return updated;
}
