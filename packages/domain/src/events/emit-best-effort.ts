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

export async function emitSystemEventFromProvider(
  persistenceProvider: PersistenceProvider | undefined,
  event: SystemEventInput
): Promise<boolean> {
  try {
    if (!persistenceProvider) return false;

    // Duck-type the SQL capability rather than `instanceof PersistenceProvider`
    // — mirrors emitSystemEventBestEffort's rationale (brittle across DI/test
    // bindings that structurally, not nominally, implement the interface).
    const candidate = persistenceProvider as SqlCapablePersistenceProvider;
    if (typeof candidate.getDatabaseConnection !== "function") return false;

    const db = await candidate.getDatabaseConnection();
    if (!db) return false;

    // tryEmit, not emit: DrizzleEventEmitter.emit swallows insert failures
    // internally, and postgres.js connects lazily — a down DB surfaces at the
    // INSERT, so only the insert's own success signal is trustworthy here.
    const { DrizzleEventEmitter } = await import("./emitter");
    return await new DrizzleEventEmitter(db).tryEmit(event);
  } catch (err: unknown) {
    log.warn(`${event.eventType}: system-event emission failed (best-effort, swallowed)`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
