/**
 * Composition root for the principal channel (mt#3228).
 *
 * Binds the poller to its real collaborators — Telegram credentials, the
 * append-only event log, the driven-session actuator, the ask substrate — and
 * decides whether the channel runs at all.
 *
 * ## Opt-in, deliberately
 *
 * The channel does NOT auto-enable just because Telegram credentials resolve,
 * even though they already do on this deployment (the reviewer's alert sink put
 * them there). An inbound message becomes a user turn in a local `claude`
 * process; starting that off the mere PRESENCE of a credential provisioned for
 * a different purpose would be a silent capability escalation. It starts when
 * `MINSKY_PRINCIPAL_CHANNEL_ENABLED` says so.
 *
 * @see mt#3228 — the bidirectional principal channel
 * @see ./principal-channel-poller.ts — the loop this starts
 * @see ./principal-channel-actuator.ts — what carries out the decisions
 */

import { log } from "@minsky/shared/logger";
import { resolvePrincipalChannel } from "@minsky/domain/notify/principal-channel";
import { inboundEventToken } from "@minsky/domain/notify/principal-inbound";
import type { PrincipalMessageEventPayload } from "@minsky/domain/notify/principal-inbound";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { createDrivenSessionActuator } from "./principal-channel-actuator";
import {
  startPrincipalChannelPoller,
  type InboundEventRecorder,
  type PollCursor,
  type PollerHandle,
} from "./principal-channel-poller";
import type { PermissionMode } from "./driven-session-host";

const RECEIVED_EVENT = "principal.message_received";

export interface PrincipalChannelLaunchConfig {
  enabled: boolean;
  cwd: string;
  permissionMode: PermissionMode;
}

/**
 * Read the channel's launch settings from the environment.
 *
 * The permission mode is read as an explicit opt-DOWN ("default" tightens it):
 * an unrecognized value falls back to the same mode every other driven session
 * uses rather than to the strict mode, so a typo cannot silently produce a
 * channel that answers but can never act — a failure that looks like the agent
 * being unhelpful rather than like a misconfiguration.
 */
export function loadPrincipalChannelLaunchConfig(
  env: NodeJS.ProcessEnv = process.env
): PrincipalChannelLaunchConfig {
  return {
    enabled: env["MINSKY_PRINCIPAL_CHANNEL_ENABLED"] === "true",
    cwd: env["MINSKY_PRINCIPAL_CHANNEL_CWD"] || process.cwd(),
    permissionMode:
      env["MINSKY_PRINCIPAL_CHANNEL_PERMISSION_MODE"] === "default"
        ? "default"
        : "bypassPermissions",
  };
}

/**
 * Poll cursor backed by the append-only inbound event log.
 *
 * There is no separate cursor table: the audit row IS the cursor. `write` is a
 * no-op because the row the poller already recorded carries the update id, and
 * a second store would be a second source of truth that can disagree with the
 * first.
 */
export function createEventLogCursor(
  readHighestUpdateId: () => Promise<number | undefined>
): PollCursor {
  return {
    read: readHighestUpdateId,
    write: async () => {
      // Intentionally empty — see this function's doc comment.
    },
  };
}

interface DbLike {
  execute: (query: unknown) => Promise<unknown>;
}

async function getDb(container: AppContainerInterface | undefined): Promise<DbLike | null> {
  if (!container?.has("persistence")) return null;
  try {
    const provider = container.get("persistence") as SqlCapablePersistenceProvider;
    if (!provider.getDatabaseConnection) return null;
    const db = await provider.getDatabaseConnection();
    return (db as DbLike | null) ?? null;
  } catch (err: unknown) {
    log.warn("[principal-channel] persistence unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Start the channel, or explain why it did not start.
 *
 * Returns null rather than throwing on every not-running path: this is called
 * from daemon startup, where a missing Telegram credential must not prevent the
 * cockpit from booting.
 */
export async function startPrincipalChannel(opts: {
  container?: AppContainerInterface;
  config?: PrincipalChannelLaunchConfig;
  respondToAsk: (askRef: string, text: string) => Promise<string>;
  recordEvent: InboundEventRecorder;
  readHighestUpdateId: () => Promise<number | undefined>;
}): Promise<PollerHandle | null> {
  const config = opts.config ?? loadPrincipalChannelLaunchConfig();
  if (!config.enabled) return null;

  const resolution = await resolvePrincipalChannel();
  if (!resolution.configured) {
    log.warn("[principal-channel] enabled but not configured; not starting", {
      reason: resolution.reason,
    });
    return null;
  }

  const { token, chatId } = resolution.config;
  const actuator = createDrivenSessionActuator({
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    respondToAsk: opts.respondToAsk,
  });

  log.info("[principal-channel] inbound poller started", {
    chatId,
    cwd: config.cwd,
    permissionMode: config.permissionMode,
  });

  return startPrincipalChannelPoller({
    token,
    chatId,
    // The discovered chat id IS the allowlist. A 1:1 private chat has exactly
    // one other participant, so no separate sender list is needed here.
    auth: { allowedChatId: chatId },
    actuator,
    cursor: createEventLogCursor(opts.readHighestUpdateId),
    recordEvent: opts.recordEvent,
  });
}

/**
 * Read the highest Telegram update id this daemon has already recorded.
 *
 * Reads BOTH event types: a rejected message advances the cursor too, or one
 * unauthorized message would be re-fetched on every restart forever.
 */
export function createHighestUpdateIdReader(
  container: AppContainerInterface | undefined
): () => Promise<number | undefined> {
  return async () => {
    const db = await getDb(container);
    if (!db) return undefined;
    try {
      const { sql } = await import("drizzle-orm");
      const rows = (await db.execute(
        sql`SELECT MAX((payload->>'updateId')::bigint) AS max_id
            FROM system_events
            WHERE event_type IN ('principal.message_received', 'principal.message_rejected')`
      )) as Array<{ max_id: string | number | null }>;
      const raw = rows[0]?.max_id;
      if (raw === null || raw === undefined) return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch (err: unknown) {
      // A cursor read failure means a cold start, which the idempotency token
      // makes safe: Telegram replays at most 24h and every replayed update
      // carries a token that already exists in the log.
      log.warn("[principal-channel] could not read the poll cursor; starting cold", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  };
}

/**
 * Build the append-only recorder, deduplicating on the idempotency token.
 *
 * The dedupe is what makes a cold start harmless. Telegram retains undelivered
 * updates for 24h, so a daemon that restarts without a readable cursor
 * re-receives up to a day of messages — without this check, every one of them
 * would be re-run against the swarm.
 */
export function createInboundEventRecorder(
  container: AppContainerInterface | undefined,
  onDuplicate?: (updateId: number) => void
): InboundEventRecorder {
  return async (eventType, payload: PrincipalMessageEventPayload) => {
    const db = await getDb(container);
    if (!db) throw new Error("persistence unavailable — cannot record the inbound audit event");

    const { sql } = await import("drizzle-orm");
    const token = inboundEventToken(payload.updateId);
    const existing = (await db.execute(
      sql`SELECT 1 FROM system_events
          WHERE event_type IN ('principal.message_received', 'principal.message_rejected')
            AND payload->>'token' = ${token}
          LIMIT 1`
    )) as unknown[];

    if (Array.isArray(existing) && existing.length > 0) {
      onDuplicate?.(payload.updateId);
      throw new DuplicateInboundUpdateError(payload.updateId);
    }

    await db.execute(
      sql`INSERT INTO system_events (event_type, payload, actor)
          VALUES (${eventType === RECEIVED_EVENT ? RECEIVED_EVENT : "principal.message_rejected"},
                  ${JSON.stringify(payload)}::jsonb,
                  'principal-channel')`
    );
  };
}

/**
 * Signals that an update was already recorded and must not be acted on again.
 *
 * A distinct type rather than a boolean return so the poller's existing
 * "recorder threw" path covers it: the message is skipped, loudly, without a
 * second control-flow branch.
 */
export class DuplicateInboundUpdateError extends Error {
  constructor(readonly updateId: number) {
    super(`Telegram update ${updateId} was already recorded; skipping replay`);
    this.name = "DuplicateInboundUpdateError";
  }
}
