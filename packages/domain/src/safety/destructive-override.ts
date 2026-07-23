/**
 * Shared destructive-action override contract (mt#3021).
 *
 * Layer-1 design decision (mt#3021 spec, "Layer-1 design decisions" §Shared
 * override contract): every defensive gate that refuses a destructive action
 * absent explicit confirmation — the mass-deletion sanity gate on
 * `session_commit` (SC3), the `MERGE_HEAD`/uncommitted-changes guard on
 * session delete/cleanup (SC2), and the Layer-2 liveness gates mt#3103-3106
 * are expected to add — MUST share ONE override mechanism rather than each
 * inventing its own. This module IS that mechanism.
 *
 * Deliberately NOT a bare boolean (an agent that has already reasoned itself
 * into "nothing of value is lost" — as the mt#3021 incident's deleting agent
 * did — passes a bare flag without pausing): the override requires a
 * non-empty `reason` string. Presence of a real reason IS the explicit
 * confirmation, mirroring `session cleanup`'s existing refuse-by-default +
 * explicit-second-call UX (`src/adapters/shared/commands/session/cleanup-command.ts`)
 * without introducing a second UX pattern.
 *
 * A successfully-used override is recorded as a structured, queryable
 * `guard.overridden` system event (not a log line) — see
 * `recordDestructiveOverride` below and the `SYSTEM_EVENT_TYPE_VALUES` doc
 * comment in `../storage/schemas/system-events-schema.ts`.
 *
 * NAMING NOTE (principal-reserved): `MINSKY_DESTRUCTIVE_OVERRIDE_REASON` and
 * the `destructiveOverrideReason` param name used by every consuming guard
 * are PLACEHOLDERS. Naming of new flags/params is a principal decision per
 * CLAUDE.md `§Principal Context`; this task flags the choice in its PR body
 * rather than deciding it unilaterally. Renaming later is a mechanical
 * find-replace across the guard call sites plus this module.
 */
import { emitSystemEventFromProvider } from "../events/emit-best-effort";
import type { PersistenceProvider } from "../persistence/types";

/**
 * Env var escape hatch for non-interactive/CLI callers that can't easily
 * thread a structured param through (e.g. an operator running a one-off
 * `minsky session delete` from a shell). Setting it supplies BOTH the
 * confirmation AND the reason in one value — there is no way to set "just
 * confirm" without also providing the justification text, so this cannot
 * degrade into the bare-boolean pattern the structured param avoids.
 *
 * Registered in `HOOK_ONLY_ENV_VARS`
 * (`packages/domain/src/configuration/sources/environment.ts`) per
 * `custom/no-unregistered-minsky-env-var`.
 */
export const DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR = "MINSKY_DESTRUCTIVE_OVERRIDE_REASON";

/**
 * The override contract every destructive-action guard consumes.
 *
 * `reason` is the only field. There is intentionally no separate `confirm:
 * true` boolean — requiring a non-empty reason already forces a deliberate,
 * non-mechanical act; adding a redundant boolean would just give the caller
 * a second bare flag to set thoughtlessly alongside the reason.
 */
export interface DestructiveOverrideInput {
  /** Required justification. Becomes part of the structured audit record. */
  reason: string;
}

/** True only for a genuinely-supplied, non-empty reason. */
export function isValidDestructiveOverride(
  override: DestructiveOverrideInput | undefined | null
): override is DestructiveOverrideInput {
  return !!override && typeof override.reason === "string" && override.reason.trim().length > 0;
}

/**
 * Resolve an override from an explicit caller-supplied reason string, falling
 * back to the `MINSKY_DESTRUCTIVE_OVERRIDE_REASON` env var when the caller
 * didn't supply one. Callers pass whatever raw (possibly undefined) reason
 * string their own param surface received; this normalizes it into the
 * shared contract shape (or `undefined` if neither source is present).
 */
export function resolveDestructiveOverride(
  explicitReason: string | undefined
): DestructiveOverrideInput | undefined {
  const candidate: DestructiveOverrideInput | undefined =
    typeof explicitReason === "string" && explicitReason.trim().length > 0
      ? { reason: explicitReason.trim() }
      : undefined;
  if (isValidDestructiveOverride(candidate)) return candidate;

  const envReason = process.env[DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR];
  if (typeof envReason === "string" && envReason.trim().length > 0) {
    return { reason: envReason.trim() };
  }
  return undefined;
}

/** Parameters for recording a used override as a structured audit event. */
export interface RecordDestructiveOverrideParams {
  /** Which guard fired — e.g. "session-commit-mass-deletion", "session-delete-git-state". */
  guard: string;
  reason: string;
  /** Guard-specific context (deletion count, reasonCode, affected paths sample, ...). */
  details?: Record<string, unknown>;
  /** Best-effort — absent persistence degrades to a no-op, never throws (mt#2092 contract). */
  persistenceProvider?: PersistenceProvider;
  actor?: string;
  relatedTaskId?: string;
  relatedSessionId?: string;
}

/**
 * Records a `guard.overridden` system event for a destructive-action guard
 * that was tripped and then overridden. Satisfies mt#3021 success criterion
 * 4 / acceptance test 6 ("the override audit record is queryable after the
 * fact"). Never throws; returns whether the row was actually persisted
 * (mirrors `emitSystemEventFromProvider`'s contract) so a caller with its own
 * dedup/retry state could gate on it, though no current consumer needs to.
 */
export async function recordDestructiveOverride(
  params: RecordDestructiveOverrideParams
): Promise<boolean> {
  return emitSystemEventFromProvider(params.persistenceProvider, {
    eventType: "guard.overridden",
    payload: {
      guard: params.guard,
      reason: params.reason,
      ...(params.details ?? {}),
    },
    actor: params.actor,
    relatedTaskId: params.relatedTaskId,
    relatedSessionId: params.relatedSessionId,
  });
}
