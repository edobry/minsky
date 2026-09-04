/**
 * Shared calibration-log declaration accessor — mt#3716.
 *
 * A calibration log's PRODUCER is declared on one of three surfaces:
 *
 *   1. `GUARD_REGISTRY[].calibrationLog` (`.minsky/hooks/registry.ts`) — dispatcher-registered
 *      guards.
 *   2. `STANDALONE_GUARD_CANARIES[].calibrationLog` (`scripts/lib/standalone-guard-canaries.ts`)
 *      — standalone (non-dispatcher) guards wired directly in `.claude/settings.json`.
 *   3. `NON_GUARD_CALIBRATION_PRODUCERS` (below) — an explicit enumeration of producers that
 *      are not a guard at all (today just `ask-form-lint`, written from the `asks_create`
 *      command path).
 *
 * Before mt#3716, exactly ONE consumer (`scripts/check-coverage-receipts.ts`) read all three
 * surfaces to build its own local `Map<log, guard[]>` + non-guard set, and the calibration
 * SWEEP (`src/domain/calibration/calibration-sweep.ts`'s `runSweep`) read none of them — it
 * iterated a hand-maintained `CALIBRATION_LOG_REGISTRY` array that a human had to remember to
 * extend every time a new detector declared `calibrationLog`. Three detectors landed between
 * 2026-08-05 and 2026-08-10 that did exactly that correctly and were still invisible to the
 * sweep (`agent-dispatch-record`, `chained-verification-commands`, `duplicate-signature-scan`)
 * — the declaration-drift class ADR-028 §D4 names.
 *
 * This module is the ONE shared accessor mt#3742 SC5 requires: `check-coverage-receipts.ts` and
 * the calibration-sweep derivation (`src/domain/calibration/calibration-sweep.ts`'s
 * `deriveCalibrationLogEntries`, consumed from `.minsky/hooks/calibration-review-cadence-detector.ts`
 * and `src/adapters/shared/commands/calibration.ts`) both read it — nobody re-derives the union
 * a second time.
 *
 * Lives under `scripts/lib/` (not `src/` and not `.minsky/hooks/`) because it is the one place
 * both source surfaces are safely reachable: `scripts/` already has established precedent for
 * importing directly from `.minsky/hooks/` (see `scripts/lib/standalone-guard-canaries.ts`'s own
 * header comment, and `scripts/check-coverage-receipts.ts`), while `src/` deliberately does NOT
 * cross that boundary (`.minsky/hooks/` is a dependency-free tree per its own SPEC.md invariant;
 * `src/domain/calibration/calibration-sweep.ts` and `src/mcp/guard-health-tracker.ts` both
 * document "no established precedent for reaching across that boundary" and duplicate shapes
 * instead of importing). `GUARD_REGISTRY`'s entries hold `module: () => import(...)`, so
 * importing the registry for its `calibrationLog` metadata does not load any guard module.
 *
 * @see mt#3716 — this task
 * @see mt#3742 — the coverage-receipts task whose SC5 this satisfies
 * @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md §D4 — governing decision
 */

import { GUARD_REGISTRY } from "../../.minsky/hooks/registry";
import { STANDALONE_GUARD_CANARIES } from "./standalone-guard-canaries";

/**
 * Calibration logs written by something that is NOT a guard (mt#3519, resolved by mt#3716 SC2).
 *
 * `ask-form-lint` is the standing case: the log is written by
 * `src/adapters/shared/commands/ask-form-lint-calibration.ts` on the `asks_create` command
 * path, not by any hook. It has no guard name, no dispatcher invocation, and no canary — so
 * neither declaration mechanism can reach it, and it is NOT the "no guard declares this" defect
 * `Unmapped` (in `check-coverage-receipts.ts`) reports.
 *
 * mt#3716 SC2 resolution: this log's original (mt#2798) header comment deferred registering it
 * in `CALIBRATION_LOG_REGISTRY` until it "accumulated enough fires to be worth a first review
 * pass." At 35+ fires over 21+ days that trigger was met; rather than hand-add a 17th literal
 * entry to that array (the anti-pattern this task's governing ADR-028 §D4 amendment rejects),
 * it is enumerated HERE — the same treatment every other non-guard-producer declaration gets —
 * so `getDeclaredCalibrationLogNames()` below includes it, and the derived sweep entries
 * (`deriveCalibrationLogEntries` in `src/domain/calibration/calibration-sweep.ts`) pick it up
 * automatically.
 *
 * A log listed here is EXEMPT from the invocation-evidence join
 * (`check-coverage-receipts.ts`'s `buildInvocationEvidence`), not from review: its records still
 * feed the calibration sweep exactly as before.
 */
export const NON_GUARD_CALIBRATION_PRODUCERS: Record<string, string> = {
  "ask-form-lint":
    "src/adapters/shared/commands/ask-form-lint-calibration.ts (asks_create command path, not a hook)",
};

/**
 * Logs whose producer was RETIRED — deleted on purpose, as of a date.
 *
 * The fourth declaration surface, and the one the model was missing. The other three all answer
 * "who writes this log?" with a producer that exists; none could say "nobody, deliberately." So
 * when a detector is retired and its log is deliberately KEPT as evidence, the log falls off
 * every declaration surface at once and `check-coverage-receipts.ts` reports it as FLAGGED —
 * "no live fires AND no invocation evidence," which reads as a dead entry point somebody must
 * investigate. That is a false anomaly, permanently, on every run.
 *
 * A log listed here is EXCLUDED from the coverage results for the same reason
 * `NON_GUARD_CALIBRATION_PRODUCERS` is, stated in that check's own words: `FLAGGED` asserts "no
 * evidence the entry point ran", and for a log with no entry point to instrument that is a FALSE
 * claim, not a weak one. It is reported in its own category instead, so the exclusion is visible
 * rather than a silent drop.
 *
 * This is NOT a mute for a detector that has merely gone quiet. A live detector with zero fires
 * and zero invocations is exactly the "shipped is not firing" defect the check exists to catch,
 * and it must still be FLAGGED. The entry here is a claim that the producer is GONE from the
 * tree — verifiable by its absence, not by its silence.
 *
 * Originating incident: mt#4197 retired the policy-coverage detector (Surface 1) and correctly
 * kept its 1,760-record log as the evidence the retirement rested on. Removing the standalone
 * canary took away the log's only invocation-evidence join, moving it from `[DORMANT]` (benign,
 * with 6,108 invocations behind it) to `[FLAGGED]` — worse than the state mt#4197's own criterion
 * was written to prevent. Found by running the check post-merge, which is also why mt#4197's PR
 * body carried the opposite prediction: the check cannot run from a session workspace (no
 * calibration logs in a fresh clone), so the claim was reasoned rather than observed.
 *
 * @see mt#4204 — this fix
 * @see mt#4197 — the retirement that surfaced the gap
 * @see scripts/check-coverage-receipts.ts — the consumer
 */
export const RETIRED_CALIBRATION_PRODUCERS: Record<string, string> = {
  "stop-at-decision":
    "stop-at-decision-scan (mt#3653), retired 2026-09-04 by mt#4978 per ask#11629 — hook, its shared handoff-status predicate, the generated copies and four replay harnesses deleted. Three calibration windows and two corpus-derived marker widenings did not converge (82% -> 92% -> ~85% false; the last suppressed zero of ten), because the discharge check was a phrase list over an open-vocabulary closing sentence. Both logs are retained on disk as the retirement's evidence — they ARE the justification",
  "policy-coverage":
    "policy-coverage-detector (Surface 1), retired 2026-08-16 by mt#4197 — hook, domain modules and canary deleted; the 1,760-record log is retained on disk as the retirement's evidence",
};

/**
 * Map each calibration-log name to the guard name(s) that write it (mt#3502, moved from
 * `check-coverage-receipts.ts` by mt#3716 to be the one shared accessor).
 *
 * Derived from declarations, never from string matching. The two differ for real detectors —
 * calibration log `untaken-action` is guard `turn-end-untaken-action-scan`, `retrospective-trigger`
 * is `turn-end-retro-scan` — and a name-matching first pass reported both as having zero
 * invocations when they had 874 and 1531. Several logs are written by more than one guard
 * (`operator-deferral`, `retrospective-trigger`), so the value is a list.
 */
export function buildCalibrationLogToGuards(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (log: string, guard: string): void => {
    const existing = map.get(log);
    if (existing) existing.push(guard);
    else map.set(log, [guard]);
  };
  // mt#3519: a declaration may name one log or several — the execution-evidence merge gate
  // writes two. The read side was always many-to-many; this makes the write side match.
  const addAll = (logs: string | string[], guard: string): void => {
    for (const log of Array.isArray(logs) ? logs : [logs]) add(log, guard);
  };
  for (const reg of GUARD_REGISTRY) {
    if (reg.calibrationLog) addAll(reg.calibrationLog, reg.name);
  }
  // Standalone guards are not in GUARD_REGISTRY; their canary declaration carries the same
  // join key.
  for (const canary of STANDALONE_GUARD_CANARIES) {
    if (canary.calibrationLog) addAll(canary.calibrationLog, canary.guardName);
  }
  return map;
}

/**
 * The union of every calibration-log NAME declared across all three surfaces — the set this
 * task (mt#3716) derives the swept registry from, per ADR-028 §D4's "the registration ... is
 * derivable from D2's registry rather than hardcoded per-log ... as it is today."
 *
 * Sorted for deterministic output (snapshot-friendly, stable diffs).
 */
export function getDeclaredCalibrationLogNames(): string[] {
  const names = new Set<string>();
  for (const reg of GUARD_REGISTRY) {
    if (!reg.calibrationLog) continue;
    for (const log of Array.isArray(reg.calibrationLog)
      ? reg.calibrationLog
      : [reg.calibrationLog]) {
      names.add(log);
    }
  }
  for (const canary of STANDALONE_GUARD_CANARIES) {
    if (!canary.calibrationLog) continue;
    for (const log of Array.isArray(canary.calibrationLog)
      ? canary.calibrationLog
      : [canary.calibrationLog]) {
      names.add(log);
    }
  }
  for (const name of Object.keys(NON_GUARD_CALIBRATION_PRODUCERS)) {
    names.add(name);
  }
  // mt#4204: a retired producer is still a DECLARATION — it answers "who writes this log?" with
  // "nobody, as of a date", which is an answer rather than a gap. Including it keeps this the
  // complete set of logs the repo knows about, so a consumer asking "is this log declared?"
  // gets `true` for a deliberately-retained one instead of treating it as an unexplained orphan.
  for (const name of Object.keys(RETIRED_CALIBRATION_PRODUCERS)) {
    names.add(name);
  }
  return [...names].sort();
}
