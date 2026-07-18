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
   * "silent-stretch"           → record.{gapMinutes, toolCallCount, hadTextInTurn?}
   *   (mt#2824 detector, registered mt#2866) — a per-turn heartbeat-cadence
   *   measurement, NOT a matched-phrase record. Diversity is measured over
   *   distinct `session_id` (conversation) values instead of distinct
   *   phrases — the signal is "how many different conversations hit the
   *   cadence threshold," mirroring policy-coverage's non-phrase axis.
   */
  kind:
    | "causal-premise"
    | "retrospective-trigger"
    | "ask-routing-deferral"
    | "code-mechanism-assertion"
    | "pre-narration"
    | "policy-coverage"
    | "silent-stretch"
    | "wall-of-text";
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
 * V3 entry (mt#2866):
 *   - silent-stretch-calibration.jsonl (mt#2824 detector) — NOTE: like
 *     policy-coverage, this is NOT a matched-phrase log. It is a per-turn
 *     heartbeat-cadence measurement (gapMinutes/toolCallCount); diversity is
 *     measured over distinct `session_id` (conversation) values. mt#2824
 *     shipped the detector but consciously descoped wiring it into this
 *     registry (see that task's PR body); this entry closes that gap.
 *
 * V4 entry (mt#2870):
 *   - wall-of-text-calibration.jsonl (mt#2870 detector) — the over-signaling
 *     sibling of silent-stretch. Also NOT a matched-phrase log: a per-turn
 *     report-shape measurement (wordCount/trigger/leadLabelHits); diversity
 *     is measured over distinct `session_id` values, like silent-stretch.
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
  {
    path: ".minsky/silent-stretch-calibration.jsonl",
    name: "silent-stretch",
    kind: "silent-stretch",
  },
  {
    path: ".minsky/wall-of-text-calibration.jsonl",
    name: "wall-of-text",
    kind: "wall-of-text",
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

/**
 * Parsed silent-stretch calibration record (mt#2824 detector, registered mt#2866).
 *
 * Unlike the phrase/claims-shaped records, this is a per-turn heartbeat-cadence
 * measurement — no matched-phrase concept exists. Diversity is measured over
 * distinct `session_id` values (how many different conversations crossed the
 * cadence threshold), mirroring `PolicyCoverageRecord`'s non-phrase diversity
 * axis (`reason`). Mirrors the exact fields the detector writes in
 * `.minsky/hooks/silent-stretch-detector.ts` (`appendCalibrationRecord` call).
 */
export interface SilentStretchRecord {
  timestamp: string;
  session_id?: string;
  gapMinutes: number;
  toolCallCount: number;
  hadTextInTurn?: boolean;
}

/**
 * Parsed wall-of-text calibration record (mt#2870 detector).
 *
 * Like SilentStretchRecord, a per-turn measurement with no matched-phrase
 * concept — diversity is measured over distinct `session_id` values. Mirrors
 * the exact fields the detector writes in
 * `.minsky/hooks/wall-of-text-detector.ts` (`buildCalibrationRecord`).
 */
export interface WallOfTextRecord {
  timestamp: string;
  session_id?: string;
  wordCount: number;
  lineCount: number;
  trigger: string;
  leadLabelHits?: string[];
  deeplinkCount?: number;
  namedRefCount?: number;
}

/** Union of all record types. */
export type CalibrationRecord =
  | CausalPremiseRecord
  | RetrospectiveTriggerRecord
  | CodeMechanismAssertionRecord
  | PolicyCoverageRecord
  | SilentStretchRecord
  | WallOfTextRecord;

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

    if (kind === "silent-stretch") {
      // Shape: { timestamp, session_id?, gapMinutes: number, toolCallCount: number, hadTextInTurn?: boolean }
      // Mirrors the exact record `.minsky/hooks/silent-stretch-detector.ts`
      // appends (mt#2824). Not a matched-phrase record — no `matches`/`claims`
      // field.
      if (typeof raw["gapMinutes"] !== "number" || typeof raw["toolCallCount"] !== "number") {
        return null;
      }
      return {
        timestamp: String(raw["timestamp"] ?? ""),
        session_id: raw["session_id"] !== undefined ? String(raw["session_id"]) : undefined,
        gapMinutes: raw["gapMinutes"],
        toolCallCount: raw["toolCallCount"],
        hadTextInTurn:
          raw["hadTextInTurn"] !== undefined ? Boolean(raw["hadTextInTurn"]) : undefined,
      } satisfies SilentStretchRecord;
    }

    if (kind === "wall-of-text") {
      // Shape: { timestamp, session_id?, wordCount: number, lineCount: number,
      //          trigger: string, leadLabelHits?: string[], deeplinkCount?, namedRefCount? }
      // Mirrors the exact record `.minsky/hooks/wall-of-text-detector.ts`
      // writes (mt#2870). Not a matched-phrase record.
      if (typeof raw["wordCount"] !== "number" || typeof raw["trigger"] !== "string") {
        return null;
      }
      return {
        timestamp: String(raw["timestamp"] ?? ""),
        session_id: raw["session_id"] !== undefined ? String(raw["session_id"]) : undefined,
        wordCount: raw["wordCount"],
        lineCount: typeof raw["lineCount"] === "number" ? raw["lineCount"] : 0,
        trigger: raw["trigger"],
        leadLabelHits: Array.isArray(raw["leadLabelHits"])
          ? (raw["leadLabelHits"] as unknown[]).map(String)
          : undefined,
        deeplinkCount: typeof raw["deeplinkCount"] === "number" ? raw["deeplinkCount"] : undefined,
        namedRefCount: typeof raw["namedRefCount"] === "number" ? raw["namedRefCount"] : undefined,
      } satisfies WallOfTextRecord;
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
 * Fallback label for a silent-stretch record with no `session_id` (mt#2866).
 * Exported so every surface that renders/aggregates a silent-stretch record's
 * conversation identity (this module's `extractDistinctPhrases` AND
 * `src/adapters/shared/commands/calibration.ts`'s `formatResult`) uses the
 * exact same fallback string — avoids the two surfaces silently drifting
 * apart (PR #2004 R1 review finding).
 */
export const UNKNOWN_SILENT_STRETCH_SESSION_LABEL = "unknown-session";

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
    } else if ("gapMinutes" in rec) {
      // silent-stretch: diversity axis is distinct conversations (session_id),
      // not phrases — mirrors the policy-coverage `reason` axis above.
      phrases.add(rec.session_id ?? UNKNOWN_SILENT_STRETCH_SESSION_LABEL);
    } else if ("wordCount" in rec) {
      // wall-of-text (mt#2870): same distinct-conversation diversity axis as
      // silent-stretch; the fallback label's VALUE is the shared generic
      // "unknown-session" string.
      phrases.add(rec.session_id ?? UNKNOWN_SILENT_STRETCH_SESSION_LABEL);
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

// ---------------------------------------------------------------------------
// Fire-log schema adapter (mt#2889 — evaluation-loop Phase 1 completion)
// ---------------------------------------------------------------------------
//
// The 6 legacy `.minsky/*-calibration.jsonl` logs (this module's own
// CALIBRATION_LOG_REGISTRY) predate the shared fire-log schema
// (`.minsky/hooks/fire-log.ts`'s `FireLogEntry`, mt#2597). This is a
// READ-SIDE-ONLY adapter: it maps each parsed CalibrationRecord to a
// fire-log-schema-shaped view so the calibration corpus can be aggregated
// alongside the dispatcher/pre-commit fire-log for the evaluation-loop RFC's
// Phase-1 GATE check ("logs exist for all instrumented guards AND >=2 guards
// show >=5 fires"), WITHOUT rewriting, moving, or otherwise touching the
// historical .jsonl files themselves (mt#2889 scope guard: "do NOT
// move/rewrite historical files").
//
// This module does NOT import `.minsky/hooks/fire-log.ts`'s `FireLogEntry`
// type directly. `.minsky/hooks/` is a dependency-free tree per its own
// SPEC.md invariant (no `packages/domain`/`src` imports, so it keeps working
// even when the main codebase has type errors) — there is no established
// precedent for reaching across that boundary in EITHER direction beyond
// duplicating the shape. `src/hooks/pre-commit-fire-log.ts` follows the same
// pattern (its own `PreCommitFireLogEntry` mirrors the hook-runtime schema
// structurally rather than importing it) — this adapter mirrors that
// precedent rather than introducing a new cross-tree coupling.
//
// @see mt#2889 — this task
// @see .minsky/hooks/fire-log.ts — the canonical FireLogEntry schema this mirrors
// @see docs/architecture/evaluation-loop-fire-log.md — Known gaps section (this adapter's owner note)

/** The fire-log schema's tri-state decision axis (mirrors `FireLogDecision` in `.minsky/hooks/fire-log.ts`). */
export type FireLogDecision = "allow" | "warn" | "deny";

/**
 * Fire-log-schema-shaped view of ONE legacy calibration record. Structurally
 * mirrors `.minsky/hooks/fire-log.ts`'s `FireLogEntry` — see the module
 * comment above for why this is a parallel declaration, not a cross-tree
 * import.
 */
export interface CalibrationAsFireLogEntry {
  timestamp: string;
  guardName: string;
  /** Distinguishes an adapted legacy-calibration record from a real dispatcher/pre-commit fire. */
  event: "Calibration";
  decision: FireLogDecision;
  /** Legacy calibration records never captured per-fire timing — always 0. */
  durationMs: 0;
  sessionId?: string;
}

/**
 * Maps a `CalibrationLogEntry.name` (the calibration-log registry key, e.g.
 * `"causal-premise"`) to the canonical fire-log `guardName` the SAME
 * detector uses when instrumented via the dispatcher
 * (`.minsky/hooks/registry.ts`'s `GUARD_REGISTRY` entries' `name` field) —
 * so aggregating the dispatcher fire-log alongside this adapter's output
 * merges cleanly under ONE guard identifier instead of splitting one
 * detector's fire history across two different id strings.
 *
 * Hand-maintained (same duplication-over-cross-import precedent as
 * `.minsky/hooks/known-override-env-vars.ts`): this module cannot import
 * `.minsky/hooks/registry.ts` (dependency-free tree, see above), and even if
 * it could, the registry doesn't reverse-index calibrationLog name -> guard
 * name today. `"policy-coverage"` maps to `"policy-coverage-detector"`, a
 * STANDALONE guard (not GUARD_REGISTRY-registered as of this landing) — see
 * `docs/architecture/evaluation-loop-fire-log.md`'s "Known gaps" section.
 *
 * MUST have one entry per `CALIBRATION_LOG_REGISTRY` entry's `name` — a
 * missing entry silently falls back to `entry.name` in
 * `calibrationRecordToFireLogEntry` (below), splitting that guard's fire
 * history across two different id strings instead of failing loudly. The
 * "every registry name has an explicit mapping" test in
 * `calibration-sweep.test.ts` exists specifically to catch a repeat of this
 * (mt#2889 PR #2012 R1: `CALIBRATION_LOG_REGISTRY` gained a 7th entry,
 * `"silent-stretch"` (mt#2866), via this PR's pre-merge rebase onto main —
 * landing AFTER this map was first written, so the map fell out of sync
 * with the registry it must exhaustively cover).
 */
const CALIBRATION_NAME_TO_GUARD_NAME: Readonly<Record<string, string>> = {
  "causal-premise": "causal-premise-detector",
  "retrospective-trigger": "retrospective-trigger-scanner",
  "ask-routing-deferral": "ask-routing-deferral-detector",
  "code-mechanism-assertion": "code-mechanism-assertion-detector",
  "pre-narration": "pre-narration-detector",
  "policy-coverage": "policy-coverage-detector",
  "silent-stretch": "silent-stretch-detector",
  "wall-of-text": "wall-of-text-detector",
};

/**
 * Map ONE legacy calibration record to the fire-log schema's decision axis.
 *
 * Every one of the 5 matched-phrase detector logs (causal-premise,
 * retrospective-trigger, ask-routing-deferral, code-mechanism-assertion,
 * pre-narration) is calibration-first / informational-only — `denyCapable:
 * false` on every corresponding `GUARD_REGISTRY` entry (registry.ts). A
 * logged record IS the detector firing its one and only outcome, which maps
 * to `"warn"`: never `"deny"` (these detectors never block), and never
 * `"allow"` (the log only ever contains FIRED/matched records — a
 * non-match is never logged at all, so there is no "allow" case to
 * represent here).
 *
 * `policy-coverage` is the one log with a genuine per-record decision axis
 * (mt#1575's `outcome` field, covering every Edit/Write/NotebookEdit — not
 * just fires) and is mapped explicitly: `"uncovered-blocked"` -> `"deny"`,
 * `"uncovered-logged"` -> `"warn"`, `"covered"`/`"dismissed"` -> `"allow"`.
 */
function decisionForRecord(
  record: CalibrationRecord,
  kind: CalibrationLogEntry["kind"]
): FireLogDecision {
  if (kind === "policy-coverage" && "outcome" in record) {
    if (record.outcome === "uncovered-blocked") return "deny";
    if (record.outcome === "uncovered-logged") return "warn";
    // "covered" / "dismissed" — no coverage gap flagged, or the operator
    // explicitly dismissed the warning; both resolve to allow.
    return "allow";
  }
  return "warn";
}

/** Map ONE legacy calibration record to a fire-log-schema-shaped entry. */
export function calibrationRecordToFireLogEntry(
  record: CalibrationRecord,
  entry: CalibrationLogEntry
): CalibrationAsFireLogEntry {
  return {
    timestamp: record.timestamp,
    guardName: CALIBRATION_NAME_TO_GUARD_NAME[entry.name] ?? entry.name,
    event: "Calibration",
    decision: decisionForRecord(record, entry.kind),
    durationMs: 0,
    ...(record.session_id ? { sessionId: record.session_id } : {}),
  };
}

/** Map every parsed record in one legacy calibration log to fire-log-schema entries. */
export function calibrationLogAsFireLogEntries(
  records: readonly CalibrationRecord[],
  entry: CalibrationLogEntry
): CalibrationAsFireLogEntry[] {
  return records.map((r) => calibrationRecordToFireLogEntry(r, entry));
}

/**
 * Read-side aggregate: parse EVERY registered legacy calibration log's raw
 * content and surface ALL records through the shared fire-log schema — the
 * cross-log view the RFC's Phase-1 GATE check consults alongside the real
 * dispatcher/pre-commit fire-log (`~/.local/state/minsky/fire-log.jsonl`).
 * Read-only (never touches the historical files); `readContent` mirrors
 * `runSweep`'s injected reader so this composes with the same I/O seam and
 * the same test-without-touching-the-filesystem discipline.
 */
export async function readAllCalibrationLogsAsFireLogEntries(
  entries: CalibrationLogEntry[],
  readContent: (path: string) => Promise<string | null>
): Promise<CalibrationAsFireLogEntry[]> {
  const all: CalibrationAsFireLogEntry[] = [];
  for (const entry of entries) {
    const content = await readContent(entry.path);
    if (content === null) continue;
    const records = parseCalibrationLines(content, entry.kind);
    all.push(...calibrationLogAsFireLogEntries(records, entry));
  }
  return all;
}
