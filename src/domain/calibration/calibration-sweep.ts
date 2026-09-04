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

// The one import this module carries: hashing the review receipt (mt#3906) is
// pure computation, not I/O, so it does not break the module's testability
// contract above.
import { createHash } from "node:crypto";

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
  /**
   * Repo-relative path to the JSONL log file — as a NAME, not a resolvable
   * filesystem path. **The value stays repo-relative deliberately (mt#4748
   * R1)**: `.minsky/hooks/dispatcher.ts`'s `calibrationLogPath` — the actual
   * write path every value here mirrors — moved from
   * `.minsky/<name>-calibration.jsonl` (repo-rooted) to a project-keyed
   * subdirectory of the state dir
   * (`getMinskyStateDir()/projects/<key>/<name>-calibration.jsonl`), where
   * `<key>` is a hash of the repo root — a value this static registry has no
   * way to embed. Every reader translates this field at CONSUMPTION time
   * instead: strip the `.minsky/` prefix, then re-root under
   * `getMinskyStateDir()/projects/<key of the caller's own repo root>/`. Do
   * NOT flip this field to an absolute path — `path.join` does not restart
   * at an absolute second segment the way `path.resolve` does, so any
   * consumer still doing `join(workspacePath, relPath)` would silently
   * mis-resolve rather than error.
   *
   * **Three consumers, all migrated in the same change (mt#4748 R1; the
   * initial PR wrongly named ONE and called the other two an open follow-up
   * — corrected here after reviewer-caught omission):**
   * `src/adapters/shared/commands/calibration.ts`'s `readContent` closure,
   * and `.minsky/hooks/calibration-review-cadence-detector.ts`'s two
   * (functionally identical) `readContent` closures in `run()` and
   * `main()`. Each duplicates the state-dir/project-key translation locally
   * rather than importing a shared helper — the established convention in
   * this migration (see `projectStateKey` in `dispatcher.ts` /
   * `ingest-runtime.ts` / `coverage-receipt.ts`): every module tree stays
   * free of a dependency on the others.
   */
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
   * "pre-narration"            → record.matches: {category, phrase, context, ...}[] (mt#2197) —
   *   same matches-shape family as retrospective-trigger/ask-routing-deferral;
   *   the per-match label key is `category`. `context` (mt#3198) is the
   *   containing sentence — the field that makes a fire classifiable, since
   *   `phrase` alone cannot separate a claim ("I merged the PR") from a
   *   reference ("the merged PR touches X").
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
   * "operator-deferral"        → record.matches: {category, phrase}[] (mt#2459) —
   *   same matches-shape family as pre-narration / constructed-identifier-batch
   *   (parsed by the shared fallback branch below); `category` is the surface
   *   (`capability-deferral-prose` | `ask-option-label`), `phrase` is the
   *   matched excerpt. BOTH of the detector's surfaces write to this one log —
   *   they are two detection surfaces on ONE failure family, so measuring them
   *   together is what the graduation decision needs.
   * "untaken-action"           → record.matches: {family, phrase}[] (mt#3179) —
   *   same matches-shape family as retrospective-trigger (parsed by the shared
   *   fallback branch below); `family` is the commitment pattern that matched
   *   (e.g. `taking-forward`), `phrase` is the matched excerpt. Given its OWN
   *   kind rather than reusing "retrospective-trigger" because the registry
   *   invariant (PR #2263 R1) requires kind values to be unique per entry —
   *   that uniqueness is what keeps the fire-log guard-name mapping 1:1.
   * "stop-at-decision"         → record.targets: {taskId, status}[] (mt#3653) —
   *   the turn-end stop-at-decision scan (family:stop-at-handoff R5). NOT a
   *   matched-phrase record: diversity is measured over distinct target task
   *   ids — the signal is "how many different decision-owning tasks got
   *   silently stopped at," mirroring knowledge-acquisition's non-phrase axis.
   *
   * mt#3716 — ten kinds added for logs that were declared (on one of the three
   * declaration surfaces — see `deriveCalibrationLogEntries` below) but never
   * visited by `runSweep`, because nothing outside this file's hand-maintained
   * `CALIBRATION_LOG_REGISTRY` could add an entry for them. Each parses via the
   * shared "matches"-shape fallback branch below (no dedicated `kind === ...`
   * case) — the fallback never returns `null`, so every line still produces a
   * record even where the raw shape carries no `family`/`phrase` keys; in that
   * case the record's real fields ride through as `detectorFields` instead of
   * populating `matches[].phrase`, which means the diversity signal
   * (`extractDistinctPhrases`) reads as low/flat for these logs until a
   * dedicated branch or a diversity-signal declaration (mt#3789, the sibling
   * ADR-028 §D4 half) gives them a real axis. That is a review-QUALITY gap,
   * not a reachability gap — SC4's bar ("no log silently parsing to zero
   * records") is met by the fallback alone.
   *   "bare-prohibition"              → matches: {category, phrase, excerpt, hasBasis}[]
   *     (mem#702 / mt#3162 `warn-bare-prohibition-dispatch.ts`) — already
   *     matches-shaped (`category` is the recognized label key), so this one
   *     gets a real diversity signal from the fallback with no changes needed.
   *   "execution-evidence-at-coverage" → {timestamp, task, prNumber, surface,
   *     captureSchema, judgedPrBody, ...} (mt#3033 `require-execution-evidence-before-merge.ts`'s
   *     `appendAtCoverageCalibration`) — a "judged input capture" shape, no
   *     `matches` array at all; falls through with `matches: []`.
   *   "execution-evidence-test-first" → {timestamp, task, prNumber, decision,
   *     captureSchema, prTitle, judgedPrBody, judgedSpec, modifiedTestFiles, ...}
   *     (mt#3244 `test-first-evidence.ts`) — same capture-shape family as
   *     execution-evidence-at-coverage; no `matches` array.
   *   "execution-evidence-render-path" → {timestamp, task, prNumber, surface,
   *     captureSchema, judgedPrBody, renderPathFiles: string[], hasTests}
   *     (mt#2421 `render-path-evidence.ts`) — same capture-shape family; no
   *     `matches` array. Declared here by mt#4064, which found it undeclared on
   *     every surface: the log existed with 14 fires in 7d and no sweep visited it.
   *   "execution-evidence-sc-coverage" → {timestamp, task, prNumber, surface,
   *     captureSchema, judgedPrBody, judgedSpec, judgedEvidenceText,
   *     executableCriterionCount, unaddressedCriteria: {number, text}[],
   *     presentElsewhereCriteria: {number, text}[], ...} (mt#3350
   *     `success-criteria-coverage.ts`) — same family; no `matches` array. Also
   *     declared by mt#4064, and the harder half to notice: nothing has written
   *     this log yet, so it was absent from disk and therefore invisible to both
   *     the coverage-receipt check and the sweep-coverage check, which discover
   *     their inputs by globbing `.minsky/*-calibration.jsonl`.
   *   "ask-form-lint"                 → {timestamp, askId?, kind, matches:
   *     {class, phrase}[], acknowledged?} (mt#2798
   *     `ask-form-lint-calibration.ts`) — already matches-shaped (`class` is a
   *     recognized label key); SC2 resolution — see `NON_GUARD_CALIBRATION_PRODUCERS`
   *     in `scripts/lib/calibration-log-declarations.ts`.
   *   "unwalked-task"                 → {source, channel, timestamp, session_id,
   *     stop_hook_active, unwalkedTaskIds: string[], ...} (mt#3536
   *     `turn-end-unwalked-task-scan.ts`) — no `matches` array.
   *   "unescalated-incident"          → {source, channel, timestamp, session_id,
   *     stop_hook_active, incidentFamilies: string[]} (mt#3593
   *     `turn-end-unescalated-incident-scan.ts`) — no `matches` array.
   *   "operator-instruction-trigger"  → written by `substrate-bypass-detector.ts`
   *     — no `matches` array.
   *   "agent-dispatch-record"         → {ts/timestamp, sessionId, outcome,
   *     reason?} (mt#2292 `record-agent-dispatch.ts`, via the ADR-028 §D4
   *     dispatcher's `logCalibrationRecord`) — an outcome-status record, no
   *     `matches` array.
   *   "chained-verification-commands" → {timestamp, session_id, outcome}
   *     (mt#3910 `chained-verification-commands-detector.ts`, same D4 write
   *     path) — an outcome-status record, no `matches` array.
   *   "truncated-outcome-read"        → {timestamp, session_id, outcome,
   *     mutatingCommand?, filter?} (mt#4096
   *     `truncated-outcome-read-detector.ts`, same D4 write path) — an
   *     outcome-status record, no `matches` array. The two extra fields carry
   *     the violation SHAPE (which command, which truncator), which is the
   *     sweep's diversity axis for this kind.
   *   "nonexistent-search-path"       → {ts, sessionId, toolName, outcome,
   *     binary?, missingCount?, unresolvedCount?, phrase?} (mt#4215
   *     `nonexistent-search-path-detector.ts`, same D4 write path) — an
   *     outcome-status record, no `matches` array. `phrase` carries the
   *     diversity axis (binary + the path SEGMENTS that failed to resolve, not
   *     the raw paths, which are near-unique). `unresolvedCount` is written on
   *     CLEAN records too, and is the only measurement of what the detector's
   *     deliberate silence rules cost — a relative path under `session_exec`, a
   *     path behind a `cd`, a glob, a variable. Read it when reviewing recall.
   *   "duplicate-signature-scan"      → {timestamp, session_id, outcome,
   *     matches?: {taskId, status, token, rule, excerpt}[]} (mt#3722
   *     `duplicate-signature-scan.ts`, same D4 write path) — HAS a `matches`
   *     array, but its per-match keys (`taskId`/`token`/`rule`/`excerpt`) are
   *     none of the recognized `family|class|category`/`phrase` labels, so
   *     every match's real content rides through as `detectorFields` rather
   *     than `phrase`.
   *
   * "generic-matches" (PR #2822 review) — the SAFE catch-all `deriveCalibrationLogEntries`
   *   assigns a runtime-derived declared name that is not already one of the
   *   literal members above. It exists so that cast is never `as` past a
   *   membership check: casting an unrecognized string directly to this union
   *   would silently admit it as though it had been consciously classified,
   *   defeating the exhaustiveness `KNOWN_KIND_MEMBERSHIP` (below) and
   *   `KIND_FIXTURES` (in the test file) rely on. A future detector's log
   *   therefore parses safely (shared fallback, same as every other
   *   unclassified-shape kind above) the moment it declares `calibrationLog`
   *   — giving it its OWN kind (and a `KIND_FIXTURES` entry) remains a
   *   deliberate follow-up for real diversity signal, not a blocker to being
   *   swept at all.
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
    | "constructed-identifier-batch"
    | "operator-deferral"
    | "untaken-action"
    | "retrospective-completeness"
    | "stop-at-decision"
    | "bare-entity-ref"
    | "bare-prohibition"
    | "execution-evidence-at-coverage"
    | "execution-evidence-test-first"
    | "execution-evidence-render-path"
    | "execution-evidence-sc-coverage"
    | "ask-form-lint"
    | "unwalked-task"
    | "unescalated-incident"
    | "operator-instruction-trigger"
    | "agent-dispatch-record"
    | "chained-verification-commands"
    | "truncated-outcome-read"
    | "nonexistent-search-path"
    | "block-concurrent-bulk-mutation"
    | "duplicate-signature-scan"
    | "generic-matches";
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
 *   - policy-coverage-calibration.jsonl (mt#1575) — PRODUCER RETIRED 2026-08-16
 *     (mt#4197). The detector is deleted; the entry, the parser and the
 *     1,760-record file all stay, because this registry is what makes the
 *     retained history interpretable (see the note at the entry itself). The
 *     log simply stops growing.
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
  // RETIRED PRODUCER (mt#4197, 2026-08-16). The policy-coverage detector is
  // deleted, so this log gains no new records — but the entry STAYS, for a
  // reason worth stating because removing it was tried first and was wrong:
  // this registry supplies the outcome -> fire-log-decision mapping
  // (`covered`/`dismissed` -> allow, `uncovered-logged` -> warn,
  // `uncovered-blocked` -> deny) for the 1,760 records deliberately retained on
  // disk as the retirement's evidence. Drop the entry and that history stops
  // being interpretable, which defeats the point of keeping it. The sweep
  // reports nothing here because its watermark is already at 1760/1760 and
  // nothing appends — dormancy by exhaustion, not by suppression.
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
    //
    // mt#3755 (2026-08-08): re-anchored again, and the DISPOSITION is KEEP —
    // the silence is measured DORMANCY, not breakage and not deterrence.
    //
    // The anchor is the LIVENESS PROOF date, per this field's own contract
    // above ("the date the detector's full invocation path ... was PROVEN
    // alive"). Proof: `bun scripts/run-guard-canaries.ts --json` on 2026-08-08
    // returned `build-claim-injection-detector` `passed: true` with a real
    // calibration outcome (timestamp 2026-08-08T23:53:07.794Z, matchedPhrases
    // ["you can use it"]); suite 42 passed / 0 failed. mt#3755's Success
    // Criterion 1 named the earlier 2026-08-05 canary run as the anchor; a
    // FRESHER proof of the same property supersedes it, and dating the clock
    // from a stale proof would understate the contract's runway. Amendment
    // recorded in mt#3755 `## Criterion 1 amendment`.
    //
    // Dormancy evidence: `bun scripts/replay-build-claim-injection.ts --json`
    // replayed the detector over all 805 transcripts since 2026-07-23
    // (3,048 evaluation points) and it would have fired ZERO times. The corpus
    // grows, so absolute counts drift on a re-run; the funnel SHAPE and the
    // zero-fire result are the finding. It localizes why, and it is condition
    // (a), not the claim patterns:
    //
    //     620 sessions  no in-session `*session_pr_merge` tool_use at all
    //     176 sessions  merged, but no deploy-surface file edited in-transcript
    //       8 sessions  merge + surface edit, but no usability claim
    //       1 session   all three met -> correctly SUPPRESSED by real rebuild
    //                   evidence (a true negative, not a miss)
    //
    // So the detector is not failing to recognize claims; its condition-(a)
    // PROXY — "a deploy-surface file was edited via a file-edit tool in THIS
    // transcript" — is near-unsatisfiable in Minsky's actual workflow, because
    // `DEPLOY_SURFACE_PATTERNS` matches only deploy CONFIG files (infra/,
    // Dockerfiles, railway.json, deploy workflows) and merges frequently
    // happen in a main-agent conversation whose file edits live in a
    // subagent's transcript. That defect is tracked at mt#3819 rather than
    // fixed here.
    //
    // Kept rather than retired because the cost is ~zero — INJECTION_ENABLED
    // is false, so it logs nothing and injects nothing — while retiring would
    // re-open the mt#2707 RFC's "merged != usable" chat seam, which no other
    // mechanism covers at the CHAT surface (the sibling mt#2545 gate covers
    // the PR-BODY surface only).
    liveSinceDate: "2026-08-08",
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
    path: ".minsky/operator-deferral-calibration.jsonl",
    name: "operator-deferral",
    kind: "operator-deferral",
  },
  {
    path: ".minsky/untaken-action-calibration.jsonl",
    name: "untaken-action",
    // mt#3179 — turn-end-untaken-action-scan emits `matches: {family, phrase}[]`,
    // the same shape as retrospective-trigger, so it parses through the shared
    // fallback branch with no dedicated parser case. It still gets its OWN kind:
    // the registry invariant (PR #2263 R1) requires unique kinds per entry.
    kind: "untaken-action",
  },
  {
    path: ".minsky/bare-entity-ref-calibration.jsonl",
    name: "bare-entity-ref",
    // mt#3286 — turn-end-bare-ref-scan (family:linked-reference-actionability,
    // mem#623 R1-R6): a turn's CLOSING message referencing an entity the
    // operator cannot click, plus two deterministically-malformed link shapes
    // (a non-UUID ask/memory/session target, R4; a raw-UUID-fragment label,
    // R5).
    //
    // Emits `matches: {family, phrase}[]` — family is the defect class, phrase
    // the offending ref — so it parses through the shared fallback branch with
    // no dedicated parser case, and diversity is measured over distinct refs.
    // It still takes its OWN kind: the registry invariant (PR #2263 R1)
    // requires unique kinds per entry.
    //
    // The record ALSO carries `logged_only`, the bare ask#N / mem#N / ws#N
    // population the v0 Success Criteria deliberately do not flag. Reviewing
    // this log means comparing the two populations, not just rating `matches`:
    // R6's whole argument is that the log-only carve-out is where the real
    // failures sit.
    kind: "bare-entity-ref",
  },
  {
    path: ".minsky/retrospective-completeness-calibration.jsonl",
    name: "retrospective-completeness",
    // mt#3601 — the OTHER axis from retrospective-trigger: that log measures
    // whether a retrospective FIRES, this one whether a retrospective that
    // fired is COMPLETE. Deliberately a separate log rather than a second
    // writer on "retrospective-trigger": the two answer different graduation
    // questions, and merging them would make each one's FP rate unreadable.
    //
    // Record shape is its own (`missing_sections` / `unverified_task_ids`
    // rather than `matches: {family, phrase}[]`), so it does not parse through
    // the shared matched-phrase fallback branch.
    kind: "retrospective-completeness",
  },
  {
    path: ".minsky/stop-at-decision-calibration.jsonl",
    name: "stop-at-decision",
    // mt#3653 — turn-end stop-at-decision scan (family:stop-at-handoff R5):
    // an evidence-write into a non-bound open task with no discharge call in
    // the same turn. Record shape is its own (`targets: {taskId, status}[]`),
    // parsed by a dedicated branch; diversity is measured over distinct
    // target task ids.
    kind: "stop-at-decision",
    // mt#3078 pattern: the date the detector's full invocation path —
    // dispatcher -> registry -> run() -> transcript parse -> detection ->
    // calibration write — was PROVEN alive via a live synthetic
    // positive/negative-control probe (positive wrote one record with a real
    // CLI status read; negative — same turn plus an asks_create — wrote
    // none). The trigger is a rare COMPOUND condition (evidence-write +
    // non-bound + open target + no discharge + no marker), so zero real
    // fires for a stretch is plausible without the detector being broken.
    //
    // Evidence artifact (cite the permanent record, not just this comment):
    // the mt#3653 PR body's "Live verification" section carries the actual
    // positive/negative-control transcript this date is derived from.
    liveSinceDate: "2026-08-04",
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
 * Written to `calibration-review-watermarks.json` under
 * `getMinskyStateDir()/projects/<key>/` (mt#4880; it was `.minsky/` until then).
 * The KEY is still a repo-relative log NAME — see `CalibrationLogEntry.path`
 * above for why that form is deliberate — and it is precisely because those keys
 * are identical across projects that the FILE has to be project-keyed.
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
  /**
   * Text surrounding the first matched phrase (mt#3289).
   *
   * `matchedPhrases` carries `match[0].slice(0, 120)` — the matched text
   * TRUNCATED, not the text around it — so a record reading
   * `"matchedPhrases":["The root cause is"]` gives a reviewer the phrase and
   * nothing to judge it by. Same field name and same window as
   * `RetrospectiveTriggerRecord` below, whose fires were the only classifiable
   * ones in the 2026-07-28 review.
   */
  transcript_excerpt?: string;
}

/** Parsed retrospective-trigger calibration record. */
export interface RetrospectiveTriggerRecord {
  timestamp: string;
  session_id?: string;
  matches: Array<{
    family: string;
    phrase: string;
    /**
     * The sentence or clause the phrase was matched in, when the detector
     * captures one (`pre-narration`, mt#3198). Absent for detectors that do
     * not.
     *
     * First-class rather than left to `detectorFields` deliberately. This
     * field exists so a reviewer can tell a claim from a reference — the whole
     * point of capturing it — and mem#827 records THREE reviews that read the
     * nested `detectorFields` sub-object as if it were the record and
     * concluded "unclassifiable" from records whose evidence sat one level up.
     * Shipping the disambiguator into that same sub-object would satisfy the
     * mechanical contract and lose the reader it was written for.
     */
    context?: string;
    /**
     * Per-match keys this branch does not consume structurally — e.g.
     * `pre-narration`'s `expectedTool` / `hadMatchingTool` (mt#3289).
     */
    detectorFields?: Record<string, unknown>;
  }>;
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
  /**
   * Minutes from the measured turn's END to the moment the guard fired
   * (mt#4018). Distinct from `gapMinutes`, which measures silence INSIDE the
   * turn — this measures how long ago that turn finished, which for a
   * `UserPromptSubmit` guard is the operator's away-time.
   *
   * Optional because every record written before mt#4018 lacks it. Absent is
   * NOT zero: a zero means "fired the instant the turn ended", so a reader
   * computing a staleness distribution must exclude absent rather than
   * average them in.
   */
  stalenessMinutes?: number;
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
  /**
   * The measured report's lead, capped by the detector (mt#3576).
   *
   * Optional because the 186 records written before mt#3576 have no such
   * field — absent means "written before the excerpt shipped," not "the report
   * was empty." Read it as the evidence for classifying a `lead-labels` fire:
   * `leadLabelHits` names which pattern matched, and only this carries the text
   * it matched.
   */
  excerpt?: string;
  /**
   * Words in the LARGEST block of the turn — the measurement the `over-budget`
   * leg keys on since mt#4531 (mt#4637).
   *
   * **Projected here because this is the surface a reviewer classifies from.**
   * It was in the raw JSONL from mt#4531 and absent from this parsed record, so
   * sorting a window by `wordCount` (the FINAL block) produced apparent
   * threshold violations that are correct fires — measured at 39% of
   * over-budget fires over the 685-record union corpus, and it inverted three
   * consecutive calibration passes' verdicts. A field present in the log and
   * missing from the projection is the same defect PR #2420 R1 names one line
   * up, in the other direction.
   *
   * Optional: records written before mt#4531 have no such field.
   */
  largestBlockWords?: number;
  /** The lead of that largest block (mt#4637). Optional; pre-mt#4637 records lack it. */
  largestBlockExcerpt?: string;
  /** 0-based index of that block in the turn (mt#4637). Optional; pre-mt#4637 records lack it. */
  largestBlockIndex?: number;
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

/**
 * Parsed stop-at-decision calibration record (mt#3653).
 *
 * NOT a matched-phrase record — a per-turn record of an evidence-write into a
 * non-bound open task with no discharge call in the same turn. `targets` is
 * the diversity axis (distinct task ids; see `extractDistinctPhrases` below).
 * Mirrors the exact fields `.minsky/hooks/stop-at-decision-scan.ts` returns;
 * the remaining bookkeeping fields (boundTaskIds, specPatchCount, ...) pass
 * through `detectorFields`.
 */
export interface StopAtDecisionRecord {
  timestamp: string;
  session_id?: string;
  targets: Array<{ taskId: string; status: string }>;
}

/**
 * Fields every calibration record may carry regardless of its detector
 * (mt#3197). Kept as an intersection rather than repeated on all eight member
 * types so a new record kind inherits it automatically.
 */
export interface SharedCalibrationFields {
  /**
   * Timestamp of an EARLIER record this one revises (mt#3740).
   *
   * A detector that fires on `Stop` sees a growing transcript, so its first
   * verdict can be formed on a partial session and later become stale rather
   * than wrong. Such a detector writes a fresh record naming the one it
   * replaces instead of leaving the stale answer standing. Superseded records
   * stay in the log — the revision history is the point — but they are not
   * counted as their own review-worthy fire, so a revised session contributes
   * ONE outcome, not two.
   *
   * Producers: `knowledge-acquisition` (mt#3740). Absent everywhere else.
   */
  supersedes?: string;
  /**
   * Whether `ask-routing-deferral` ALSO fired on this turn's prose (mt#4702).
   *
   * Lifted to the top level here, beside `supersedes` and `suppressionReasons`,
   * rather than left to the `detectorFields` passthrough. Two producers write
   * it — `untaken-action` (mt#4407) and `operator-deferral` (mt#4702) — and the
   * whole point of the field is COMPARING them, which a value nested one level
   * down defeats: mem#827 is the recorded incident of a reviewer reading
   * `detectorFields` as the record and reporting present fields as missing.
   *
   * Absent means NOT MEASURED, never "no overlap" — every record written before
   * its producer adopted the field is in that position, and a projection that
   * defaulted it to `false` would manufacture a measurement (the
   * accessor-that-synthesizes hazard in `claim-confidence.mdc`).
   */
  deferralOverlap?: boolean;
  /**
   * Injection-layer suppression outcome — the convention
   * `code-mechanism-assertion` introduced in mt#3113, generalized here.
   *
   * - non-empty  → detected, then SUPPRESSED (reasons name the gate that fired)
   * - empty `[]` → detected and INJECTED; the operator actually saw it
   * - absent     → this detector does not record the outcome yet, OR the
   *                record predates the field. NOT the same as empty.
   *
   * Conforming producers, with the reason strings each can emit (mt#3207
   * added the last five to `code-mechanism-assertion`'s mt#3113 original):
   *
   * | detector | reasons |
   * | --- | --- |
   * | `code-mechanism-assertion` | `same-turn-read`, `deduped`, ... |
   * | `wall-of-text` | `depth-request-override`, `question-answer-override` |
   * | `untaken-action` | (none — see below) |
   * | `ask-routing-deferral` | `asks-create-this-turn`, `deduped-by-untaken-action-stop` |
   * | `pre-narration` | `same-turn-tool-call`, `window-tool-call`, `identity-scoped-tool-call` |
   * | `knowledge-acquisition` | `propagation-in-window` |
   *
   * Records written by those detectors BEFORE mt#3207 carry no field and are
   * therefore `absent`, not `[]` — they count as injected, which is the
   * deliberate conservative default (unknown must never hide a real fire).
   *
   * mt#3620: `untaken-action` no longer emits any reason. It used to emit
   * `deduped-by-ask-routing-deferral` when it yielded to the prompt-time
   * detector; that yield is inverted — the Stop guard now injects and the
   * prompt-time one goes quiet under `deduped-by-untaken-action-stop`. Records
   * carrying the old string are pre-mt#3620 and still classify correctly.
   */
  suppressionReasons?: string[];

  /**
   * Every key on the raw record that the per-kind parse did not consume,
   * carried through verbatim (mt#3289).
   *
   * Attached by `parseCalibrationRecord` for the same reason mt#3197 attached
   * `suppressionReasons` there, and documented in that function's comment: the
   * per-kind branches construct their objects field-by-field, so a key no
   * branch names is dropped. mt#3197 fixed that for ONE field; the shared
   * fallback branch then went on dropping `untaken-action`'s
   * `final_message_tail` — the only field that makes its fires classifiable —
   * which is why two consecutive calibration reviews reported "unclassifiable"
   * while the evidence sat on disk in every record since the first.
   *
   * A passthrough rather than a third named field: naming them one at a time is
   * what produced the same defect twice, and it puts the burden on a future
   * detector author to remember a file they have no reason to open.
   */
  detectorFields?: Record<string, unknown>;
}

/** Union of all record types. */
export type CalibrationRecord = (
  | CausalPremiseRecord
  | RetrospectiveTriggerRecord
  | CodeMechanismAssertionRecord
  | PolicyCoverageRecord
  | SilentStretchRecord
  | WallOfTextRecord
  | BuildClaimInjectionRecord
  | KnowledgeAcquisitionRecord
  | StopAtDecisionRecord
) &
  SharedCalibrationFields;

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
  /**
   * Records added since the last acknowledged review (= total - watermark).
   *
   * POSITIONAL, deliberately: the watermark is itself a record count, so this
   * must stay aligned with it. It is NOT the review-cadence signal — see
   * `injectedFiresSinceLastReview` (mt#3197).
   */
  firesSinceLastReview: number;
  /**
   * Of `firesSinceLastReview`, how many were detected then SUPPRESSED and so
   * never reached the operator (mt#3197).
   */
  suppressedSinceLastReview: number;
  /**
   * `firesSinceLastReview` minus the suppressed ones and the evaluation-only
   * ones — the count the review thresholds actually key off, because neither
   * a suppressed detection nor a no-match evaluation record is an
   * operator-facing fire (mt#3197; evaluation-only widened in mt#3863).
   *
   * Records from detectors that don't record a suppression outcome, and
   * records predating the field, count as injected here: unknown is treated
   * as operator-facing so a missing outcome can never hide a real fire.
   */
  injectedFiresSinceLastReview: number;
  /**
   * Of `firesSinceLastReview`, how many carry no match and were never
   * injected (mt#3863) — see `isEvaluationOnlyRecord`.
   *
   * A detector that writes a record on every turn regardless of outcome
   * (retrospective-trigger's Rung-2 nominations; bare-entity-ref's
   * record-only classes) produces mostly this population. Reported
   * separately from `suppressedSinceLastReview` — a suppressed record DID
   * match something and was withheld after the fact; an evaluation-only
   * record never matched at all — so a reviewer can tell "detected then
   * silenced" apart from "nothing was there."
   */
  evaluatedOnlySinceLastReview: number;
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
   * True when the watermark exceeds the log's CURRENT record count (mt#4904).
   *
   * `firesSinceLastReview` is `Math.max(0, totalFires - watermarkCount)` and
   * `newRecords` is `allRecords.slice(watermarkCount)`, so a watermark above
   * the record count clamps the first to 0 and empties the second — which is
   * byte-identical to a log that was genuinely just reviewed. Every
   * `computeReviewDueLogs` leg then declines it: `past-threshold` and
   * `time-stale` are gated on an injected count the clamp pins to zero, and
   * `never-reviewed` / `never-fired` both require NO watermark. The log
   * becomes permanently invisible to the review loop with no error anywhere.
   *
   * This is not hypothetical: mt#4748 moved the calibration streams to the
   * project-keyed state dir while the watermark store kept counts recorded
   * against the larger pre-migration logs. Measured 2026-09-02 — 13 of 46
   * streams stranded, including `bare-entity-ref` (2130 vs 301) and
   * `retrospective-trigger` (2338 vs 181).
   *
   * Reported as its own state rather than folded into the counts, because the
   * counts CANNOT represent it: 0 is what they say both when nothing is new
   * and when the basis for the comparison is gone.
   */
  watermarkStranded: boolean;
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
  /**
   * Whether this log's un-reviewed records carry evidence a reviewer could
   * classify a fire from (mt#3610).
   *
   * Computed over `firesSinceLastReview`'s records — the ones a review would
   * actually rate — NOT over `newRecords`, which is empty below the count bar.
   * A reviewer must be able to see this verdict on a log that has not yet
   * reached threshold, since that is where a premature "cannot classify"
   * disposition gets written.
   */
  classifiability: ClassifiabilityAssessment;
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
/**
 * Read the injection-layer suppression outcome off a raw record (mt#3197).
 *
 * `suppressionReasons` is the convention `code-mechanism-assertion` introduced
 * in mt#3113: an empty/absent array means the detection was INJECTED (the
 * operator actually saw it); a non-empty array means it was detected and then
 * SUPPRESSED, with the reasons naming which gate fired.
 *
 * Absent is deliberately NOT the same as empty. A record written before its
 * detector recorded the field cannot be classified either way, and treating
 * "absent" as "injected" would silently re-inflate exactly the count this
 * task exists to deflate. `isSuppressedRecord` therefore reports absent as
 * not-suppressed (conservative: it still counts toward review) while
 * `hasSuppressionOutcome` lets callers distinguish "known injected" from
 * "unknown".
 */
function parseSuppressionReasons(raw: Record<string, unknown>): string[] | undefined {
  const value = raw["suppressionReasons"];
  if (!Array.isArray(value)) return undefined;
  return value.map(String);
}

/** Was this detection suppressed before reaching the operator? (mt#3197) */
export function isSuppressedRecord(record: CalibrationRecord): boolean {
  return (record.suppressionReasons?.length ?? 0) > 0;
}

/** Does this record carry a suppression outcome at all? (mt#3197 back-compat) */
export function hasSuppressionOutcome(record: CalibrationRecord): boolean {
  return Array.isArray(record.suppressionReasons);
}

/**
 * True when a record carries no match and nothing was injected (mt#3863).
 *
 * Some detectors write an EVALUATION record on every turn they run,
 * regardless of outcome — retrospective-trigger's Rung-2 nomination path logs
 * a record even when the nomination timed out or was never confirmed
 * (`matches: []`), and bare-entity-ref logs a record for a message carrying
 * ONLY log-only findings (`matches: []`, with the observations sitting in
 * `logged_only` under `detectorFields` instead). Neither reached the
 * operator. Counting them as fires is what kept these logs permanently
 * `pastThreshold` — measured at 193 counted vs 8 actual for
 * retrospective-trigger's 2026-08-08 review window, and 50 counted vs 3
 * actual for bare-entity-ref's 2026-08-11 window (mt#3863).
 *
 * The discriminator is already in every record that can exhibit this shape:
 * `matches` is populated ONLY when the detector actually found something —
 * verified against every producer that parses through the shared
 * matches-shape fallback branch in `parseCalibrationRecordCore` (the tail
 * branch below), each of which appends its record whether or not `matches`
 * ends up empty. `flagged_count` / `advisory_emitted`, the bare-entity-ref
 * fields the mt#3863 spec also names, are redundant with this check rather
 * than a second discriminator to apply: `matches` on that detector IS
 * `flagged.map(...)`, so `matches.length === 0` and `flagged_count === 0`
 * agree by construction.
 *
 * Deliberately scoped to record kinds that HAVE a `matches` field
 * (`"matches" in record`). Detectors like `causal-premise` and
 * `code-mechanism-assertion` gate the calibration WRITE itself on a match
 * (`if (!result.matched) return null`), so `matchedPhrases` / `claims` are
 * never empty in their logs — there is no evaluation-only population to
 * exclude for those kinds, and this predicate returns `false` for them
 * unconditionally rather than guessing at a shape they don't have.
 */
export function isEvaluationOnlyRecord(record: CalibrationRecord): boolean {
  return "matches" in record && record.matches.length === 0;
}

/**
 * Match keys the shared fallback branch consumes structurally (mt#3289).
 *
 * `family`/`class`/`category` are the three per-detector label keys the branch
 * collapses into one `family`, and `phrase` is the matched text. Anything else
 * on a match object is detector-specific — `pre-narration` writes
 * `expectedTool` and `hadMatchingTool` — and is carried through rather than
 * dropped.
 */
const CONSUMED_MATCH_KEYS = new Set(["family", "class", "category", "phrase", "context"]);

/**
 * Collect every raw record key the per-kind parse did not consume (mt#3289).
 *
 * Consumed-ness is derived from the PARSED record's own keys rather than a
 * hand-maintained allowlist, so when a per-kind branch starts naming a field it
 * automatically stops being reported here — there is no second list that can
 * drift out of sync with the first. `suppressionReasons` is excluded because
 * mt#3197 already gives it a typed field of its own.
 *
 * Returns `undefined` rather than `{}` when nothing was dropped, so a record
 * that carries no detector-specific fields is byte-identical to what it parsed
 * to before this change.
 *
 * **A lifted field cannot ALSO appear in the passthrough, and the reason is
 * this function alone** (mt#3576, PR #2568 R1). The raw JSONL line is FLAT —
 * `detectorFields` is DERIVED here from the line's unconsumed keys, never read
 * from it — so a field cannot arrive nested and be surfaced twice. Nor does the
 * guarantee depend on how a branch spells the assignment: a key is dropped only
 * when the raw line HAS it and the branch did NOT set it, and a branch that
 * reads `raw[k]` at all sets `k` under either spelling (`k: v ?? undefined` or a
 * conditional spread). Both forms were run against the wall-of-text branch;
 * neither duplicates. What WOULD break it is changing the `consumed` set below
 * to anything narrower than the record's own keys — verified by making that
 * edit, which turns the four mt#3289 tests and mt#3576's `excerpt` tests red
 * together. Those are the tests that pin this; a per-field strip would not.
 *
 * The one thing it does NOT cover is a lift the CALLER performs after invoking
 * this function: the key is unconsumed at the moment `consumed` is computed, so
 * it rides through and then gets added on top, appearing twice (PR #3531 R3).
 * `parseCalibrationRecord` therefore folds its cross-kind lifts in BEFORE
 * calling this — a call-ordering obligation, not something this function can
 * enforce, which is why it is written down in both places.
 */
function parseDetectorFields(
  raw: Record<string, unknown>,
  record: object
): Record<string, unknown> | undefined {
  const consumed = new Set<string>([...Object.keys(record), "suppressionReasons"]);
  const dropped = Object.entries(raw).filter(([key]) => !consumed.has(key));
  return dropped.length > 0 ? Object.fromEntries(dropped) : undefined;
}

/**
 * Parse one JSONL line into a typed record.
 *
 * mt#3197: the per-kind branches below construct their objects field-by-field
 * and therefore DROP any key they don't name — which is why
 * `suppressionReasons` was invisible to this sweep even though
 * `code-mechanism-assertion` had been writing it since mt#3113. Rather than
 * thread the field through all eight branches (and require every future
 * branch to remember it), the per-kind parse is wrapped and the shared field
 * is attached once, here.
 *
 * mt#3289 generalizes that seam. Naming one field fixed one field: the shared
 * fallback branch kept dropping `untaken-action`'s `final_message_tail`, the
 * only field that makes its fires classifiable, and two consecutive calibration
 * reviews concluded "unclassifiable" from records that had carried the evidence
 * since the first one. So every unconsumed key now rides through as
 * `detectorFields` — a detector author adding a field does not have to know
 * this file exists for the field to reach a reviewer.
 *
 * The CROSS-KIND lifts (`supersedes`, `deferralOverlap`) are folded into the
 * record handed to `parseDetectorFields` rather than added after it — see the
 * comment at the `lifted` binding, and PR #3531 R3 for the duplication that
 * ordering prevents.
 */
export function parseCalibrationRecord(
  line: string,
  kind: CalibrationLogEntry["kind"]
): CalibrationRecord | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const record = parseCalibrationRecordCore(raw, kind);
  if (record === null) return null;
  const suppressionReasons = parseSuppressionReasons(raw);
  // mt#3740: a non-string `supersedes` is dropped rather than coerced — a
  // malformed marker must not silently suppress a real record from the counts.
  const supersedes = typeof raw["supersedes"] === "string" ? raw["supersedes"] : undefined;
  // mt#4702: same cross-kind lift as `supersedes` above, and for the same
  // reason — the field's whole purpose is comparing the two producers that
  // write it, which `detectorFields` nesting defeats. A non-boolean is DROPPED
  // rather than coerced: absent must keep meaning "not measured".
  const deferralOverlap =
    typeof raw["deferralOverlap"] === "boolean" ? raw["deferralOverlap"] : undefined;
  // The cross-kind lifts are folded in BEFORE `parseDetectorFields` runs (PR
  // #3531 R3). That function derives consumed-ness from the keys of the record
  // it is HANDED, so a field lifted after the call is still unconsumed at the
  // time it runs and rides through the passthrough too — landing in the parsed
  // record twice, once at the top level and once under `detectorFields`, and
  // counting twice in `assessClassifiability`'s evidence tally. Ordering is the
  // whole fix: it keeps the invariant that function's docblock states true by
  // construction, with no second key list to drift out of sync.
  const lifted = {
    ...record,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(deferralOverlap === undefined ? {} : { deferralOverlap }),
  };
  const detectorFields = parseDetectorFields(raw, lifted);
  return {
    ...lifted,
    ...(suppressionReasons === undefined ? {} : { suppressionReasons }),
    ...(detectorFields === undefined ? {} : { detectorFields }),
  };
}

function parseCalibrationRecordCore(
  raw: Record<string, unknown>,
  kind: CalibrationLogEntry["kind"]
): CalibrationRecord | null {
  try {
    if (kind === "causal-premise") {
      // Shape: { timestamp, session_id?, matchedPhrases: string[], hadSameTurnVerification: boolean,
      //          transcript_excerpt? }
      if (!Array.isArray(raw["matchedPhrases"])) return null;
      return {
        timestamp: String(raw["timestamp"] ?? ""),
        session_id: raw["session_id"] !== undefined ? String(raw["session_id"]) : undefined,
        matchedPhrases: (raw["matchedPhrases"] as unknown[]).map(String),
        hadSameTurnVerification: Boolean(raw["hadSameTurnVerification"]),
        // Read explicitly rather than leaving it to the detectorFields
        // passthrough (mt#3289 PR #2420 R1): the field is declared on
        // CausalPremiseRecord and the retrospective-trigger branch reads its own
        // copy the same way, so a reader comparing the two branches would
        // otherwise see the type promise a field the parser never populates —
        // and every consumer keying on `transcript_excerpt` would miss it,
        // finding it nested one level down instead.
        transcript_excerpt:
          raw["transcript_excerpt"] !== undefined ? String(raw["transcript_excerpt"]) : undefined,
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
        // mt#4018. Only a NUMBER is accepted: a malformed value must read as
        // absent, not coerce to a plausible-looking figure that would then be
        // averaged into a staleness distribution as though it were measured.
        stalenessMinutes:
          typeof raw["stalenessMinutes"] === "number" ? raw["stalenessMinutes"] : undefined,
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
        // mt#3576: read explicitly rather than leaving it to the
        // `detectorFields` passthrough, for the reason PR #2420 R1 gave for
        // `transcript_excerpt` — a field declared on the record type that the
        // parser never populates makes the type promise something the parser
        // does not deliver, and every consumer keying on `excerpt` would find
        // it nested a level down instead.
        excerpt: typeof raw["excerpt"] === "string" ? raw["excerpt"] : undefined,
        // mt#4637: same reasoning as `excerpt` above, applied to the fields the
        // over-budget leg actually keys on. `largestBlockWords` reached the log
        // in mt#4531 and never reached this projection, so a reviewer sorting by
        // `wordCount` saw correct fires as threshold violations.
        largestBlockWords:
          typeof raw["largestBlockWords"] === "number" ? raw["largestBlockWords"] : undefined,
        largestBlockExcerpt:
          typeof raw["largestBlockExcerpt"] === "string" ? raw["largestBlockExcerpt"] : undefined,
        largestBlockIndex:
          typeof raw["largestBlockIndex"] === "number" ? raw["largestBlockIndex"] : undefined,
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

    if (kind === "stop-at-decision") {
      // Shape: { timestamp, session_id?, targets: [{taskId, status}][], ... }
      // Mirrors the exact record `.minsky/hooks/stop-at-decision-scan.ts`
      // returns (mt#3653). Not a matched-phrase record — `targets` is the
      // diversity axis (see extractDistinctPhrases).
      if (!Array.isArray(raw["targets"])) return null;
      return {
        timestamp: String(raw["timestamp"] ?? ""),
        session_id: raw["session_id"] !== undefined ? String(raw["session_id"]) : undefined,
        targets: (raw["targets"] as unknown[]).map((t) => {
          const obj = t as Record<string, unknown>;
          return {
            taskId: String(obj["taskId"] ?? ""),
            status: String(obj["status"] ?? "unknown"),
          };
        }),
      } satisfies StopAtDecisionRecord;
    }

    // retrospective-trigger, ask-routing-deferral (mt#2498), OR pre-narration
    // (mt#2197) — same matches-shape family. retrospective-trigger labels each
    // match with `family`; ask-routing-deferral labels it with `class`;
    // pre-narration labels it with `category`. Read all three so any of the
    // three kinds parses. `.phrase` is the DIVERSITY axis (extractDistinctPhrases
    // keys on it), so it must stay the short matched span — pre-narration's
    // reviewer-facing sentence rides in `.context` for exactly that reason
    // (mt#3198); widening `.phrase` would make every record distinct and
    // silently flatten the diversity signal to "always high".
    // Shape: { timestamp, session_id?, matches: [{family|class|category, phrase, context?}][], transcript_excerpt? }
    const matches = Array.isArray(raw["matches"])
      ? (raw["matches"] as unknown[]).map((m) => {
          const obj = m as Record<string, unknown>;
          const dropped = Object.entries(obj).filter(([key]) => !CONSUMED_MATCH_KEYS.has(key));
          return {
            family: String(obj["family"] ?? obj["class"] ?? obj["category"] ?? ""),
            phrase: String(obj["phrase"] ?? ""),
            ...(obj["context"] === undefined ? {} : { context: String(obj["context"]) }),
            ...(dropped.length > 0 ? { detectorFields: Object.fromEntries(dropped) } : {}),
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
    } else if ("targets" in rec) {
      // stop-at-decision (mt#3653): diversity axis = distinct target task
      // ids — "how many different decision-owning tasks got silently stopped
      // at," the same non-phrase move as knowledge-acquisition below.
      for (const t of rec.targets) {
        phrases.add(t.taskId);
      }
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
    } else if (
      rec.detectorFields &&
      typeof rec.detectorFields["mutatingCommand"] === "string" &&
      typeof rec.detectorFields["filter"] === "string"
    ) {
      // truncated-outcome-read (mt#4096): diversity axis = the violation SHAPE
      // (which outcome-bearing command, which truncator), read out of the
      // mt#3289 `detectorFields` passthrough rather than a dedicated parse
      // branch — the record is matches-shaped and carries no `matches`, so
      // without this clause it would fall to the `else` below, add nothing, and
      // sit at zero diversity forever no matter how varied the real fires were.
      // That is the mt#3781 inert-sweep defect, which this detector's own
      // record-shape comment cites; PR #2960 R1 caught it reproduced here.
      //
      // The raw command is deliberately NOT the axis: it is near-unique, which
      // would satisfy the distinct-phrase gate by construction — the same defect
      // from the opposite direction.
      //
      // `kind` joins the axis with mt#4176's enumeration arm. The two arms have
      // different false-positive profiles — the outcome arm keys on a curated
      // command list, the enumeration arm on `--help` — so a review that cannot
      // separate them is reading one blended rate. Records predating mt#4176
      // carry no `kind` and are all outcome-arm by construction, so they default
      // to `outcome` rather than dropping out of the axis.
      const kind = rec.detectorFields["kind"];
      const arm = typeof kind === "string" ? kind : "outcome";
      phrases.add(
        `${arm}|${rec.detectorFields["mutatingCommand"]}|${rec.detectorFields["filter"]}`
      );
    } else if (
      rec.detectorFields &&
      typeof rec.detectorFields["binary"] === "string" &&
      typeof rec.detectorFields["missingCount"] === "number"
    ) {
      // nonexistent-search-path (mt#4215): same shape and same reasoning as the clause above —
      // an outcome-status record with no `matches`, which without a clause here would fall to the
      // `else` and sit at zero diversity forever (the mt#3781 inert-sweep defect).
      //
      // Axis = the binary plus the SEGMENT that failed to resolve, never the raw path. A raw path
      // is near-unique and would satisfy the distinct-phrase gate by construction; the failed
      // segment is what repeats across genuinely similar mistakes (the same wrong `tray`, the same
      // wrong root), which is exactly what a review needs to see clustered.
      // The fallback is defensive only: `run()` writes `phrase` on every MATCHED record, and only
      // matched records reach here (a CLEAN record carries `binary: null`, fails this branch's
      // guard, and correctly contributes nothing — the axis measures fires). It exists for a record
      // whose writer omitted `phrase` — a hand-edited or pre-rename line. PR #3149 R1 NON-BLOCKING
      // noted that `binary|missingCount` alone collapses distinct shapes that share a count;
      // `unresolvedCount` is the only other discriminating field available at this layer, since the
      // failed SEGMENTS live in `phrase` itself and cannot be reconstructed from what is left.
      const phrase = rec.detectorFields["phrase"];
      phrases.add(
        typeof phrase === "string" && phrase.length > 0
          ? phrase
          : `${rec.detectorFields["binary"]}|${rec.detectorFields["missingCount"]}|${rec.detectorFields["unresolvedCount"]}`
      );
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
  // mt#4904: the clamp above is lossy in one direction. A watermark ABOVE the
  // record count means the basis for the subtraction is gone (the log was
  // rotated, truncated, or re-rooted under it), and both the clamp and the
  // slice render that as "nothing new" — the same output a just-reviewed log
  // produces. Capture the condition here, where both operands are still in
  // hand, since no downstream consumer can recover it from the results.
  const watermarkStranded = watermarkCount > totalFires;

  const distinctPhrases = extractDistinctPhrases(newRecords).size;

  // mt#3197: a SUPPRESSED detection never reached the operator, so it is not a
  // "fire" for review-cadence purposes. Counting it was making a correctly-tuned
  // detector trip review forever: code-mechanism-assertion reported 71 fires in
  // the 2026-07-24 pass, of which 30 were known-suppressed and only 3 known-
  // injected. `firesSinceLastReview` KEEPS its positional meaning (records added
  // since the watermark) because the watermark is itself a record COUNT and the
  // arithmetic must stay aligned with it; the threshold keys off the injected
  // count instead.
  const suppressedSinceLastReview = newRecords.filter(isSuppressedRecord).length;

  // mt#3740: a record another record SUPERSEDES is a revised answer, not a
  // second fire. Counting both would make one session look like two — the
  // double-count its criterion 3 forbids.
  //
  // Derived by FILTERING rather than by subtracting a second count, because a
  // record can be both suppressed and superseded (a propagated verdict carries
  // a suppression reason, and a later re-research supersedes it); two
  // independent subtractions would remove it twice and under-report the
  // injected count.
  // Scoped to (session_id, timestamp), NOT to the timestamp alone (PR #2873 R1).
  // A timestamp is only unique WITHIN a session — two detectors' records, or two
  // sessions writing in the same millisecond, can collide — and supersession is
  // by definition a within-session relation. Keying on the bare timestamp would
  // let one session's revision silently delete an unrelated session's fire from
  // the counts.
  //
  // A marker on a record with no `session_id` scopes to nothing, so it drops
  // nothing: same fail-safe direction as a dangling marker.
  const supersededKeys = new Set(
    newRecords
      .filter((r) => typeof r.supersedes === "string" && r.session_id !== undefined)
      .map((r) => `${r.session_id}::${r.supersedes}`)
  );
  const isRevisedAway = (r: CalibrationRecord): boolean =>
    r.session_id !== undefined && supersededKeys.has(`${r.session_id}::${r.timestamp}`);

  // mt#3863: a record carrying no match and no injection never reached the
  // operator either — same non-fire status as a suppressed detection, just a
  // different mechanism (nothing was detected at all, rather than something
  // detected-then-withheld). Reported as its own figure below
  // (`evaluatedOnlySinceLastReview`) so a reviewer can tell the two apart.
  const evaluatedOnlySinceLastReview = newRecords.filter(isEvaluationOnlyRecord).length;
  const injectedFiresSinceLastReview = newRecords.filter(
    (r) => !isSuppressedRecord(r) && !isRevisedAway(r) && !isEvaluationOnlyRecord(r)
  ).length;

  // The review threshold is DIVERSITY-AWARE (spec Success Criterion #3): a log is
  // only "past threshold" — i.e. worth surfacing for review — when it has enough
  // fires AND enough distinct shapes. Ten identical fires are NOT a review signal,
  // they're a uniform pattern; keep collecting until diversity arrives.
  const atCountThreshold = injectedFiresSinceLastReview >= FIRES_THRESHOLD;
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
    suppressedSinceLastReview,
    injectedFiresSinceLastReview,
    evaluatedOnlySinceLastReview,
    distinctPhrases,
    atCountThreshold,
    lowDiversity,
    pastThreshold,
    // Records are surfaced once the COUNT bar is hit (so a reviewer can see why a
    // log is low-diversity), even though the Ask only fires on pastThreshold.
    newRecords: atCountThreshold ? newRecords : [],
    watermarkCount,
    watermarkStranded,
    openAskId: watermark?.openAskId,
    // Calibration logs are APPEND-ONLY (records appended as events fire, never
    // reordered), so the first record IS the earliest — mt#2896 review NB1. A
    // naive chronological min would be LESS safe here: a later record with an
    // empty/malformed timestamp (parseCalibrationRecord tolerates `""`) would
    // poison the min and silently disable the never-reviewed leg.
    firstRecordTimestamp: allRecords[0]?.timestamp,
    // mt#3610: assessed over the un-reviewed records regardless of the count
    // bar. `newRecords` above is deliberately empty below threshold; the
    // verdict must not be, because a "cannot classify" disposition is most
    // likely to be written about a log that has not reached threshold yet.
    // `entry.name` is what keys `JUDGED_TEXT_FIELDS` (mt#4465) — without it the
    // judged-text derivation can only see the shared capture marker.
    classifiability: assessClassifiability(newRecords, entry.name),
  };
}

// ---------------------------------------------------------------------------
// Classifiability verdict (mt#3610)
// ---------------------------------------------------------------------------

/**
 * Keys every record carries regardless of which detector wrote it. They locate
 * a fire; they are not evidence for judging one, so they never make a log
 * classifiable on their own.
 */
/**
 * mt#3607's capture-schema marker key, named once and used twice.
 *
 * It is excluded from evidence (below) AND read as the recoverability signal
 * (`hasCaptureMarker`). Those are opposite uses of the same key, which is
 * exactly the pair a duplicated string literal would eventually split apart.
 * Source of truth for the value is `CAPTURE_SCHEMA_FIELD` in
 * `.minsky/hooks/judged-input-capture.ts`; it is restated rather than imported
 * because domain code does not depend on the hooks tree.
 */
const CAPTURE_SCHEMA_KEY = "captureSchema";

const NON_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  "timestamp",
  "session_id",
  "suppressionReasons",
  // mt#3607's capture-schema marker. It says the record's judged input WAS
  // captured; it is not itself something to judge a fire by. Listing it here
  // keeps a hypothetical record carrying the marker and nothing else from
  // reporting `classifiable` on the strength of its own bookkeeping.
  CAPTURE_SCHEMA_KEY,
]);

/**
 * True when a value is PRESENT but carries nothing to judge a fire by
 * (PR #2599 R1).
 *
 * A key being set is not the same as it holding evidence: `leadLabelHits: []`
 * and `excerpt: ""` are populated and empty. Counting them let a record whose
 * only non-shared fields were vacuous report `classifiable` — a false verdict
 * in the permissive direction, which is the direction this whole mechanism
 * exists to prevent (it would tell a reviewer the fires are ratable when they
 * are not). Verified against the pre-fix code: a record carrying only
 * `leadLabelHits: []` and `excerpt: ""` returned `classifiable` with both
 * listed as evidence.
 *
 * `0` and `false` are NOT vacuous — they are measured values. `deeplinkCount:
 * 0` says the report contained no deeplinks, which is exactly the kind of
 * observation a reviewer rates.
 */
function isVacuousEvidence(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  // A plain object with no own keys carries no more than an absent one.
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/** Whether a log's records carry anything a reviewer could classify a fire from. */
export type ClassifiabilityVerdict = "classifiable" | "not-classifiable" | "no-records";

/**
 * Whether the TEXT a detector judged can still be read back (mt#3898).
 *
 * A sibling of {@link ClassifiabilityVerdict}, deliberately not folded into it:
 * they answer different questions and a log can score well on one and badly on
 * the other. `classifiable` means "these records carry SOMETHING to judge a
 * fire by" — `matches[].phrase` alone satisfies it. This asks the narrower
 * question a reviewer actually needs: "can I re-read what the detector was
 * looking at?"
 *
 * The gap between them is not hypothetical. A `/calibration-review` pass on
 * `bare-entity-ref` (2026-08-10, mem#623 R7) read `classifiable`, correctly,
 * and could establish WHICH refs were flagged — while the messages those refs
 * appeared in were gone, so the one question that mattered (was each ref
 * genuinely un-clickable in context?) could not be answered at all. The pass
 * had no way to learn that from the sweep's output.
 */
export type JudgedTextRecoverability = "recoverable" | "partial" | "unrecoverable" | "no-records";

export interface JudgedTextAssessment {
  recoverability: JudgedTextRecoverability;
  /**
   * Records carrying the mt#3607 capture marker — the ADOPTION signal.
   *
   * Deliberately still marker-only after mt#4465: this is what reports whether
   * a writer uses the shared capture contract, and it is the honest home for
   * that pressure. `recoverability` no longer derives from it alone.
   */
  capturedRecords: number;
  /**
   * Records whose judged text can actually be re-read (mt#4465) — the marker,
   * OR a mapped per-detector field. This is what `recoverability` derives from.
   */
  recoverableRecords: number;
  recordsAssessed: number;
  /**
   * Set when the verdict is `unrecoverable` AND this log has no entry in
   * `JUDGED_TEXT_FIELDS` — so a reader can tell "the text is gone" from
   * "nobody has told the sweep where this detector puts it" (mt#4465 SC4).
   */
  unmappedDetector?: string;
}

export interface ClassifiabilityAssessment {
  verdict: ClassifiabilityVerdict;
  /**
   * Every evidence field observed across the assessed records, sorted. A field
   * riding the passthrough is reported as `detectorFields.<key>` rather than
   * bare — see `assessClassifiability`'s doc for why the level is spelled out.
   */
  evidenceFields: string[];
  /** How many records the verdict was computed over. */
  recordsAssessed: number;
  /**
   * Whether the judged text is recoverable — see {@link JudgedTextRecoverability}
   * for why this is reported beside `verdict` rather than merged into it.
   */
  judgedText: JudgedTextAssessment;
}

/**
 * Decide whether a log's records can support an FP classification, and say so
 * in the sweep's own output (mt#3610).
 *
 * **Why the tool needs a verdict at all.** Before this, "can these fires be
 * classified?" was answered only by the reviewing agent's eye, across a dozen
 * logs, and a wrong answer contradicted nothing. On 2026-08-03 a sweep
 * dispositioned `wall-of-text` "HOLD — cannot classify" and filed mt#3576
 * asserting its records held only a hash — while `wordCount` and `trigger` sat
 * at the top level of the same output, next to the nested `detectorFields`
 * object that was quoted as proof of their absence. That false premise reached
 * an Accepted ADR and two task specs before anyone checked it (mem#827). A
 * verdict makes the same mistake contradict the tool instead of passing
 * silently.
 *
 * **Derived, not listed.** Evidence is "every key the per-kind parse populated
 * that isn't shared bookkeeping" — so a detector or parser that starts carrying
 * a new field is covered with no edit here. A per-detector table of expected
 * fields would be a second list to drift out of sync with the parsers, which is
 * the defect `parseDetectorFields` was written to avoid; this reuses that
 * derivation rather than reintroducing the thing it replaced.
 *
 * That derivation is also why the verdict reports the fields it FOUND rather
 * than the ones it thinks are missing: naming a missing field would require
 * knowing which fields ought to exist, i.e. exactly the list this avoids. An
 * empty `evidenceFields` IS the not-classifiable finding.
 *
 * **The level is part of the answer.** A passthrough field is reported as
 * `detectorFields.<key>`, never bare. The originating misread was precisely a
 * confusion of those two levels, so a verdict that flattened them would answer
 * the question while hiding the distinction that caused the incident.
 *
 * **`no-records` is its own verdict, not a `false`.** An empty log and a log of
 * evidence-free records demand opposite responses — the first says "nothing has
 * fired yet," the second "the fires that happened cannot be reviewed." Folding
 * them into one boolean is the conflation `coverage-receipt.ts` (mt#3502) was
 * split apart to end, so this does not repeat it.
 */
/**
 * The mt#3607 capture marker.
 *
 * Read from the PASSTHROUGH only, and that is provably the whole story rather
 * than an omission: no per-kind parse branch names `captureSchema`, so
 * `parseDetectorFields` routes it into `detectorFields` for every log kind —
 * the same mechanism `NON_EVIDENCE_KEYS` documents one screen up ("a key like
 * `captureSchema` reaches this loop rather than the one above — for every log
 * at once", PR #2679 R1).
 *
 * An earlier draft also read the top level, on the theory that the
 * execution-evidence parsers hoist it. A staged negative control disproved
 * that: disabling the top-level read left every test green, including one
 * written specifically to exercise it. The branch was dead code carrying a
 * false rationale, so it is gone. If a future per-kind branch ever does name
 * the marker, this needs a top-level read AND a test that fails without it.
 *
 * Marker-only, and that is the ADOPTION signal rather than the whole answer
 * (corrected by mt#4465).
 *
 * This function is unchanged and `capturedRecords` still means exactly what it
 * meant: how many records adopted `judged-input-capture.ts`'s shared contract.
 * What changed is that {@link assessJudgedText} no longer derives
 * `recoverability` from it ALONE — see that function for why.
 *
 * The rationale this docblock used to carry ("a writer that captures under its
 * own key reads as unrecoverable here, and that is the intended answer rather
 * than a false negative") is corrected rather than deleted, because it argued
 * against the behaviour that now ships and a later reader would otherwise meet
 * it as current. It was defensible on its own terms — an allowlist is a second
 * list to drift, and non-adoption should cost something — but it answered a
 * DIFFERENT question from the one the field is named for. Measured 2026-08-29:
 * `untaken-action` carried `final_message_tail` on 390 of 390 records and
 * reported `unrecoverable`; `negative-existence-claim` carried a populated
 * `claims[].excerpt` on 90 of 90 and reported the same. The judged text was
 * right there.
 */
function hasCaptureMarker(record: CalibrationRecord): boolean {
  const passthrough = (record as SharedCalibrationFields).detectorFields;
  return typeof passthrough?.[CAPTURE_SCHEMA_KEY] === "number";
}

/**
 * Where each detector puts its judged text, when it does not use the shared
 * capture marker (mt#4465).
 *
 * Keyed on `CalibrationLogEntry.name` — the reviewer-facing identity, and the
 * granularity that matters, since judged text is a property of the DETECTOR
 * rather than of the parse `kind` (two logs share the `retrospective-trigger`
 * kind and write different fields).
 *
 * **A field may sit at EITHER level, so both are checked (mem#888).** A key no
 * per-kind branch names rides into `detectorFields`, and these are genuinely
 * split: `excerpt` and `transcript_excerpt` are consumed at the top level,
 * while `untaken-action`'s `final_message_tail` reaches the passthrough — which
 * is the same two-level trap that made `captureSchema` itself misbehave in
 * mt#3607 (PR #2679 R1). Checking one level would work for some of these logs
 * and silently fail for others.
 *
 * Adding an entry is the cheap, honest move when a detector writes judged text
 * under its own key. Adopting the shared marker is still better and is still
 * what `capturedRecords` reports.
 */
const JUDGED_TEXT_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["untaken-action", ["final_message_tail"]],
  ["wall-of-text", ["excerpt"]],
  ["retrospective-trigger", ["transcript_excerpt"]],
  // `claims[].excerpt` names the SUB-FIELD, and that precision is load-bearing
  // rather than cosmetic. A bare `claims` was the first implementation, and it
  // reported `recoverable` for records whose excerpts were ALL empty — because
  // each element also carries a non-empty `pattern`, so "any string in the
  // element" was satisfied by the matcher's own pattern rather than by the
  // judged text. Caught by this task's own SC3 test.
  ["negative-existence-claim", ["claims[].excerpt"]],
]);

/**
 * Whether a plain value carries readable judged text.
 *
 * Stricter than {@link isVacuousEvidence}, which counts any populated
 * collection: reporting `recoverable` over text nobody can read is the
 * permissive direction this whole mechanism exists to prevent.
 */
function carriesJudgedText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read one field spec off a record level. Supports a single `<array>[].<key>`
 * hop, which is how a detector that records several claims per fire (each with
 * its own excerpt) names the excerpt rather than the wrapper.
 */
function fieldCarriesJudgedText(level: unknown, spec: string): boolean {
  if (!level || typeof level !== "object") return false;
  const fields = level as Record<string, unknown>;

  const [arrayKey, elementKey] = spec.split("[].");
  if (elementKey === undefined) return carriesJudgedText(fields[spec]);

  const array = arrayKey === undefined ? undefined : fields[arrayKey];
  if (!Array.isArray(array)) return false;
  return array.some((element) => carriesJudgedText(readKey(element, elementKey)));
}

/** One key off an unknown value, when that value is an object. */
function readKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

/** True when the record carries readable judged text under one of `fields`, at EITHER level. */
function hasMappedJudgedText(record: CalibrationRecord, fields: readonly string[]): boolean {
  const passthrough = (record as SharedCalibrationFields).detectorFields;
  return fields.some(
    (field) => fieldCarriesJudgedText(record, field) || fieldCarriesJudgedText(passthrough, field)
  );
}

/**
 * Whether the judged text can be re-read — derived from the evidence a record
 * ACTUALLY carries, not from the capture marker alone (mt#4465).
 *
 * `JudgedTextRecoverability`'s own doc states the question this answers: "can I
 * re-read what the detector was looking at?" That is a FACT about the record.
 * Deriving it from the marker alone answered a different question — "did this
 * writer adopt the shared contract?" — and so reported `unrecoverable` over
 * logs whose judged text was sitting in every record. `/calibration-review`
 * turns `unrecoverable` into a HOLD, so three logs (four, with
 * `negative-existence-claim`) were held permanently unratable by a signal that
 * was measurably false about them; for a calibration-first detector that also
 * blocks the only path off calibration-first.
 *
 * **The adoption signal is preserved, not overridden.** `capturedRecords` still
 * counts marker-carrying records only, and still reports 0 for those logs in
 * the same output — which is the honest place for that signal. Nothing about
 * this weakens the bar mt#3607 set: a record carrying neither the marker nor
 * mapped judged text still counts as unrecoverable.
 */
function assessJudgedText(records: CalibrationRecord[], logName?: string): JudgedTextAssessment {
  if (records.length === 0) {
    return {
      recoverability: "no-records",
      capturedRecords: 0,
      recoverableRecords: 0,
      recordsAssessed: 0,
    };
  }

  const mappedFields = logName ? JUDGED_TEXT_FIELDS.get(logName) : undefined;
  const capturedRecords = records.filter(hasCaptureMarker).length;
  const recoverableRecords = records.filter(
    (record) =>
      hasCaptureMarker(record) || (mappedFields ? hasMappedJudgedText(record, mappedFields) : false)
  ).length;

  // `partial` is its own answer, not a rounding of the other two. Adoption
  // lands mid-log — `pre-narration` sat at 133 captured of 375 the day this
  // shipped — and a reviewer facing a partial log can rate the recoverable half
  // while knowing the rest is gone. Collapsing it either way would hide that.
  const recoverability: JudgedTextRecoverability =
    recoverableRecords === 0
      ? "unrecoverable"
      : recoverableRecords === records.length
        ? "recoverable"
        : "partial";

  // Name the gap rather than reporting a bare 0 (mt#4465 SC4). A log that is
  // unrecoverable AND has no mapping is ambiguous between "the text is gone"
  // and "nobody told this function where to look" — a NEW detector hits the
  // second and would otherwise look identical to the first. Only reported when
  // the verdict is actually unrecoverable: a marker-carrying log needs no
  // mapping and is not a gap.
  const unmappedDetector =
    recoverability === "unrecoverable" && !mappedFields ? (logName ?? "<unnamed log>") : undefined;

  return {
    recoverability,
    capturedRecords,
    recoverableRecords,
    recordsAssessed: records.length,
    ...(unmappedDetector ? { unmappedDetector } : {}),
  };
}

export function assessClassifiability(
  records: CalibrationRecord[],
  logName?: string
): ClassifiabilityAssessment {
  if (records.length === 0) {
    return {
      verdict: "no-records",
      evidenceFields: [],
      recordsAssessed: 0,
      judgedText: assessJudgedText(records, logName),
    };
  }

  const fields = new Set<string>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (key === "detectorFields" || NON_EVIDENCE_KEYS.has(key)) continue;
      // A key the per-kind branch set but left empty carries nothing to judge —
      // see `isVacuousEvidence`. This covers the `undefined` case (the raw line
      // lacked the key) and the empty-collection case alike.
      if (isVacuousEvidence(value)) continue;
      fields.add(key);
    }
    const passthrough = (record as SharedCalibrationFields).detectorFields;
    if (passthrough) {
      for (const [key, value] of Object.entries(passthrough)) {
        // NON_EVIDENCE_KEYS applies on BOTH levels (PR #2679 R1). The top-level
        // check alone is not enough, and for a NEW bookkeeping key it is not
        // even the path that runs: `parseDetectorFields` treats every key no
        // per-kind branch named as passthrough, so a key like `captureSchema`
        // reaches this loop rather than the one above — for every log at once.
        // Excluding it in only one place would have left the marker counted as
        // evidence everywhere it actually appears.
        if (NON_EVIDENCE_KEYS.has(key)) continue;
        if (isVacuousEvidence(value)) continue;
        fields.add(`detectorFields.${key}`);
      }
    }
  }

  return {
    verdict: fields.size > 0 ? "classifiable" : "not-classifiable",
    evidenceFields: [...fields].sort(),
    recordsAssessed: records.length,
    judgedText: assessJudgedText(records, logName),
  };
}

// ---------------------------------------------------------------------------
// Registry derivation (mt#3716 — ADR-028 §D4)
// ---------------------------------------------------------------------------

/**
 * Exhaustive runtime membership check for `CalibrationLogEntry["kind"]` (PR #2822
 * review). `Record<CalibrationLogEntry["kind"], true>` forces this object literal
 * to have EXACTLY one property per union member — the same idiom the test
 * file's `KIND_FIXTURES` already uses for the same purpose — so adding a kind
 * to the union without adding it here fails to compile, and this object can
 * never silently fall out of sync with the type it mirrors.
 *
 * `deriveCalibrationLogEntries` uses this to validate a runtime-derived
 * declared name BEFORE casting it to `kind`: an unchecked `as` would silently
 * admit any string as though it had been consciously classified, defeating
 * the exhaustiveness this object (and `KIND_FIXTURES`) exist to guarantee.
 */
const KNOWN_KIND_MEMBERSHIP: Record<CalibrationLogEntry["kind"], true> = {
  "causal-premise": true,
  "retrospective-trigger": true,
  "ask-routing-deferral": true,
  "code-mechanism-assertion": true,
  "pre-narration": true,
  "policy-coverage": true,
  "silent-stretch": true,
  "wall-of-text": true,
  "build-claim-injection": true,
  "knowledge-acquisition": true,
  "constructed-identifier-batch": true,
  "operator-deferral": true,
  "untaken-action": true,
  "retrospective-completeness": true,
  "stop-at-decision": true,
  "bare-entity-ref": true,
  "bare-prohibition": true,
  "execution-evidence-at-coverage": true,
  "execution-evidence-test-first": true,
  "execution-evidence-render-path": true,
  "execution-evidence-sc-coverage": true,
  "ask-form-lint": true,
  "unwalked-task": true,
  "unescalated-incident": true,
  "operator-instruction-trigger": true,
  "agent-dispatch-record": true,
  "chained-verification-commands": true,
  "truncated-outcome-read": true,
  "nonexistent-search-path": true,
  "block-concurrent-bulk-mutation": true,
  "duplicate-signature-scan": true,
  "generic-matches": true,
};

/** The safe catch-all kind — see its doc comment on `CalibrationLogEntry["kind"]` above. */
const GENERIC_MATCHES_KIND: CalibrationLogEntry["kind"] = "generic-matches";

/**
 * Build the sweep entries `runSweep` should actually visit, from a set of
 * DECLARED log names (the union of the three declaration surfaces — see
 * `scripts/lib/calibration-log-declarations.ts`'s `getDeclaredCalibrationLogNames`)
 * plus the pre-existing hand-typed `knownEntries` (default: `CALIBRATION_LOG_REGISTRY`).
 *
 * This function is PURE and takes `declaredNames` as data rather than importing
 * `GUARD_REGISTRY`/`STANDALONE_GUARD_CANARIES` itself — this module (`src/`) does
 * not cross into `.minsky/hooks/` (see this file's own `CALIBRATION_NAME_TO_GUARD_NAME`
 * doc comment for the established precedent). Callers that CAN reach the
 * declaration surfaces (`.minsky/hooks/calibration-review-cadence-detector.ts`,
 * `src/adapters/shared/commands/calibration.ts`) supply `declaredNames` and get
 * back a full `CalibrationLogEntry[]` to pass into `runSweep`.
 *
 * For a declared name that already has a `knownEntries` entry, that entry is
 * reused UNCHANGED (preserving its `kind`, `reviewByDays`, `liveSinceDate`).
 * For a declared name with no existing entry, a generic one is synthesized:
 * `{ path: ".minsky/<name>-calibration.jsonl", name, kind }` — relying on the
 * file-naming convention every registry entry already follows. `kind` is
 * `name` itself ONLY when `name` is a KNOWN kind literal (checked against
 * `KNOWN_KIND_MEMBERSHIP` above — the `kind === name` convention every
 * hand-typed entry follows); a genuinely new declared name — one no PR has
 * yet added to the `kind` union — gets `GENERIC_MATCHES_KIND` instead of an
 * unchecked cast (PR #2822 review), so the type system's exhaustiveness
 * guarantee is never silently bypassed at the boundary where a runtime string
 * becomes a `kind`. Either way the result parses via the shared matches-shape
 * fallback — see the ten mt#3716 kinds' doc comments above.
 *
 * `knownEntries` not present in `declaredNames` are ALSO included (union, not
 * intersection) — a registry entry whose declaration surface a caller does not
 * (yet) enumerate must not silently drop out of the sweep.
 */
export function deriveCalibrationLogEntries(
  declaredNames: Iterable<string>,
  knownEntries: readonly CalibrationLogEntry[] = CALIBRATION_LOG_REGISTRY
): CalibrationLogEntry[] {
  const byName = new Map(knownEntries.map((e) => [e.name, e]));
  const names = new Set<string>([...declaredNames, ...byName.keys()]);
  const entries: CalibrationLogEntry[] = [];
  for (const name of [...names].sort()) {
    const existing = byName.get(name);
    if (existing) {
      entries.push(existing);
      continue;
    }
    entries.push({
      path: `.minsky/${name}-calibration.jsonl`,
      name,
      // Only cast `name` to `kind` when it is a KNOWN kind literal (the
      // `kind === name` convention every hand-typed entry follows) — an
      // unrecognized declared name gets the safe generic-matches catch-all
      // instead of an unchecked `as` (PR #2822 review).
      kind:
        name in KNOWN_KIND_MEMBERSHIP
          ? (name as CalibrationLogEntry["kind"])
          : GENERIC_MATCHES_KIND,
    });
  }
  return entries;
}

/**
 * SC3/SC5 drift check (mt#3716): given the calibration-log stems actually found
 * on disk (`.minsky/*-calibration.jsonl`, minus the `-calibration.jsonl` suffix)
 * and the set of names `runSweep` will actually visit (typically
 * `deriveCalibrationLogEntries(...).map(e => e.name)`), return the on-disk
 * stems that are NOT in the swept set — i.e. a producer writing a log no sweep
 * will ever read.
 *
 * Pure and reachability-keyed rather than declaration-surface-keyed, per this
 * task's amendment: a log declared ONLY as a `GuardRegistration.calibrationLog`
 * (write side) used to pass a presence-in-declaration check while still never
 * being swept. Once `sweptNames` is built via `deriveCalibrationLogEntries`
 * over the derived declared-name union, that class is naturally covered — this
 * function's residual job is catching a log whose producer is declared on NO
 * surface at all.
 */
export function findUnsweptCalibrationLogs(
  onDiskStems: readonly string[],
  sweptNames: ReadonlySet<string> | readonly string[]
): string[] {
  const swept = sweptNames instanceof Set ? sweptNames : new Set(sweptNames);
  return onDiskStems.filter((stem) => !swept.has(stem)).sort();
}

/**
 * Compute results for all entries in the registry.
 *
 * @param entries      - the entries to sweep (typically `CALIBRATION_LOG_REGISTRY`
 *                       or `deriveCalibrationLogEntries(declaredNames)`)
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
  /**
   * Of `firesSinceLastReview`, how many actually reached the operator
   * (mt#3197). This is the number the cadence warning should quote — the
   * positional count includes suppressed detections nobody ever saw.
   */
  injectedFiresSinceLastReview: number;
  /** Of `firesSinceLastReview`, how many were suppressed before injection (mt#3197). */
  suppressedSinceLastReview: number;
  totalFires: number;
  distinctPhrases: number;
  reason: "past-threshold" | "time-stale" | "never-reviewed" | "never-fired" | "watermark-stranded";
  /**
   * The watermark this log was compared against (mt#4904, PR #3572 R1).
   * Carried so a consumer can render the `watermark-stranded` leg's actual
   * comparison — "watermark 424 exceeds 121 record(s)" — instead of the shared
   * warning line's `injectedFiresSinceLastReview`, which the stranding clamps
   * to 0 and which would otherwise report "0 new fire(s)" about a log being
   * flagged for review.
   */
  watermarkCount: number;
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
    injectedFiresSinceLastReview: r.injectedFiresSinceLastReview,
    suppressedSinceLastReview: r.suppressedSinceLastReview,
    totalFires: r.totalFires,
    distinctPhrases: r.distinctPhrases,
    reason,
    watermarkCount: r.watermarkCount,
    openAskId,
    reviewByDays,
  };
}

/**
 * Determine which logs are review-due, per FIVE independent conditions.
 *
 *   0. watermark-stranded — the watermark exceeds the log's CURRENT record
 *      count (mt#4904), so the counts every other leg reads are invalid: the
 *      subtraction clamps to 0 and the slice is empty. Checked FIRST and
 *      ungated, because all four below decline such a log — two on a zero
 *      injected count, two because they require NO watermark — leaving it
 *      permanently unreviewable with no error raised anywhere.
 *
 * The original four:
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

    // watermark-stranded (mt#4904): FIRST, because every leg below reads counts
    // this condition invalidates. When the watermark exceeds the log's record
    // count, `firesSinceLastReview` is clamped to 0 and `newRecords` is empty —
    // so `past-threshold` and `time-stale` decline on a zero injected count,
    // and `never-reviewed` / `never-fired` are unreachable because a watermark
    // exists. The log falls through all four and is never reviewed again.
    //
    // Deliberately NOT gated on an injected count, unlike its siblings: that
    // gate asks "has the operator seen anything since the last review", and
    // here the question is whether the last-review marker means anything at
    // all. Gating it would reproduce exactly the silence it exists to break.
    // Gated on `exists` (found by live verification, mt#4904). An ABSENT log
    // has `totalFires: 0`, so any watermark at all satisfies the comparison —
    // and a retired detector is exactly that shape: `policy-coverage` was
    // retired by mt#4197 and its watermark still reads 1760 against a file that
    // is gone. Flagging it would say "review these fires" about a log with no
    // fires and no file, which is noise rather than the signal this leg exists
    // for. A watermark orphaned by a DELETED log is a real but different
    // condition (nothing to review, only to clean up) and is not this task's.
    if (r.exists && r.watermarkStranded) {
      due.push(toReviewDueLog(r, "watermark-stranded", wm?.openAskId));
      continue;
    }

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
      // mt#3197 (PR #2300 R1, class sweep): same reasoning as the time-stale
      // leg below — if every record since the (absent) watermark was
      // suppressed, the operator has seen nothing and the warning would read
      // "0 new fire(s)". Gated for consistency across all count-bearing legs.
      //
      // Counter-consideration deliberately NOT acted on here: a log that
      // suppresses 100% of what it detects is arguably its own signal ("is the
      // gate too broad?"). That is a different question from "review these
      // fires", needs different warning text, and is not something to invent
      // mid-review — the suppressed count remains visible in the sweep output
      // for anyone who looks.
      if (r.injectedFiresSinceLastReview <= 0) continue;
      if (nowMs - firstMs >= windowMs) {
        const windowDays = Math.round(windowMs / (24 * 60 * 60 * 1000));
        due.push(toReviewDueLog(r, "never-reviewed", undefined, windowDays));
      }
      continue;
    }

    // time-stale: reviewed before, >= 1 new fire, review is >= staleMs old. A
    // reviewed log that hasn't accrued a new fire is "keep collecting," not
    // "forgotten."
    //
    // mt#3197 (PR #2300 R1): "new fire" here means an INJECTED one, matching
    // the past-threshold leg. Keying this off the positional count would
    // re-warn on a log whose only new records were suppressed — the operator
    // saw nothing, so there is nothing to review, and the warning would name
    // "0 new fire(s)" now that the message quotes the injected count.
    if (r.injectedFiresSinceLastReview <= 0) continue;
    const reviewedMs = Date.parse(wm.lastReviewedAt);
    if (Number.isNaN(reviewedMs)) continue;
    if (nowMs - reviewedMs >= staleMs) {
      due.push(toReviewDueLog(r, "time-stale", wm.openAskId));
    }
  }
  return due;
}

// ---------------------------------------------------------------------------
// Review receipts (mt#3906)
// ---------------------------------------------------------------------------

/**
 * The per-log fire counts a READ-ONLY sweep observed, carried forward into the
 * later `--ack` invocation.
 *
 * Why this exists: a review pass is TWO command invocations — a read-only sweep
 * the reviewer classifies against, then an `--ack` minutes later. Each runs its
 * own sweep, so re-deriving the count at ack time records whatever the log has
 * grown to, marking every record that arrived mid-pass as reviewed by nobody.
 * Measured on the 2026-08-10 `bare-entity-ref` pass: 93 records classified, 99
 * acked, six discarded unseen. The gap is the pass's duration times the
 * detector's fire rate, so the busiest log — the one most worth reviewing —
 * loses the most.
 *
 * The receipt is the fix: the read sweep says what it showed, and the ack
 * honors that rather than re-measuring. Same shape as `computeDryRunToken` in
 * `packages/domain/src/tasks/bulk-edit.ts`, with one deliberate difference —
 * bulk-edit ABORTS on drift because drift means the world moved under an
 * approval, whereas records arriving mid-pass here are expected and benign, so
 * the ack advances to the bound count and REPORTS the tail instead of refusing.
 *
 * NOT a security boundary. The checksum detects truncation and corruption, not
 * forgery: a caller who hand-writes counts is lying to its own audit trail. The
 * bounds in `reconcileReviewReceipt` (never above the log, never below the
 * existing watermark) are what keep a wrong token from destroying data.
 */
export interface ReviewReceipt {
  /** ISO timestamp of the read-only sweep that issued this receipt. */
  issuedAt: string;
  /** Log path → the log's total fire count at read time. */
  counts: Record<string, number>;
  /**
   * The paths that were REVIEW-DUE when this receipt was issued — the set the
   * reviewer was actually shown, and classified against (mt#4391).
   *
   * Deliberately a SECOND field rather than a narrowing of `counts`, which
   * still covers every log that exists. The two bound different things and
   * both are needed: `counts` bounds HOW FAR a path may advance, `reviewDue`
   * bounds WHICH paths may advance at all. Narrowing `counts` instead would
   * break the property its own docblock records — that a receipt omitting a
   * log cannot ack it — for the case where a due log stops being due.
   *
   * The gap this closes: `computeReviewDueLogs` runs again at ack time against
   * live state, so a log that crosses a threshold DURING the pass is in the
   * ack's review-due set and was never in the reviewer's. Advancing it marks
   * its whole backlog reviewed by nobody. Measured on the 2026-08-21 pass:
   * `wall-of-text` sat one injected fire below the bar at sweep time, one
   * record arrived mid-pass, and the ack advanced its watermark 359 → 373 —
   * 14 records, 9 of them injected, that no reviewer ever saw.
   */
  reviewDue: string[];
  /**
   * Paths that WERE due at mint time but were withheld from the reviewer
   * because another pass held a claim on them (PR #3214 R1).
   *
   * These must not be advanced — this pass stood down on them, so it
   * classified nothing — but they are not `newlyDue` either, and reporting
   * them as such asserts a threshold crossing that never happened. Recording
   * the two separately is what lets the ack skip both for the RIGHT stated
   * reason.
   *
   * The alternative the review raised first — minting `reviewDue` from the
   * UNFILTERED due set — was rejected: it would make the ack advance exactly
   * the logs the skill told the reviewer to stand down on, which is this
   * task's own defect wearing different clothes.
   */
  claimHeldAtMint: string[];
}

/** Thrown when a supplied review token is malformed, corrupt, or impossible. */
export class InvalidReviewTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReviewTokenError";
  }
}

/** Length of the truncated checksum appended to a token. */
const REVIEW_TOKEN_CHECKSUM_CHARS = 16;

/** Canonical JSON for the receipt payload: keys sorted, so the hash is stable. */
function canonicalReceiptJson(receipt: ReviewReceipt): string {
  const sortedPaths = Object.keys(receipt.counts).sort();
  const counts: Record<string, number> = {};
  for (const path of sortedPaths) {
    counts[path] = receipt.counts[path] as number;
  }
  // Sorted for the same reason the `counts` keys are: the checksum must depend
  // on the receipt's CONTENT, never on the order a caller happened to build it
  // in — otherwise a token round-trips only when the iteration order matches.
  const reviewDue = [...receipt.reviewDue].sort();
  const claimHeldAtMint = [...receipt.claimHeldAtMint].sort();
  return JSON.stringify({ issuedAt: receipt.issuedAt, counts, reviewDue, claimHeldAtMint });
}

function receiptChecksum(payloadJson: string): string {
  return createHash("sha256")
    .update(payloadJson)
    .digest("hex")
    .slice(0, REVIEW_TOKEN_CHECKSUM_CHARS);
}

/**
 * Issue a receipt token over what THIS sweep observed.
 *
 * `counts` covers every log that EXISTS — not only the review-due ones, because
 * which logs are due can change between the read and the ack, and a receipt
 * that omits a log cannot ack it.
 *
 * `reviewDuePaths` is the orthogonal half (mt#4391): the paths this sweep
 * actually PRESENTED as due. Both are recorded because a path can change
 * membership in either direction between the read and the ack, and only one of
 * those directions is safe to follow. A log that STOPS being due is simply not
 * acked (the ack's own set excludes it); a log that STARTS being due mid-pass
 * would otherwise be advanced on a count nobody classified against.
 */
export function buildReviewToken(
  results: CalibrationLogResult[],
  issuedAt: string,
  reviewDuePaths: readonly string[],
  claimHeldPaths: readonly string[] = []
): string {
  const counts: Record<string, number> = {};
  for (const r of results) {
    counts[r.entry.path] = r.totalFires;
  }
  const payloadJson = canonicalReceiptJson({
    issuedAt,
    counts,
    reviewDue: [...reviewDuePaths],
    claimHeldAtMint: [...claimHeldPaths],
  });
  const payload = Buffer.from(payloadJson, "utf8").toString("base64url");
  return `${payload}.${receiptChecksum(payloadJson)}`;
}

/**
 * Decode a token back into its receipt, or throw `InvalidReviewTokenError`.
 *
 * Every rejection here is a REFUSAL to advance, never a silent fallback to the
 * ack-time count: falling back would restore the exact defect the receipt
 * exists to close, and would do it on the path where the caller believed it was
 * protected.
 */
export function parseReviewToken(token: string): ReviewReceipt {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InvalidReviewTokenError(
      "Review token is malformed (expected `<payload>.<checksum>`). Re-run the read-only sweep and pass the token it returns."
    );
  }
  const [payload, checksum] = parts as [string, string];
  let payloadJson: string;
  try {
    payloadJson = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    throw new InvalidReviewTokenError(
      "Review token payload is not valid base64url. Re-run the read-only sweep and pass the token it returns."
    );
  }
  if (receiptChecksum(payloadJson) !== checksum) {
    throw new InvalidReviewTokenError(
      "Review token checksum does not match its payload — the token was truncated or edited. Re-run the read-only sweep and pass the token it returns."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new InvalidReviewTokenError(
      "Review token payload is not valid JSON. Re-run the read-only sweep and pass the token it returns."
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidReviewTokenError("Review token payload is not an object.");
  }
  const { issuedAt, counts, reviewDue, claimHeldAtMint } = parsed as {
    issuedAt?: unknown;
    counts?: unknown;
    reviewDue?: unknown;
    claimHeldAtMint?: unknown;
  };
  if (typeof issuedAt !== "string" || typeof counts !== "object" || counts === null) {
    throw new InvalidReviewTokenError(
      "Review token payload is missing `issuedAt` or `counts`. Re-run the read-only sweep and pass the token it returns."
    );
  }
  // A token minted before mt#4391 carries no `reviewDue`, and there is no safe
  // reading of its absence: treating it as "every path is ackable" restores the
  // very defect the field exists to close, and doing so SILENTLY, on the one
  // path the caller believes is guarded. Rejecting costs one read-only re-run —
  // the same remedy every other rejection here prescribes — and tokens are
  // per-pass and never persisted, so the window in which one can be stale is a
  // single in-flight pass.
  if (!Array.isArray(reviewDue) || reviewDue.some((p) => typeof p !== "string")) {
    throw new InvalidReviewTokenError(
      "Review token payload is missing a valid `reviewDue` list — it predates mt#4391, which records " +
        "which logs the sweep actually presented as due. Without it an ack cannot tell a log you " +
        "classified from one that crossed its threshold while you worked. Re-run the read-only sweep " +
        "and pass the token it returns."
    );
  }
  const validated: Record<string, number> = {};
  for (const [path, count] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new InvalidReviewTokenError(
        `Review token carries a non-integer count for ${path}. Re-run the read-only sweep and pass the token it returns.`
      );
    }
    validated[path] = count;
  }
  // Absent is accepted as empty here, unlike `reviewDue` above, and the
  // asymmetry is deliberate: both fields ship in the same change, so a token
  // carrying a valid `reviewDue` and no `claimHeldAtMint` cannot be produced by
  // this code — only hand-written, which the docblock already says this is not
  // a boundary against. Empty is also the benign reading (no claims held), so
  // there is no silent-defect branch to protect. A present-but-wrong TYPE is
  // still rejected.
  if (
    claimHeldAtMint !== undefined &&
    (!Array.isArray(claimHeldAtMint) || claimHeldAtMint.some((p) => typeof p !== "string"))
  ) {
    throw new InvalidReviewTokenError(
      "Review token carries a malformed `claimHeldAtMint` list. Re-run the read-only sweep and pass the token it returns."
    );
  }
  return {
    issuedAt,
    counts: validated,
    reviewDue: reviewDue as string[],
    claimHeldAtMint: (claimHeldAtMint as string[] | undefined) ?? [],
  };
}

/** Outcome of checking a receipt against the log state at ack time. */
export interface ReceiptReconciliation {
  /** Log path → the count to write, taken from the receipt (never re-derived). */
  reviewedCounts: Record<string, number>;
  /** Records that arrived between the read sweep and the ack, per log. */
  midPassArrivals: { path: string; count: number }[];
  /** Paths whose receipt count sat BELOW the existing watermark, raised to it. */
  clampedPaths: string[];
  /**
   * Paths whose watermark was STRANDED above the log's record count and has
   * been RESET to 0, restoring their records to the review queue (mt#4941).
   *
   * The counterpart to {@link clampedPaths}, and disjoint from it by
   * construction: both describe a receipt count below the existing watermark,
   * and `watermarkStranded` decides which one it is. A stale token is clamped
   * UP to protect a prior pass's reviews; a stranded watermark is REPAIRED
   * down, because the records it counts live in a file that no longer holds
   * them and there are no prior-pass reviews left to protect.
   *
   * Named rather than left silent for the same reason `clampedPaths` is: a
   * repair that reports nothing is byte-identical to an ack that had nothing
   * to repair, and the strand this closes went a full day unnoticed precisely
   * because `watermarkAdvanced: true` beside 13 clamped paths read as success
   * (mt#4941 `## Measured, 2026-09-03`).
   */
  repairedPaths: string[];
  /** Ackable paths the receipt does not cover, so they cannot be advanced. */
  unreceiptedPaths: string[];
  /**
   * Paths the receipt PRESENTED as review-due that are no longer ackable at ack
   * time, because another pass advanced them first (mt#4408).
   *
   * The classification work this pass did on them was duplicated, and the
   * other pass's watermark stands. This is the LOST-ACK case, and before this
   * field existed it was the one concurrency outcome that produced no signal at
   * all: `driftedPaths` is computed per attempted WRITE, and a fully-lost ack
   * attempts none — `computeReviewDueLogs` returns an empty set, so
   * `reconcileReviewReceipt`'s loop body never runs and every diagnostic array
   * comes back `[]`. The reviewer is left with `watermarkAdvanced: false`,
   * which is byte-identical to an ack that had nothing to do.
   *
   * Distinct from {@link newlyDuePaths} (became due AFTER the mint — nobody
   * classified them) and {@link claimHeldPaths} (withheld at mint — this pass
   * was told to stand down). Those two say "not yours to advance"; this one
   * says "yours, and someone else got there first."
   *
   * Originating incident: mt#4408 R4, 2026-08-21 — two passes classified the
   * same four logs ~15 minutes apart, the loser's ack returned all-empty, and
   * the collision was found only by reading id-adjacent task numbers.
   */
  ackedByAnotherPass: string[];
  /**
   * Paths that became review-due AFTER the receipt was issued (mt#4391).
   *
   * Not advanced — nobody classified them — and named rather than dropped,
   * because a silent skip trades one invisible loss for another. Expect to see
   * these in the NEXT sweep's `reviewDue`.
   */
  newlyDuePaths: string[];
  /**
   * Paths that were due at mint time but held by ANOTHER pass's claim, so this
   * pass stood down on them (PR #3214 R1).
   *
   * Same disposition as `newlyDuePaths` — not advanced — and a different
   * REASON, which is why it is a separate field. Folding them together would
   * tell a reviewer a threshold was crossed when the log was simply someone
   * else's to review.
   */
  claimHeldPaths: string[];
}

/**
 * Reconcile a receipt against the current sweep, producing the counts to write.
 *
 * The three failure modes SC3 asks to be stated, and what each does:
 *
 *   - **Count ABOVE the log's current total** — impossible for a receipt this
 *     log issued (a JSONL only grows), so the token belongs to a different
 *     tree or the log was rotated. REJECTED outright: writing it would mark
 *     records reviewed that do not exist yet, and every future sweep would
 *     read them as already-seen the moment they land.
 *   - **Count BELOW the existing watermark, log NOT stranded** — a stale token
 *     from an earlier pass. CLAMPED UP to the watermark and named in
 *     `clampedPaths`: a watermark that moves backwards would re-open records a
 *     prior pass legitimately reviewed, which is the same data loss in the
 *     other direction.
 *   - **Count BELOW the existing watermark, log STRANDED** (mt#4941) — the
 *     watermark exceeds the log's own record count, so its basis is gone: the
 *     records it claims were reviewed do not live in this file any more (it was
 *     rotated, truncated, or re-rooted under it). RESET to 0 and named in
 *     `repairedPaths`, which leaves the log's live records unreviewed so the
 *     next sweep presents them normally — the receipt's count says what the
 *     sweep OBSERVED, and a stranded sweep observes records it showed nobody.
 *     Clamping here is exactly wrong —
 *     there are no prior-pass reviews to protect, and raising the value back
 *     preserves the strand, which leaves the log permanently review-due with
 *     `firesSinceLastReview: 0` and nothing an in-tool action can clear.
 *
 *     The two cases are separated by `result.watermarkStranded`
 *     (`watermarkCount > totalFires`, computed in `computeLogResult` from both
 *     operands while they are still in hand) — NOT by the receipt, which looks
 *     identical either way. Until mt#4941 only the first case existed, so every
 *     stranded log's ack silently re-wrote the value that stranded it: measured
 *     2026-09-03, an ack over 13 stranded logs returned `watermarkAdvanced:
 *     true` with all 13 in `clampedPaths` and every stored count unchanged.
 *   - **Path absent from the receipt** — the read sweep never showed this log,
 *     so nothing is known about what was classified. NOT advanced, and named
 *     in `unreceiptedPaths`. Advancing on a guess is the defect.
 *   - **Path present in `counts` but NOT in `reviewDue`** (mt#4391) — the sweep
 *     saw the log and did not present it as due, so the reviewer never
 *     classified it; it crossed a threshold during the pass. NOT advanced, and
 *     named in `newlyDuePaths`. This is the SET half of the same discipline the
 *     bullets above apply to the COUNT: the receipt says what was reviewed, and
 *     the ack honors it rather than re-deriving from live state.
 *   - **Path in `claimHeldAtMint`** (PR #3214 R1) — due at mint time, but
 *     another pass held a claim on it, so this reviewer was told to stand down
 *     and classified nothing. Same disposition as the bullet above, DIFFERENT
 *     reason, and named in `claimHeldPaths` so the report does not assert a
 *     threshold crossing that never happened.
 */
export function reconcileReviewReceipt(
  receipt: ReviewReceipt,
  results: CalibrationLogResult[],
  ackablePaths: Set<string>,
  watermarks: WatermarkStore
): ReceiptReconciliation {
  const reviewedCounts: Record<string, number> = {};
  const midPassArrivals: { path: string; count: number }[] = [];
  const clampedPaths: string[] = [];
  const repairedPaths: string[] = [];
  const unreceiptedPaths: string[] = [];
  const newlyDuePaths: string[] = [];
  const claimHeldPaths: string[] = [];
  const ackedByAnotherPass: string[] = [];
  const receiptReviewDue = new Set(receipt.reviewDue);
  const receiptClaimHeld = new Set(receipt.claimHeldAtMint);

  // Walk the RECEIPT's due set, not `results`, for the lost-ack case (mt#4408).
  // The loop below is keyed on `ackablePaths`, so a path that left that set
  // between mint and ack is invisible to it — which is precisely the outcome
  // this detects. A path the reviewer was SHOWN and that is now un-ackable was
  // advanced by someone else; the watermark check distinguishes that from a
  // path that never advanced at all.
  for (const path of receipt.reviewDue) {
    if (ackablePaths.has(path)) continue;
    // Claim-held paths are already disjoint from `reviewDue` at MINT time —
    // `calibration.ts` passes the claim-FILTERED set as `reviewDuePaths` and
    // `claimedByOthers` separately, and `buildReviewToken` stores the two
    // verbatim without unioning them. This skip enforces that locally anyway
    // (PR #3227 R1): the invariant currently lives in a caller two files away,
    // and if a future one ever minted `reviewDue` from the UNFILTERED set, a
    // claim-held path would land here and be reported as a loss this pass
    // suffered — when in fact the pass was told to stand down and classified
    // nothing. Cheaper to enforce than to rely on.
    if (receiptClaimHeld.has(path)) {
      claimHeldPaths.push(path);
      continue;
    }
    const receiptCount = receipt.counts[path];
    const watermarkCount = watermarks[path]?.lastReviewedCount ?? 0;
    if (receiptCount !== undefined && watermarkCount >= receiptCount) {
      ackedByAnotherPass.push(path);
    }
  }

  for (const result of results) {
    const path = result.entry.path;
    if (!ackablePaths.has(path)) continue;

    // Order matters, and this is the more fundamental condition: absent from
    // `counts` means the sweep never saw the log AT ALL, which is a different
    // (and worse) situation than seeing it and not presenting it as due.
    // Testing `reviewDue` first would relabel every unreceipted log as
    // "newly due", which is both wrong and less alarming than the truth.
    const receiptCount = receipt.counts[path];
    if (receiptCount === undefined) {
      unreceiptedPaths.push(path);
      continue;
    }

    // The log was NOT presented to the reviewer, so nothing was classified in
    // it either way. Both branches below skip; they differ only in the reason
    // reported, and the reason is the whole value of naming it (PR #3214 R1).
    if (!receiptReviewDue.has(path)) {
      // Due at mint, withheld because a concurrent pass held it.
      if (receiptClaimHeld.has(path)) {
        claimHeldPaths.push(path);
        continue;
      }
      // Swept, not due then, due now. Its count is present and perfectly valid
      // — which is exactly why the count cannot answer this question, and why
      // the set had to be recorded separately (mt#4391).
      newlyDuePaths.push(path);
      continue;
    }
    if (receiptCount > result.totalFires) {
      throw new InvalidReviewTokenError(
        `Review token claims ${receiptCount} reviewed record(s) for ${path}, but the log holds ${result.totalFires}. ` +
          "A calibration log only grows, so this token was issued against a different tree or a rotated log. " +
          "Re-run the read-only sweep and pass the token it returns."
      );
    }

    const watermarkCount = watermarks[path]?.lastReviewedCount ?? 0;
    if (receiptCount < watermarkCount) {
      // Both dispositions arrive on this ONE condition, and `watermarkStranded`
      // is the whole difference between them (mt#4941).
      if (result.watermarkStranded) {
        repairedPaths.push(path);
        // RESET, not the receipt count — and this is the load-bearing choice.
        // A stranded log shows the reviewer nothing: `computeLogResult` sets
        // `firesSinceLastReview = max(0, totalFires - watermarkCount)` and
        // `newRecords = allRecords.slice(watermarkCount)`, both empty when the
        // watermark exceeds the count. So the receipt's count records what the
        // sweep OBSERVED, not what anyone classified, and writing it would mark
        // every live record reviewed by nobody — precisely the defect the
        // receipt exists to prevent (mt#3906). Zero leaves them unreviewed, so
        // the next sweep presents them through the normal past-threshold leg.
        //
        // It is also the recoverable branch, which is why it is the default
        // rather than a preference: an operator who would rather write the
        // backlog off can ack normally once these are due again, whereas
        // nothing can un-mark records reviewed — there is no set-watermark
        // affordance (mt#3752 `## Recovery status`).
        reviewedCounts[path] = 0;
      } else {
        clampedPaths.push(path);
        reviewedCounts[path] = watermarkCount;
      }
    } else {
      reviewedCounts[path] = receiptCount;
    }

    // A repaired log's whole corpus is now un-reviewed by design; calling that
    // a mid-pass arrival would report a restored backlog as records that landed
    // while the reviewer worked. `repairedPaths` already names it.
    const arrived = repairedPaths.includes(path)
      ? 0
      : result.totalFires - (reviewedCounts[path] as number);
    if (arrived > 0) {
      midPassArrivals.push({ path, count: arrived });
    }
  }

  return {
    reviewedCounts,
    midPassArrivals,
    clampedPaths,
    repairedPaths,
    unreceiptedPaths,
    newlyDuePaths,
    claimHeldPaths,
    ackedByAnotherPass,
  };
}

/**
 * Produce an updated watermark store by advancing marks for all logs that
 * have been acknowledged (acked).
 *
 * Only advances the mark for logs whose path is in `ackedPaths`.
 * Returns a new store (does not mutate the input).
 *
 * @param current    - current watermark store
 * @param results    - sweep results (the entries to walk; the COUNT written
 *                     comes from `reviewedCounts`, never from a result — see
 *                     mt#3906 and `reconcileReviewReceipt` above)
 * @param ackedPaths - set of log paths whose watermarks should be advanced
 * @param reviewedCounts - log path → the count the reviewer actually
 *                     classified, carried from the read-only sweep's receipt.
 *                     A path absent here is NOT advanced: this function has no
 *                     defensible count to write for it, and defaulting to the
 *                     ack-time total is precisely the mt#3906 defect.
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
  reviewedCounts: Record<string, number>,
  askId?: string
): WatermarkStore {
  const updated: WatermarkStore = { ...current };
  for (const result of results) {
    const path = result.entry.path;
    if (!ackedPaths.has(path)) continue;
    const reviewedCount = reviewedCounts[path];
    if (reviewedCount === undefined) continue;
    const priorOpenAskId = current[path]?.openAskId;
    const nextOpenAskId = askId ?? priorOpenAskId;
    updated[path] = {
      lastReviewedCount: reviewedCount,
      lastReviewedAt: now,
      ...(nextOpenAskId ? { openAskId: nextOpenAskId } : {}),
    };
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
 * Outcome of reconciling a pass's intended watermark write against the store
 * as it stands at write time (mt#3899).
 */
export interface WatermarkMergeResult {
  /** The store to persist: `fresh`, with this pass's non-drifted edits applied. */
  merged: WatermarkStore;
  /**
   * Target paths whose entry changed under the pass between its read and its
   * write. Their intended edit was DROPPED — the concurrent writer's value
   * stands. Sorted, so callers and tests get a stable order.
   */
  driftedPaths: string[];
}

/** True when two entries carry identical review state (absent === absent). */
function watermarkEntriesEqual(a?: LogWatermark, b?: LogWatermark): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.lastReviewedCount === b.lastReviewedCount &&
    a.lastReviewedAt === b.lastReviewedAt &&
    a.openAskId === b.openAskId
  );
}

/**
 * Reconcile a pass's intended watermark write against the store re-read
 * immediately before persisting (mt#3899).
 *
 * The command reads the store once, sweeps every calibration log — tens of
 * seconds of IO — decides what to advance, then writes the whole store back.
 * With concurrent agent sessions that read-modify-write races: a second pass
 * that acks mid-sweep is invisible to the first, whose whole-store write then
 * silently reverts it. The observed instance advanced one log's watermark to
 * its full fire count while another pass was mid-classification on exactly
 * those fires; nothing surfaced, because the losing write reported success.
 *
 * Two rules, both required:
 *
 * - **Start from `fresh`, not from the pass's stale snapshot.** An entry the
 *   pass never intended to touch keeps whatever the concurrent writer left
 *   there, so a whole-store rewrite cannot clobber an unrelated log.
 * - **Drop a target whose entry moved.** If `fresh` disagrees with `base` for
 *   a path this pass meant to change, another writer got there first; its
 *   value stands and the path is REPORTED rather than overwritten. Silently
 *   winning the race is the failure mode — a dropped edit the caller can see
 *   is recoverable, one it cannot is not.
 *
 * Last-writer-wins is preserved deliberately for the no-contention case: when
 * nothing changed underneath, `fresh` equals `base` and every intended edit
 * applies.
 *
 * @param base Store snapshot the pass computed its decisions from.
 * @param intended `base` with this pass's edits applied.
 * @param fresh Store as re-read immediately before writing.
 * @param targetPaths Paths this pass intends to change.
 */
export function mergeWatermarkWrite(
  base: WatermarkStore,
  intended: WatermarkStore,
  fresh: WatermarkStore,
  targetPaths: ReadonlySet<string>
): WatermarkMergeResult {
  const merged: WatermarkStore = { ...fresh };
  const driftedPaths: string[] = [];

  for (const path of targetPaths) {
    if (!watermarkEntriesEqual(base[path], fresh[path])) {
      driftedPaths.push(path);
      continue;
    }
    const next = intended[path];
    if (next) {
      merged[path] = next;
    } else {
      delete merged[path];
    }
  }

  driftedPaths.sort();
  return { merged, driftedPaths };
}

/**
 * Result of `selectAckablePaths` — which review-due logs may be advanced
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
 * Determine which review-due logs may be safely advanced (acked) in this
 * pass, and which must be skipped because they already carry a still-open
 * disposition ask (mt#2659).
 *
 * The caller decides WHICH logs are review-due and passes them in; this
 * function never re-derives that set. Callers should hand it the results
 * corresponding to `computeReviewDueLogs` output — all four legs, not just
 * `pastThreshold` (mt#2878). Handing it a narrower set silently makes the
 * ack-able set smaller than the set the cadence hook warns about, which is
 * exactly the defect mt#2878 fixed at the one call site.
 *
 * When `askId` is provided, the caller is explicitly (re)affirming an ask for
 * every result this call — ALL are ackable regardless of any pre-existing
 * `openAskId`.
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
  reviewDueResults: CalibrationLogResult[],
  askId?: string
): AckSelection {
  const ackablePaths = new Set<string>();
  const skippedOpenAskPaths: string[] = [];
  for (const r of reviewDueResults) {
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
  // mt#3286 — the log is named for the DEFECT it measures, the guard for the
  // moment it runs, so the two names differ and the mapping is required.
  "bare-entity-ref": "turn-end-bare-ref-scan",
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
  // mt#2459: this log is written by TWO GUARD_REGISTRY entries —
  // `operator-deferral-detector` (UserPromptSubmit prose surface) and
  // `operator-deferral-ask-surface` (PreToolUse AskUserQuestion surface) —
  // because they are two detection surfaces on ONE failure family and the
  // graduation decision needs them measured together. This map is 1:1 by
  // construction, so it names the PROSE surface as the log's canonical guard;
  // the per-record `matches[].category` field is what distinguishes which
  // surface actually fired, and `/calibration-review` reads that.
  "operator-deferral": "operator-deferral-detector",
  "untaken-action": "turn-end-untaken-action-scan",
  "retrospective-completeness": "retrospective-completeness-detector",
  "stop-at-decision": "stop-at-decision-scan",
};

/**
 * The guard name a calibration log's state attaches to, in the FIRE-LOG
 * name-space (mt#4009). The fire-log population uses `GuardRegistration`
 * names (`wall-of-text-detector`, `turn-end-bare-ref-scan`, ...), which is
 * exactly what {@link CALIBRATION_NAME_TO_GUARD_NAME} maps to — exported as
 * a function so consumers joining calibration state onto fire-log-derived
 * rows share THIS mapping instead of minting a second one (the
 * `stream-sources.ts` per-stream labels are a different name-space and do
 * NOT join against fire-log rows).
 */
export function guardNameForCalibrationLog(logName: string): string {
  return CALIBRATION_NAME_TO_GUARD_NAME[logName] ?? logName;
}

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
