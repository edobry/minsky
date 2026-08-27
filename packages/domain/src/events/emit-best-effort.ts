/**
 * Best-effort system-event emission from a directly-held PersistenceProvider
 * (mt#2537).
 *
 * Mirrors `emitSystemEventBestEffort` in
 * `src/adapters/shared/commands/system-event-emit.ts`, which resolves the
 * persistence provider from a DI container. This variant is for domain-layer
 * seams that already hold a `PersistenceProvider` directly — e.g.
 * `SessionPrDependencies.persistenceProvider` in `session-pr-operations.ts`
 * (the `changeset.created` emit site) and `session-merge-operations.ts`'s
 * `deps.persistenceProvider` (the `pr.merged` emit site) — and have no
 * container to resolve it from.
 *
 * Never throws: event emission must never affect the primary operation's
 * outcome (mt#2092's non-fatal emit contract). When persistence is absent or
 * non-SQL (CLI without a DB, tests), this is a silent no-op.
 *
 * Returns `true` only when the event row was actually persisted; `false` on
 * every no-op and swallowed-error path. Fire-and-forget callers may ignore
 * the return; callers with their own dedup/retry state (e.g. the
 * `deploy.smoke` sweep's once-per-commit flag) MUST gate state advancement on
 * it — otherwise a transient no-op (DB not yet up at boot, provider absent)
 * permanently suppresses the event.
 */
import { log } from "@minsky/shared/logger";
import type { PersistenceProvider, SqlCapablePersistenceProvider } from "../persistence/types";
import type { SystemEventInput } from "../storage/schemas/system-events-schema";
// Type-only: erased at runtime, so this does NOT make the emitter module a
// static dependency — the value import below stays dynamic, as it was.
import type { EventEmitterWithTryEmit } from "./emitter";
import { getLoggableErrorSummary } from "../errors/index";

/**
 * Build an emitter from a directly-held provider, or `null` when persistence is
 * absent or non-SQL (mt#4218).
 *
 * Extracted from {@link emitSystemEventFromProvider}, whose body this was, so a
 * caller that needs the EMITTER rather than a single emission can reach the same
 * construction instead of re-deriving it. `EmbeddingsHealthTracker` is that
 * caller: its `registerEventEmitterBuilder` seam (mt#2568) takes a builder, not
 * an event, because it decides at emit time whether to emit at all.
 *
 * Before this extraction there were two independent copies of these four steps —
 * this function's body and `buildEmbeddingsEventEmitter` in the MCP
 * start-command — and adding the cockpit and CLI hosts would have made a third
 * and fourth. Never throws; a failure resolves to `null` and is logged by the
 * caller that has the event context.
 */
export async function buildEventEmitterFromProvider(
  persistenceProvider: PersistenceProvider | undefined
): Promise<EventEmitterWithTryEmit | null> {
  if (!persistenceProvider) return null;

  // Duck-type the SQL capability rather than `instanceof PersistenceProvider`
  // — mirrors emitSystemEventBestEffort's rationale (brittle across DI/test
  // bindings that structurally, not nominally, implement the interface).
  const candidate = persistenceProvider as SqlCapablePersistenceProvider;
  if (typeof candidate.getDatabaseConnection !== "function") return null;

  const db = await candidate.getDatabaseConnection();
  if (!db) return null;

  const { DrizzleEventEmitter } = await import("./emitter");
  return new DrizzleEventEmitter(db);
}

export async function emitSystemEventFromProvider(
  persistenceProvider: PersistenceProvider | undefined,
  event: SystemEventInput
): Promise<boolean> {
  try {
    const emitter = await buildEventEmitterFromProvider(persistenceProvider);
    if (!emitter) return false;

    // tryEmit, not emit: DrizzleEventEmitter.emit swallows insert failures
    // internally, and postgres.js connects lazily — a down DB surfaces at the
    // INSERT, so only the insert's own success signal is trustworthy here.
    return await emitter.tryEmit(event);
  } catch (err: unknown) {
    log.warn(`${event.eventType}: system-event emission failed (best-effort, swallowed)`, {
      error: getLoggableErrorSummary(err),
    });
    return false;
  }
}
