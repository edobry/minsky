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
  return [...names].sort();
}
