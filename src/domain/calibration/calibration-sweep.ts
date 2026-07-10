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
   * "causal-premise"          → record.matchedPhrases: string[]
   * "retrospective-trigger"   → record.matches: {family, phrase}[]
   * "ask-routing-deferral"    → record.matches: {class, phrase}[] (mt#2498) —
   *   same matches-shape as retrospective-trigger; the per-match label key is
   *   `class` not `family`. Both parse through the same branch.
   * "code-mechanism-assertion" → record.claims: {symbol, predicate}[] (mt#2486).
   * "pre-narration"            → record.matches: {category, phrase, ...}[] (mt#2197) —
   *   same matches-shape family as retrospective-trigger/ask-routing-deferral;
   *   the per-match label key is `category`.
   * "policy-coverage"          → record.{reason, outcome, evidence?} (mt#1575) —
   *   a per-tool-call coverage-decision audit record, NOT a matched-phrase
   *   record. Diversity is measured over distinct `reason` values instead of
   *   distinct phrases (see extractDistinctPhrases).
   */
  kind:
    | "causal-premise"
    | "retrospective-trigger"
    | "ask-routing-deferral"
    | "code-mechanism-assertion"
    | "pre-narration"
    | "policy-coverage";
}

/**
 * Registry of all known hook-calibration JSONL logs.
 *
 * V1 entries (mt#2483):
 *   - causal-premise-calibration.jsonl (mt#2216)
 *   - retrospective-trigger-calibration.jsonl (mt#2057)
 *   - ask-routing-deferral-calibration.jsonl (mt#2471, registered mt#2498)
 *
 * V2 entries (mt#2619 — calibration-review cadence closeout):
 *   - code-mechanism-assertion-calibration.jsonl (mt#2486)
 *   - pre-narration-calibration.jsonl (mt#2197)
 *   - policy-coverage-calibration.jsonl (mt#1575) — NOTE: this log is NOT a
 *     matched-phrase detector log like the other five. It is a per-tool-call
 *     coverage-decision audit trail (every Edit/Write/NotebookEdit gets a
 *     record, "covered" or "uncovered"), so its volume and semantics differ.
 *     It is registered here so the standing cadence mechanism surfaces it —
 *     see mt#2619 PR body for the disposition finding (100% "covered" outcome
 *     across 1,457 fires with evidence spans that do not match the action).
 *
 * To add another log: append one CalibrationLogEntry here.
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
  {
    path: ".minsky/ask-routing-deferral-calibration.jsonl",
    name: "ask-routing-deferral",
    kind: "ask-routing-deferral",
  },
  {
    path: ".minsky/code-mechanism-assertion-calibration.jsonl",
    name: "code-mechanism-assertion",
    kind: "code-mechanism-assertion",
  },
  {
    path: ".minsky/pre-narration-calibration.jsonl",
    name: "pre-narration",
    kind: "pre-narration",
  },
  {
    path: ".minsky/policy-coverage-calibration.jsonl",
    name: "policy-coverage",
    kind: "policy-coverage",
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
 * meaningful. The threshold is diversity-aware: when fires >= FIRES_THRESHOLD AND
 * distinctPhrases < DIVERSITY_THRESHOLD, `pastThreshold` is FALSE (a uniform
 * pattern is not yet a review signal) and the report sets `lowDiversity` so the
 * operator knows the count bar was hit but the sample is pattern-concentrated —
 * the "keep collecting" state.
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
  /**
   * ID of an operator-routed Ask (mt#1034 / ADR-008) filed by the
   * /calibration-review skill's Step 4 that still awaits a disposition
   * (flip/tune/keep). Present only while the ask is open (mt#2659) — the
   * cadence detector suppresses its normal per-turn warning for this log in
   * favor of a single "disposition pending" line while this field is set.
   *
   * Cleared via `clearResolvedAskIds()` once the /calibration-review skill
   * confirms (via `asks_list`) that the referenced ask has reached a
   * terminal state (responded/closed/cancelled/expired) — at which point
   * normal cadence-detector behavior resumes for this log.
   */
  openAskId?: string;
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

/** Parsed code-mechanism-assertion calibration record (mt#2486). */
export interface CodeMechanismAssertionRecord {
  timestamp: string;
  session_id?: string;
  claims: Array<{ symbol: string; predicate: string }>;
  hadSameTurnRead: boolean;
}

/**
 * Parsed policy-coverage calibration record (mt#1575).
 *
 * Unlike the other five logs, this is NOT a matched-phrase detector record —
 * it is a per-tool-call coverage-decision audit line emitted on EVERY
 * Edit/Write/NotebookEdit the detector evaluates (outcome: "covered" /
 * "uncovered-logged" / "uncovered-blocked" / "dismissed"). `reason` is the
 * action-filter trigger condition (e.g. "new-file", "new-dependency").
 */
export interface PolicyCoverageRecord {
  timestamp: string;
  session_id?: string;
  toolName?: string;
  reason: string;
  filePath?: string;
  outcome: string;
  evidence?: Array<{ policySource: string; matchedCategory?: string; matchedAuthority?: string }>;
}

/** Union of all record types. */
export type CalibrationRecord =
  | CausalPremiseRecord
  | RetrospectiveTriggerRecord
  | CodeMechanismAssertionRecord
  | PolicyCoverageRecord;

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
  /** True when fires-since-last-review >= FIRES_THRESHOLD (count bar, diversity-agnostic). */
  atCountThreshold: boolean;
  /** True when the count bar is hit but distinctPhrases < DIVERSITY_THRESHOLD ("keep collecting"). */
  lowDiversity: boolean;
  /**
   * The DIVERSITY-AWARE review signal: true only when fires-since-last-review >=
   * FIRES_THRESHOLD AND distinctPhrases >= DIVERSITY_THRESHOLD. This is what the
   * skill keys the Ask off; lowDiversity logs are NOT pastThreshold.
   */
  pastThreshold: boolean;
  /** The un-reviewed records (since last watermark). Empty when below the count bar. */
  newRecords: CalibrationRecord[];
  /** The watermark at review time (may be zero if never reviewed). */
  watermarkCount: number;
  /**
   * ID of a still-open disposition Ask filed for this log by a prior
   * /calibration-review pass (mt#2659), forwarded from the watermark's
   * `openAskId`. Undefined when no ask is on file or it has been cleared.
   */
  openAskId?: string;
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
    }

    if (kind === "code-mechanism-assertion") {
      // Shape: { timestamp, session_id?, claims: [{symbol, predicate}][], hadSameTurnRead }
      const claims = Array.isArray(raw["claims"])
        ? (raw["claims"] as unknown[]).map((c) => {
            const obj = c as Record<string, unknown>;
            return {
              symbol: String(obj["symbol"] ?? ""),
              predicate: String(obj["predicate"] ?? ""),
            };
          })
        : [];
      return {
        timestamp: String(raw["timestamp"] ?? ""),
        session_id: raw["session_id"] !== undefined ? String(raw["session_id"]) : undefined,
        claims,
        hadSameTurnRead: Boolean(raw["hadSameTurnRead"]),
      } satisfies CodeMechanismAssertionRecord;
    }

    if (kind === "policy-coverage") {
      // Shape: { timestamp, sessionId?, toolName?, reason, filePath?, outcome, evidence? }
      // NOTE: this producer uses `sessionId` (camelCase), not `session_id` like
      // the other five logs — mirrored here rather than normalised so the
      // parser stays a faithful reflection of what the hook actually writes.
      if (typeof raw["reason"] !== "string" || typeof raw["outcome"] !== "string") return null;
      const evidence = Array.isArray(raw["evidence"])
        ? (raw["evidence"] as unknown[]).map((e) => {
            const obj = e as Record<string, unknown>;
            return {
              policySource: String(obj["policySource"] ?? ""),
              matchedCategory:
                obj["matchedCategory"] !== undefined ? String(obj["matchedCategory"]) : undefined,
              matchedAuthority:
                obj["matchedAuthority"] !== undefined ? String(obj["matchedAuthority"]) : undefined,
            };
          })
        : undefined;
      return {
        timestamp: String(raw["timestamp"] ?? ""),
        session_id: raw["sessionId"] !== undefined ? String(raw["sessionId"]) : undefined,
        toolName: raw["toolName"] !== undefined ? String(raw["toolName"]) : undefined,
        reason: raw["reason"],
        filePath: raw["filePath"] !== undefined ? String(raw["filePath"]) : undefined,
        outcome: raw["outcome"],
        evidence,
      } satisfies PolicyCoverageRecord;
    }

    // retrospective-trigger, ask-routing-deferral (mt#2498), OR pre-narration
    // (mt#2197) — same matches-shape family. retrospective-trigger labels each
    // match with `family`; ask-routing-deferral labels it with `class`;
    // pre-narration labels it with `category`. Read all three so any of the
    // three kinds parses; only `.phrase` is used downstream (diversity +
    // fire-count).
    // Shape: { timestamp, session_id?, matches: [{family|class|category, phrase}][], transcript_excerpt? }
    const matches = Array.isArray(raw["matches"])
      ? (raw["matches"] as unknown[]).map((m) => {
          const obj = m as Record<string, unknown>;
          return {
            family: String(obj["family"] ?? obj["class"] ?? obj["category"] ?? ""),
            phrase: String(obj["phrase"] ?? ""),
          };
        })
      : [];
    return {
      timestamp: String(raw["timestamp"] ?? ""),
      session_id: raw["session_id"] !== undefined ? String(raw["session_id"]) : undefined,
      matches,
      transcript_excerpt:
        raw["transcript_excerpt"] !== undefined ? String(raw["transcript_excerpt"]) : undefined,
    } satisfies RetrospectiveTriggerRecord;
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
 * For retrospective-trigger / ask-routing-deferral / pre-narration records:
 * each entry in `matches[].phrase` is a phrase.
 * For code-mechanism-assertion records: `${symbol}::${predicate}` per claim —
 * the (symbol, predicate) pair is the analog of a "matched phrase" here.
 * For policy-coverage records: `reason` (the action-filter trigger condition)
 * is the diversity axis — there is no matched-phrase concept for this log.
 */
export function extractDistinctPhrases(records: CalibrationRecord[]): Set<string> {
  const phrases = new Set<string>();
  for (const rec of records) {
    if ("matchedPhrases" in rec) {
      for (const p of rec.matchedPhrases) {
        phrases.add(p);
      }
    } else if ("claims" in rec) {
      for (const c of rec.claims) {
        phrases.add(`${c.symbol}::${c.predicate}`);
      }
    } else if ("reason" in rec) {
      phrases.add(rec.reason);
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
  // The review threshold is DIVERSITY-AWARE (spec Success Criterion #3): a log is
  // only "past threshold" — i.e. worth surfacing for review — when it has enough
  // fires AND enough distinct shapes. Ten identical fires are NOT a review signal,
  // they're a uniform pattern; keep collecting until diversity arrives.
  const atCountThreshold = firesSinceLastReview >= FIRES_THRESHOLD;
  const hasDiversity = distinctPhrases >= DIVERSITY_THRESHOLD;
  const pastThreshold = atCountThreshold && hasDiversity;
  // lowDiversity: hit the fire count but not the diversity bar (the "keep
  // collecting" state, distinct from below-count and from past-threshold).
  const lowDiversity = atCountThreshold && !hasDiversity;

  return {
    entry,
    exists,
    totalFires,
    firesSinceLastReview,
    distinctPhrases,
    atCountThreshold,
    lowDiversity,
    pastThreshold,
    // Records are surfaced once the COUNT bar is hit (so a reviewer can see why a
    // log is low-diversity), even though the Ask only fires on pastThreshold.
    newRecords: atCountThreshold ? newRecords : [],
    watermarkCount,
    openAskId: watermark?.openAskId,
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
 * @param askId      - optional ID of the disposition Ask the /calibration-review
 *                     skill just filed covering ALL acked logs in this pass
 *                     (mt#2659). When provided, recorded as `openAskId` on every
 *                     advanced watermark so the cadence detector can suppress its
 *                     per-turn warning in favor of a single pending-ask line
 *                     until the ask is resolved (see `clearResolvedAskIds`).
 *
 *                     When `askId` is NOT provided, any PRE-EXISTING `openAskId`
 *                     on the watermark being advanced is preserved verbatim, NOT
 *                     dropped (mt#2659 review fix). Rebuilding the watermark as a
 *                     fresh object without merging the prior entry would silently
 *                     disable ask-aware suppression on every ordinary `ack:true`
 *                     call that doesn't happen to also carry `askId` — clearing
 *                     `openAskId` must stay the exclusive job of
 *                     `clearResolvedAskIds()`, an explicit, intentional call.
 */
export function advanceWatermarks(
  current: WatermarkStore,
  results: CalibrationLogResult[],
  ackedPaths: Set<string>,
  now: string,
  askId?: string
): WatermarkStore {
  const updated: WatermarkStore = { ...current };
  for (const result of results) {
    if (ackedPaths.has(result.entry.path)) {
      const priorOpenAskId = current[result.entry.path]?.openAskId;
      const nextOpenAskId = askId ?? priorOpenAskId;
      updated[result.entry.path] = {
        lastReviewedCount: result.totalFires,
        lastReviewedAt: now,
        ...(nextOpenAskId ? { openAskId: nextOpenAskId } : {}),
      };
    }
  }
  return updated;
}

/**
 * Clear `openAskId` from any watermark entries whose recorded ask id is in
 * `resolvedAskIds` (mt#2659).
 *
 * Does NOT touch `lastReviewedCount` / `lastReviewedAt` — this is purely the
 * "ask closed → resume normal cadence" transition, used once the
 * /calibration-review skill confirms (via `asks_list`) that a previously-filed
 * disposition ask has reached a terminal state (responded / closed /
 * cancelled / expired). Returns a new store (does not mutate the input); a
 * no-op (returns `current` unchanged, same reference) when `resolvedAskIds`
 * is empty.
 */
export function clearResolvedAskIds(
  current: WatermarkStore,
  resolvedAskIds: ReadonlySet<string>
): WatermarkStore {
  if (resolvedAskIds.size === 0) return current;
  const updated: WatermarkStore = { ...current };
  for (const [path, wm] of Object.entries(current)) {
    if (wm.openAskId && resolvedAskIds.has(wm.openAskId)) {
      const { openAskId: _drop, ...rest } = wm;
      updated[path] = rest;
    }
  }
  return updated;
}

/**
 * Result of `selectAckablePaths` — which past-threshold logs may be advanced
 * (acked) this pass, and which must be skipped.
 */
export interface AckSelection {
  /** Paths safe to advance via `advanceWatermarks`. */
  ackablePaths: Set<string>;
  /**
   * Paths skipped because they carry a still-open disposition ask that this
   * call is not explicitly reaffirming (mt#2659, BLOCKING 2 review fix).
   */
  skippedOpenAskPaths: string[];
}

/**
 * Determine which past-threshold logs may be safely advanced (acked) in this
 * pass, and which must be skipped because they already carry a still-open
 * disposition ask (mt#2659).
 *
 * When `askId` is provided, the caller is explicitly (re)affirming an ask for
 * every past-threshold result this call — ALL are ackable regardless of any
 * pre-existing `openAskId`.
 *
 * When `askId` is NOT provided, any result whose `openAskId` is already set
 * is skipped rather than silently advanced: per the /calibration-review
 * skill's Step 1a, a log with an open disposition ask must not be
 * re-classified or marked reviewed until that ask resolves (via
 * `clearResolvedAskIds`). Advancing its watermark anyway would falsely mark
 * an unreviewed batch of fires as "reviewed" while the operator's decision on
 * an earlier snapshot is still outstanding.
 *
 * Pure — no I/O, no mutation of inputs. This is the command-adapter-facing
 * counterpart to `advanceWatermarks`'s own openAskId-preservation behavior;
 * together they make BOTH halves of "an ack call must never silently lose or
 * misapply ask-aware suppression state" independently testable.
 */
export function selectAckablePaths(
  pastThresholdResults: CalibrationLogResult[],
  askId?: string
): AckSelection {
  const ackablePaths = new Set<string>();
  const skippedOpenAskPaths: string[] = [];
  for (const r of pastThresholdResults) {
    if (!askId && r.openAskId) {
      skippedOpenAskPaths.push(r.entry.path);
      continue;
    }
    ackablePaths.add(r.entry.path);
  }
  return { ackablePaths, skippedOpenAskPaths };
}
