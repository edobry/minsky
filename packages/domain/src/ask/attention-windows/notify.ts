/**
 * Postgres NOTIFY events for attention window state transitions — mt#1489.
 *
 * Emits `pg_notify` on the following channels when windows open or close:
 *   - `minsky.attention_window_opened`  payload: WindowOpenedPayload
 *   - `minsky.attention_window_closed`  payload: WindowClosedPayload
 *
 * Uses the existing persistence-provider `getRawSqlConnection` path (same
 * pattern as `src/adapters/shared/commands/tasks/embeddings-repair-command.ts`).
 * Does NOT introduce a new infrastructure layer.
 *
 * The `WindowNotifier` interface is injected so unit tests can verify
 * emission without a live Postgres connection.
 */

import type { AppContainerInterface } from "../../composition/types";
import type { SqlCapablePersistenceProvider } from "../../persistence/types";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface WindowOpenedPayload {
  windowKey: string;
  openedAt: string; // ISO-8601
  durationMin: number;
  expectedCloseAt: string; // ISO-8601
}

export interface WindowClosedSummary {
  servedCount: number;
  reBatchedCount: number;
  escalatedCount: number;
  droppedCount: number;
}

export interface WindowClosedPayload {
  windowKey: string;
  closedAt: string; // ISO-8601
  summary?: WindowClosedSummary;
}

// ---------------------------------------------------------------------------
// Notifier interface (injectable, testable)
// ---------------------------------------------------------------------------

/**
 * Thin abstraction over Postgres NOTIFY for attention window events.
 * The production implementation shells through `getRawSqlConnection`;
 * tests inject a stub that records emissions.
 */
export interface WindowNotifier {
  notifyOpened(payload: WindowOpenedPayload): Promise<void>;
  notifyClosed(payload: WindowClosedPayload): Promise<void>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

const CHANNEL_OPENED = "minsky.attention_window_opened";
const CHANNEL_CLOSED = "minsky.attention_window_closed";

/**
 * Emit `pg_notify` via the raw postgres connection.
 *
 * Returns null when the persistence provider does not support SQL (e.g., in
 * bare-CLI mode without DB). Callers should log a warning and continue.
 */
async function pgNotify(
  container: AppContainerInterface | undefined,
  channel: string,
  payload: unknown
): Promise<void> {
  if (!container?.has("persistence")) {
    log.warn(`window notify: no persistence container — skipping NOTIFY on ${channel}`);
    return;
  }

  let sql: unknown;
  try {
    const provider = container.get("persistence") as SqlCapablePersistenceProvider;
    if (!provider.getRawSqlConnection) {
      log.warn(
        `window notify: provider has no getRawSqlConnection — skipping NOTIFY on ${channel}`
      );
      return;
    }
    sql = await provider.getRawSqlConnection();
  } catch (err) {
    log.warn(
      `window notify: could not obtain SQL connection — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (!sql) {
    log.warn(`window notify: getRawSqlConnection returned null — skipping NOTIFY on ${channel}`);
    return;
  }

  try {
    // Use a type assertion for the postgres.js Sql client (same pattern as embeddings commands).
    const pgSql = sql as import("postgres").Sql;
    const payloadStr = JSON.stringify(payload);
    await pgSql.unsafe(`SELECT pg_notify($1, $2)`, [channel, payloadStr]);
  } catch (err) {
    // Log but don't rethrow — NOTIFY failure must not kill the window open/close
    // operation itself. The window is opened/closed in-process; the NOTIFY is
    // a side-channel for Cockpit / external subscribers.
    log.warn(
      `window notify: pg_notify failed on ${channel} — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Create a `WindowNotifier` backed by the real Postgres connection in `container`.
 *
 * Pass `container` from the command execution context's DI container. When
 * the container is absent (bare CLI, unit tests), the notifier logs warnings
 * and returns cleanly without throwing.
 */
export function createPostgresWindowNotifier(
  container: AppContainerInterface | undefined
): WindowNotifier {
  return {
    async notifyOpened(payload: WindowOpenedPayload): Promise<void> {
      await pgNotify(container, CHANNEL_OPENED, payload);
    },
    async notifyClosed(payload: WindowClosedPayload): Promise<void> {
      await pgNotify(container, CHANNEL_CLOSED, payload);
    },
  };
}

/**
 * Create a no-op `WindowNotifier` for environments without Postgres (tests, offline CLI).
 */
export function createNoopWindowNotifier(): WindowNotifier {
  return {
    async notifyOpened(_payload: WindowOpenedPayload): Promise<void> {},
    async notifyClosed(_payload: WindowClosedPayload): Promise<void> {},
  };
}

/**
 * Create a recording `WindowNotifier` for unit tests.
 * Captures emitted payloads in arrays for assertion.
 */
export function createRecordingWindowNotifier(): WindowNotifier & {
  openedEvents: WindowOpenedPayload[];
  closedEvents: WindowClosedPayload[];
} {
  const openedEvents: WindowOpenedPayload[] = [];
  const closedEvents: WindowClosedPayload[] = [];
  return {
    openedEvents,
    closedEvents,
    async notifyOpened(payload: WindowOpenedPayload): Promise<void> {
      openedEvents.push(payload);
    },
    async notifyClosed(payload: WindowClosedPayload): Promise<void> {
      closedEvents.push(payload);
    },
  };
}
