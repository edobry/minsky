/**
 * Best-effort system-event emission from the shared-command layer (mt#2489).
 *
 * Resolves the persistence provider from the DI container, and — only when it
 * is SQL-capable — emits a `system_events` row via the best-effort
 * `DrizzleEventEmitter`. Never throws: event emission must never affect the
 * primary operation's outcome (mt#2092's non-fatal emit contract). When
 * persistence is absent or non-SQL (CLI without a DB, tests), it is a silent
 * no-op.
 *
 * This DRYs the provider→db→emitter dance that `emitTaskStatusChangedEvent`
 * (status-commands.ts, mt#2340) does inline; new container-holding command
 * seams (memory.created, ask.answered, …) call this instead of re-deriving it.
 */
import { log } from "@minsky/shared/logger";
import type { SystemEventInput } from "@minsky/domain/events/emitter";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

/** Minimal DI-container shape these command seams expose. */
interface ContainerLike {
  has(key: string): boolean;
  get(key: string): unknown;
}

export async function emitSystemEventBestEffort(
  container: ContainerLike | undefined,
  event: SystemEventInput
): Promise<void> {
  try {
    const persistence = container?.has("persistence") ? container.get("persistence") : undefined;
    if (!persistence) return;

    const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
    if (!(persistence instanceof PersistenceProvider)) return;
    if (!persistence.capabilities?.sql || typeof persistence.getDatabaseConnection !== "function") {
      return;
    }

    // Cast to the SQL-capable subinterface so getDatabaseConnection() is typed
    // as PostgresJsDatabase (the base PersistenceProvider returns unknown) —
    // mirrors emitTaskStatusChangedEvent in status-commands.ts.
    const sqlProvider = persistence as SqlCapablePersistenceProvider;
    const db = await sqlProvider.getDatabaseConnection();
    if (!db) return;

    const { DrizzleEventEmitter } = await import("@minsky/domain/events/emitter");
    await new DrizzleEventEmitter(db).emit(event);
  } catch (err: unknown) {
    log.warn(`${event.eventType}: system-event emission failed (best-effort, swallowed)`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
