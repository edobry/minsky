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
   * "build-claim-injection"    → record.matchedPhrases: string[] (mt#2923) —
   *   the matched usability/delivery claim phrase(s), same shape family as
   *   causal-premise. `deploySurfaceFiles: string[]` is carried as extra
   *   context (not consulted by diversity/threshold logic).
   * "knowledge-acquisition"    → record.loadedSkills: string[] (mt#2708) —
   *   a per-fire record of in-task research relevant to a loaded skill with
   *   no propagation in the trailing window. NOT a matched-phrase record:
   *   diversity is measured over distinct `loadedSkills` values (declared per
   *   the mt#2708 spec's Graduation contract — a tool-use-pattern detector
   *   has no natural "phrase," and distinct loaded-skill names are more
   *   semantically meaningful than tool names for this detector).
   * "constructed-identifier-batch" → record.matches: {category, phrase, ...}[]
   *   (mt#3125) — same matches-shape family as retrospective-trigger /
   *   ask-routing-deferral / pre-narration (parsed by the shared fallback
   *   branch below, no dedicated `kind === ...` branch needed); `category`
   *   is the `${mintTool}+${consumeTool}` pair label, `phrase` is the
   *   consuming call's free-text excerpt. `mintTool`/`consumeTool`/
   *   `consumeField` are carried as extra context, not consulted here.
   */
  kind:
    | "causal-premise"
    | "retrospective-trigger"
    | "ask-routing-deferral"
    | "code-mechanism-assertion"
    | "pre-narration"
    | "policy-coverage"
    | "silent-stretch"
    | "wall-of-text"
    | "build-claim-injection"
    | "knowledge-acquisition"
    | "constructed-identifier-batch";
  /**
   * Optional per-entry override (mt#2896) for the never-reviewed-aging review
   * trigger: the number of days a NEVER-reviewed log may accumulate fires
   * before `computeReviewDueLogs` flags it review-due (reason "never-reviewed").
   * Omit to use the registry-wide default `NEVER_REVIEWED_DAYS`. A detector that
   * declares a tighter graduation contract (e.g. "dispose at <= 30 days") sets
   * this so the cadence loop can enforce that contract's time leg.
   */
  reviewByDays?: number;
  /**
   * ISO-8601 date the detector was CONFIRMED alive via a live, end-to-end
   * synthetic-input test (dispatcher -> registry -> module -> transcript
   * parse -> detection -> calibration write), as distinct from the date it
   * merely shipped code (mt#3078). Anchors the "never-fired" review-due leg
   * below for a detector whose real-world trigger is a rare COMPOUND
   * condition (e.g. build-claim-injection needs an in-session merge + a
   * chat-only usability claim + zero rebuild evidence, all at once) — such a
   * detector may legitimately accumulate ZERO real fires for a long time
   * without being broken, so `firstRecordTimestamp` (which requires >=1 real
   * record) can never anchor its graduation clock. `liveSinceDate` gives
   * `computeReviewDueLogs` a start date for that clock even at true-zero
   * fires, so "confirmed alive, still silent after N days" surfaces for
   * review instead of being invisible forever (the exact "never matched" vs
   * "never ran" ambiguity mt#3078 was filed to resolve).
   *
   * **Single source of truth / bit-rot guard (PR #2207 R1 review).** This value
   * is data on the registry entry (not a sweep-logic constant) BY DESIGN — the
   * reviewer's registry-as-data intent is already satisfied structurally. The
   * residual risk the review flagged is drift: a hand-typed date is "asserted
   * by code review text," not mechanically reconciled against evidence. Two
   * requirements close that gap: (1) the date MUST be accompanied by an
   * inline comment citing the SPECIFIC, permanent, checkable artifact that
   * proved liveness that day — a merged PR number (e.g. "verified in PR
   * #2207") whose body/task-spec Outcome section carries the actual
   * positive/negative-control transcript, not a bare assertion; (2)
   * `assertLiveSinceDatesAreSane` (below) is run in this module's test suite
   * against the live registry on every test run, so a future entry with a
   * missing citation-comment convention slip is a maintainer-review concern,
   * while an outright bit-rot case (an unparseable date, or one accidentally
   * set in the future — e.g. a copy-paste of a placeholder) is caught
   * mechanically, not just by review.
   */
  liveSinceDate?: string;
}

/**
 * Bit-rot guard for `liveSinceDate` (PR #2207 R1 review — see the field's own
 * doc comment above for the full rationale). Returns the subset of registry
 * entries whose `liveSinceDate` is either unparseable or in the future
 * relative to `nowMs` — both are invariant violations for a field whose whole
 * purpose is "the date we KNOW, in the past, this mechanism was proven alive."
 * A future date can only arise from a typo or a stale copy-paste; there is no
 * legitimate reason for one, so this is a one-directional, permanently-valid
 * check (unlike a "must equal the ship date" check, which would itself rot).
 *
 * Pure — no I/O, injectable `nowMs` for deterministic testing.
 */
export function findInvalidLiveSinceDates(
  entries: readonly CalibrationLogEntry[],
  nowMs: number
): Array<{ name: string; liveSinceDate: string; reason: "unparseable" | "future" }> {
  const invalid: Array<{ name: string; liveSinceDate: string; reason: "unparseable" | "future" }> =
    [];
  for (const entry of entries) {
    if (entry.liveSinceDate === undefined) continue;
    const parsed = Date.parse(entry.liveSinceDate);
    if (Number.isNaN(parsed)) {
      invalid.push({ name: entry.name, liveSinceDate: entry.liveSinceDate, reason: "unparseable" });
      continue;
    }
    if (parsed > nowMs) {
      invalid.push({ name: entry.name, liveSinceDate: entry.liveSinceDate, reason: "future" });
    }
  }
  return invalid;
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
 * V5 entry (mt#2923):
 *   - build-claim-injection-calibration.jsonl (mt#2923 detector, the
 *     mt#2707-RFC build/deploy-claim seam) — a matched-phrase log (same
 *     shape family as causal-premise). Declares `reviewByDays: 30` (the
 *     mt#2896 never-reviewed-aging leg) as its graduation contract.
 *
 * V6 entry (mt#2708):
 *   - knowledge-acquisition-calibration.jsonl (mt#2708 detector, the
 *     mt#2707-RFC (B) proactive-trigger half of the learn-capture primitive)
 *     — NOT a matched-phrase log; diversity is measured over distinct
 *     `loadedSkills` values. Declares `reviewByDays: 14` (deliberately
 *     tighter than mt#2923's 30 — research-tool calls are routine, so the
 *     count/diversity leg should bind first; the time leg is a backstop, not
 *     the primary trigger, per the mt#2708 spec's Graduation contract).
 * V7 entry (mt#3125):
 *   - constructed-identifier-batch-calibration.jsonl (mt#3125 detector) —
 *     the root-tier sibling of pre-narration/mt#2195's family: fires on the
 *     BATCH itself (an id-minting call + an id-consuming call in one
 *     parallel tool-call batch), not a downstream identifier surface.
 *     Matched-phrase shape family (same as retrospective-trigger).
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
  {
    path: ".minsky/build-claim-injection-calibration.jsonl",
    name: "build-claim-injection",
    kind: "build-claim-injection",
    // mt#2923 graduation contract: dispose within 30 days even at low fire
    // volume (per the mt#2923 spec's Planning notes; enforced via the
    // mt#2896 never-reviewed-aging leg in computeReviewDueLogs below).
    reviewByDays: 30,
    // mt#3078: re-anchored from mt#2923's original ship date (2026-07-18,
    // when zero fires had ever been confirmed possible) to the date the
    // detector's full invocation path — dispatcher -> registry -> run() ->
    // transcript parse -> detection -> calibration write — was PROVEN alive
    // via a live synthetic positive/negative-control test. The 30-day clock
    // now starts from a date we KNOW the mechanism could have produced data,
    // not from an unverified ship date.
    //
    // Evidence artifact (PR #2207 R1 review — cite the permanent record, not
    // just this comment): github.com/edobry/minsky/pull/2207 body's "Testing"
    // section + mt#3078 task spec's `## Outcome` §2 carry the actual
    // positive-control (writes a record) / negative-control (writes nothing)
    // transcript this date is derived from. If this date is ever revised,
    // update this citation to the new evidence artifact in the same commit —
    // `findInvalidLiveSinceDates` (above) only catches unparseable/future
    // dates, not a stale-but-still-past one, so the citation convention is
    // the enforcement for that residual case.
    liveSinceDate: "2026-07-23",
  },
  {
    path: ".minsky/knowledge-acquisition-calibration.jsonl",
    name: "knowledge-acquisition",
    kind: "knowledge-acquisition",
    // mt#2708 graduation contract: dispose within 14 days — deliberately
    // NOT mt#2923's 30. Research-tool calls are routine (unlike mt#2923's
    // rare compound merge+claim trigger), so the count/diversity leg should
    // bind first; the time leg here is a backstop, grounded in the existing
    // STALE_DAYS_MS re-warn bar (10 days) plus operational slack for
    // /calibration-review to actually run.
    reviewByDays: 14,
    // mt#2708: re-anchored to the date the detector's full invocation path —
    // dispatcher -> registry -> run() -> transcript parse -> detection ->
    // calibration write — was PROVEN alive via a live synthetic
    // positive/negative-control test (mt#3078 re-anchoring precedent).
    //
    // Evidence artifact (mt#3078 precedent — cite the permanent record, not
    // just this comment): this task's (mt#2708) PR body's "Testing" section
    // carries the actual positive-control (writes a record) / negative-
    // control (writes nothing) transcript this date is derived from.
    liveSinceDate: "2026-07-23",
  },
  {
    path: ".minsky/constructed-identifier-batch-calibration.jsonl",
    name: "constructed-identifier-batch",
    kind: "constructed-identifier-batch",
  },
  {
    path: ".minsky/untaken-action-calibration.jsonl",
    name: "untaken-action",
    // mt#3179 — turn-end-untaken-action-scan emits `matches: {family, phrase}[]`,
    // byte-identical to the retrospective-trigger record shape, so it reuses that
    // parser KIND rather than widening the union (and every switch over it) for a
    // shape that already exists. `name` is what distinguishes the two logs.
    //
    // Appended LAST deliberately: calibration-sweep.test.ts pins each entry by
    // ARRAY INDEX, so inserting mid-array silently shifts every later assertion
    // (caught by the pre-push gate when this entry first went in at position 2).
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
 * meaningful. The threshold is diversity-aware: when fires >= FIRES_THRESHOLD AND
 * distinctPhrases < DIVERSITY_THRESHOLD, `pastThreshold` is FALSE (a uniform
 * pattern is not yet a review signal) and the report sets `lowDiversity` so the
 * operator knows the count bar was hit but the sample is pattern-concentrated —
 * the "keep collecting" state.
 */
export const DIVERSITY_THRESHOLD = 3;

/**
 * Time-based staleness bar for a REVIEWED log with new-but-below-count-bar
 * fires (moved here from `calibration-review-cadence-detector.ts` by mt#2896 so
 * every cadence constant lives in ONE place alongside FIRES_THRESHOLD /
 * DIVERSITY_THRESHOLD). Grounded in CLAUDE.md `decision-defaults.mdc
 * §Thresholds` — "10 days for lynchpin tracking" is the nearest anchor; a
 * calibration log with unreviewed new fires is a "tracking" concern (watching
 * detector calibration drift), not active in-flight work (which uses the
 * tighter 5-day bar).
 */
export const STALE_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Default number of days a NEVER-reviewed log may accumulate fires before it is
 * flagged review-due (mt#2896's third trigger leg, reason "never-reviewed").
 * Closes the "under-threshold-forever" blind spot: a low-volume log that has
 * never been reviewed and accrues fires slowly satisfies NEITHER `pastThreshold`
 * (needs count + diversity) NOR the time-stale leg (needs an existing
 * watermark), so absent this leg it stays invisible to the review loop forever
 * (causal-premise sat at 1 fire for ~6 weeks — mt#2832 audit).
 *
 * 30 = 3x the existing 10-day STALE_DAYS bar. Provisional per
 * `decision-defaults.mdc §Thresholds` (ground in observed cadence, not a round
 * number) until calibration data grounds it; overridable per-entry via
 * `CalibrationLogEntry.reviewByDays` so a detector can declare a tighter
 * graduation contract (the learn-capture detector, mt#2708, will declare 30).
 */
export const NEVER_REVIEWED_DAYS = 30;
export const NEVER_REVIEWED_DAYS_MS = NEVER_REVIEWED_DAYS * 24 * 60 * 60 * 1000;

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

/**
 * Parsed build-claim-injection calibration record (mt#2923).
 *
 * Same matched-phrase shape family as `CausalPremiseRecord` — the matched
 * usability/delivery claim phrase(s) go in `matchedPhrases`.
 * `deploySurfaceFiles` is carried as extra context (the deploy/build-surface
 * paths edited in the session) and is not consulted by diversity/threshold
 * logic. Mirrors the exact fields the detector writes in
 * `.minsky/hooks/build-claim-injection-detector.ts`.
 */
export interface BuildClaimInjectionRecord {
  timestamp: string;
  session_id?: string;
  matchedPhrases: string[];
  deploySurfaceFiles: string[];
}

/**
 * Parsed knowledge-acquisition calibration record (mt#2708).
 *
 * NOT a matched-phrase record — a per-fire record of in-task research
 * relevant to a loaded skill with no propagation in the trailing window.
 * `loadedSkills` is the diversity axis (see `extractDistinctPhrases` below).
 * Mirrors the exact fields `.minsky/hooks/knowledge-acquisition-detector.ts`
 * appends (`detectionRung`/`researchTools`/`loadedSkills`/`hadPropagation`
 * are the spec-required fields; `matchedSkill`/`matchedKeyword`/`dedupeKey`
 * are additional bookkeeping fields the parser ignores).
 */
export interface KnowledgeAcquisitionRecord {
  timestamp: string;
  session_id?: string;
  detectionRung: string;
  researchTools: string[];
  loadedSkills: string[];
  hadPropagation: boolean;
}

/** Union of all record types. */
export type CalibrationRecord =
  | CausalPremiseRecord
  | RetrospectiveTriggerRecord
  | CodeMechanismAssertionRecord
  | PolicyCoverageRecord
  | SilentStretchRecord
  | WallOfTextRecord
  | BuildClaimInjectionRecord
  | KnowledgeAcquisitionRecord;

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
  /**
   * ISO-8601 timestamp of the EARLIEST record in the log (mt#2896), or undefined
   * when the log is empty/absent. Threaded through so `computeReviewDueLogs`'s
   * never-reviewed-aging leg can measure days-since-first-fire for a log that
   * has no watermark to date from.
   */
  firstRecordTimestamp?: string;
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

    if (kind === "build-claim-injection") {
      // Shape: { timestamp, session_id?, matchedPhrases: string[], deploySurfaceFiles: string[] }
      // Mirrors the exact record `.minsky/hooks/build-claim-injection-detector.ts`
      // appends (mt#2923). Same matched-phrase shape family as causal-premise.
      if (!Array.isArray(raw["matchedPhrases"])) return null;
      return {
        timestamp: String(raw["timestamp"] ?? ""),
        session_id: raw["session_id"] !== undefined ? String(raw["session_id"]) : undefined,
        matchedPhrases: (raw["matchedPhrases"] as unknown[]).map(String),
        deploySurfaceFiles: Array.isArray(raw["deploySurfaceFiles"])
          ? (raw["deploySurfaceFiles"] as unknown[]).map(String)
          : [],
      } satisfies BuildClaimInjectionRecord;
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

    if (kind === "knowledge-acquisition") {
      // Shape: { timestamp, session_id?, detectionRung, researchTools: string[],
      //          loadedSkills: string[], hadPropagation: boolean, ... }
      // Mirrors the exact record `.minsky/hooks/knowledge-acquisition-detector.ts`
      // appends (mt#2708). Not a matched-phrase record — `loadedSkills` is the
      // diversity axis (see extractDistinctPhrases).
      if (!Array.isArray(raw["loadedSkills"])) return null;
      return {
        timestamp: String(raw["timestamp"] ?? ""),
        session_id: raw["session_id"] !== undefined ? String(raw["session_id"]) : undefined,
        detectionRung: String(raw["detectionRung"] ?? ""),
        researchTools: Array.isArray(raw["researchTools"])
          ? (raw["researchTools"] as unknown[]).map(String)
          : [],
        loadedSkills: (raw["loadedSkills"] as unknown[]).map(String),
        hadPropagation: Boolean(raw["hadPropagation"]),
      } satisfies KnowledgeAcquisitionRecord;
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
    } else if ("loadedSkills" in rec) {
      // knowledge-acquisition (mt#2708): diversity axis = distinct loaded-
      // skill names, not matched phrases or a session/conversation id —
      // declared per the spec's Graduation contract. Without this axis the
      // log could sit `lowDiversity` forever (the mt#2896
      // under-threshold-forever trap, reopened here on the diversity axis
      // rather than the count axis mt#2896 originally closed).
      for (const skill of rec.loadedSkills) {
        phrases.add(skill);
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
    // Calibration logs are APPEND-ONLY (records appended as events fire, never
    // reordered), so the first record IS the earliest — mt#2896 review NB1. A
    // naive chronological min would be LESS safe here: a later record with an
    // empty/malformed timestamp (parseCalibrationRecord tolerates `""`) would
    // poison the min and silently disable the never-reviewed leg.
    firstRecordTimestamp: allRecords[0]?.timestamp,
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

// ---------------------------------------------------------------------------
// Review-due determination (mt#2896)
// ---------------------------------------------------------------------------
//
// Moved here from `.minsky/hooks/calibration-review-cadence-detector.ts` so
// BOTH the cadence hook AND the `observability.calibration-review` command
// consume ONE source of truth for "which logs are review-due." Previously the
// command reported only per-log `pastThreshold` while the never-reviewed /
// time-stale legs lived hook-only, so `observability_calibration-review` could
// never surface a time-based review-due log (mt#2896 acceptance test #2).

/** A calibration log flagged as review-due, tagged with the leg that flagged it. */
export interface ReviewDueLog {
  name: string;
  path: string;
  /** Registry kind (mt#2659) — drives the fire-count-vs-time-only re-warn split in the hook's `shouldReWarn`. */
  kind: CalibrationLogEntry["kind"];
  firesSinceLastReview: number;
  totalFires: number;
  distinctPhrases: number;
  reason: "past-threshold" | "time-stale" | "never-reviewed" | "never-fired";
  /** Forwarded from the watermark's `openAskId` (mt#2659); undefined for never-reviewed (no watermark). */
  openAskId?: string;
  /**
   * For the never-reviewed AND never-fired legs (mt#2896 review; never-fired
   * added mt#3078): the EFFECTIVE review-by window in days used for this
   * log's decision (per-entry `reviewByDays`, else `NEVER_REVIEWED_DAYS`).
   * Undefined for past-threshold / time-stale. Lets the cadence warning name
   * the log's ACTUAL window instead of the hardcoded default (which would
   * misreport an overridden entry) — see the never-fired branch in
   * `computeReviewDueLogs` below, which populates this field identically to
   * the never-reviewed branch.
   */
  reviewByDays?: number;
}

function toReviewDueLog(
  r: CalibrationLogResult,
  reason: ReviewDueLog["reason"],
  openAskId: string | undefined,
  reviewByDays?: number
): ReviewDueLog {
  return {
    name: r.entry.name,
    path: r.entry.path,
    kind: r.entry.kind,
    firesSinceLastReview: r.firesSinceLastReview,
    totalFires: r.totalFires,
    distinctPhrases: r.distinctPhrases,
    reason,
    openAskId,
    reviewByDays,
  };
}

/**
 * Determine which logs are review-due, per FOUR independent conditions:
 *   1. past-threshold — fires-since-review >= FIRES_THRESHOLD AND
 *      distinctPhrases >= DIVERSITY_THRESHOLD (the diversity-aware count bar).
 *   2. time-stale     — the log HAS a watermark (reviewed before), has >= 1 new
 *      fire since, AND that review is >= `staleMs` old.
 *   3. never-reviewed — the log has NO watermark (never reviewed, ever), has
 *      >= 1 fire, AND its EARLIEST fire is >= the log's review-by window old
 *      (per-entry `reviewByDays`, else `NEVER_REVIEWED_DAYS`). mt#2896 — closes
 *      the "under-threshold-forever" blind spot where a slow, low-volume log
 *      satisfied neither (1) (needs diversity) nor (2) (needs a watermark).
 *   4. never-fired    — the log has NO watermark AND ZERO total fires (no
 *      `firstRecordTimestamp` to anchor leg 3 from), but its registry entry
 *      declares `liveSinceDate` (the date a live synthetic test confirmed the
 *      invocation path works) that is >= the review-by window old. mt#3078 —
 *      closes the residual blind spot leg 3 still has: a detector confirmed
 *      alive whose real-world trigger is a genuinely rare compound condition
 *      can sit at zero fires indefinitely, which is otherwise indistinguishable
 *      from "silently broken" until a human happens to check.
 *
 * Pure over already-computed sweep results + the watermark store. `nowMs` and
 * both windows are injected for deterministic testing.
 */
export function computeReviewDueLogs(
  results: CalibrationLogResult[],
  watermarks: WatermarkStore,
  nowMs: number,
  staleMs: number = STALE_DAYS_MS,
  neverReviewedMsDefault: number = NEVER_REVIEWED_DAYS_MS
): ReviewDueLog[] {
  const due: ReviewDueLog[] = [];
  for (const r of results) {
    const wm = watermarks[r.entry.path];

    if (r.pastThreshold) {
      due.push(toReviewDueLog(r, "past-threshold", wm?.openAskId));
      continue;
    }

    // never-reviewed-aging (mt#2896): no watermark at all, but the log has been
    // accumulating fires since its first record for longer than its review-by
    // window. Dates from the earliest record's timestamp (there is no watermark
    // to date from here).
    if (!wm) {
      if (r.totalFires <= 0) {
        // never-fired (mt#3078): a detector with TRUE-ZERO fires (not just
        // "no watermark yet") has no `firstRecordTimestamp` to anchor from,
        // so the never-reviewed leg above would bail forever — silently
        // indistinguishable from "confirmed broken" for as long as its rare
        // compound trigger stays unmet. `liveSinceDate` (set once a live
        // synthetic test proves the invocation path works) gives this case
        // its own anchor so a confirmed-alive-but-silent detector still
        // surfaces after its review-by window, instead of never at all.
        const entryLiveSince = r.entry.liveSinceDate;
        if (!entryLiveSince) continue;
        const liveSinceMs = Date.parse(entryLiveSince);
        if (Number.isNaN(liveSinceMs)) continue;
        const windowMs =
          r.entry.reviewByDays !== undefined
            ? r.entry.reviewByDays * 24 * 60 * 60 * 1000
            : neverReviewedMsDefault;
        if (nowMs - liveSinceMs >= windowMs) {
          const windowDays = Math.round(windowMs / (24 * 60 * 60 * 1000));
          due.push(toReviewDueLog(r, "never-fired", undefined, windowDays));
        }
        continue;
      }
      if (!r.firstRecordTimestamp) continue;
      const firstMs = Date.parse(r.firstRecordTimestamp);
      if (Number.isNaN(firstMs)) continue;
      const windowMs =
        r.entry.reviewByDays !== undefined
          ? r.entry.reviewByDays * 24 * 60 * 60 * 1000
          : neverReviewedMsDefault;
      if (nowMs - firstMs >= windowMs) {
        const windowDays = Math.round(windowMs / (24 * 60 * 60 * 1000));
        due.push(toReviewDueLog(r, "never-reviewed", undefined, windowDays));
      }
      continue;
    }

    // time-stale: reviewed before, >= 1 new fire, review is >= staleMs old. A
    // reviewed log that hasn't accrued a new fire is "keep collecting," not
    // "forgotten."
    if (r.firesSinceLastReview <= 0) continue;
    const reviewedMs = Date.parse(wm.lastReviewedAt);
    if (Number.isNaN(reviewedMs)) continue;
    if (nowMs - reviewedMs >= staleMs) {
      due.push(toReviewDueLog(r, "time-stale", wm.openAskId));
    }
  }
  return due;
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
  "build-claim-injection": "build-claim-injection-detector",
  "knowledge-acquisition": "knowledge-acquisition-detector",
  "constructed-identifier-batch": "constructed-identifier-batch-detector",
  "untaken-action": "turn-end-untaken-action-scan",
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
