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
 * `principalChannel.enabled` says so — config rather than an env var (mt#3230)
 * because the tray spawns the daemon with the GUI session's environment, which
 * a shell `export` never reaches.
 *
 * @see mt#3228 — the bidirectional principal channel
 * @see ./principal-channel-poller.ts — the loop this starts
 * @see ./principal-channel-actuator.ts — what carries out the decisions
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import { getConfiguration } from "@minsky/domain/configuration/index";
import type { PrincipalChannelConfig } from "@minsky/domain/configuration/schemas/principal-channel";
import { resolvePrincipalChannel } from "@minsky/domain/notify/principal-channel";
import {
  inboundEventToken,
  type PrincipalMessageEventPayload,
} from "@minsky/domain/notify/principal-inbound";
import { createCachedSqlDbGetter, getServerAskRepository } from "./db-providers";
import { createDrivenSessionActuator } from "./principal-channel-actuator";
import {
  startPrincipalChannelPoller,
  type InboundEventRecorder,
  type PollCursor,
  type PollerHandle,
} from "./principal-channel-poller";
import type { PermissionMode } from "./driven-session-host";

/**
 * The channel's four event types.
 *
 * Every SQL comparison against them casts the column — `event_type::text IN
 * (...)` — because these arrive as BOUND PARAMETERS, which Postgres types as
 * `text` and refuses to compare against the `system_event_type` enum
 * ("operator does not exist: system_event_type = text"). An inline string
 * literal would coerce, a parameter does not (PR #2324 R2). The cast forgoes
 * the `event_type` index, which is irrelevant here: both queries are bounded
 * lookups over one channel's rows, not scans.
 */
const RECEIVED_EVENT = "principal.message_received";
const REJECTED_EVENT = "principal.message_rejected";
const FAILED_EVENT = "principal.message_failed";
const ADVANCED_EVENT = "principal.poll_advanced";

export interface PrincipalChannelLaunchConfig {
  enabled: boolean;
  cwd: string;
  permissionMode: PermissionMode;
  /** Explicit sender allowlist. Empty means "derive it" — see {@link resolveAllowedUserIds}. */
  allowedUserIds: string[];
}

/**
 * Decide which Telegram senders may drive the channel.
 *
 * Telegram gives a PRIVATE chat the same id as the user on the other end of
 * it, and a GROUP a negative id distinct from any user's. So:
 *
 * - private chat (positive id) — the chat id IS the sender id, so pinning the
 *   sender to it is exact, and it hardens the channel against a malformed or
 *   spoofed `from` in an update that otherwise matches the chat.
 * - group (negative id) — chat and sender are genuinely different things, and
 *   there is nothing to derive. Without an explicit list this stays chat-only,
 *   which means ANY member of that group can drive the swarm. Configure
 *   `principalChannel.allowedUserIds` for a group.
 *
 * Added in PR #2324 R1: the docs claimed `from.id` was checked while only the
 * chat id was enforced. This makes the claim true for the case that actually
 * ships (a discovered private chat) rather than walking the claim back.
 */
export function resolveAllowedUserIds(chatId: string, configured: string[]): string[] {
  if (configured.length > 0) return configured;
  return chatId.startsWith("-") ? [] : [chatId];
}

/**
 * Read the channel's launch settings from Minsky configuration.
 *
 * Config, not `process.env` directly (mt#3230). The env vars still work and
 * still win — they are registered as explicit paths into `principalChannel.*`
 * and the environment source merges last — but reading the CONFIG makes
 * enablement independent of how the daemon process was launched. That matters
 * because the tray spawns the daemon inheriting the macOS GUI session
 * environment, which a user's shell is not part of, so an `export` never
 * reached it.
 *
 * The permission mode stays an explicit opt-DOWN ("default" tightens it) and
 * an unparseable section falls back to the same mode every other driven
 * session uses: a broken config must not silently produce a channel that
 * answers but can never act — a failure that reads as an unhelpful agent
 * rather than a misconfiguration.
 */
export function loadPrincipalChannelLaunchConfig(
  section: Partial<PrincipalChannelConfig> = readPrincipalChannelSection()
): PrincipalChannelLaunchConfig {
  return {
    enabled: section.enabled === true,
    cwd: section.cwd && section.cwd.length > 0 ? section.cwd : process.cwd(),
    permissionMode: section.permissionMode === "default" ? "default" : "bypassPermissions",
    allowedUserIds: (section.allowedUserIds ?? []).filter((id) => id.trim().length > 0),
  };
}

/**
 * Read the `principalChannel` section, treating an unavailable config as absent.
 *
 * The cockpit daemon must boot even when configuration cannot be loaded, so a
 * failure here disables the channel rather than propagating — the same posture
 * `startPrincipalChannel` takes for a missing Telegram credential.
 */
function readPrincipalChannelSection(): Partial<PrincipalChannelConfig> {
  try {
    return getConfiguration().principalChannel ?? {};
  } catch (err: unknown) {
    log.warn("[principal-channel] could not read configuration; channel stays disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/**
 * Poll cursor backed by the append-only inbound event log.
 *
 * There is no separate cursor table — the log holds the position — but `write`
 * is NOT a no-op, and an earlier version of this that made it one was wrong
 * (PR #2324 R3).
 *
 * The reasoning that failed: "every accepted message already writes a row
 * carrying its update id, so MAX(updateId) over those rows is the cursor." True
 * only for updates that BECOME a message. Telegram also hands over updates this
 * version does not parse — an `edited_message`, a future type — and the poller
 * deliberately advances past them so one cannot wedge the channel. Those
 * updates produce no message row, so a message-row-derived cursor never covers
 * them, Telegram re-serves them next cycle, and the loop repeats forever.
 *
 * So a write beyond what the message rows cover records an explicit
 * `principal.poll_advanced` fact. It is not a second source of truth: it is the
 * same append-only log, holding the one fact the message rows cannot express.
 *
 * `write` re-reads the log first so the row is written ONLY when the message
 * rows fall short — i.e. only when an update really was skipped. The common
 * case (every update became a message) costs one cheap SELECT and writes
 * nothing, rather than doubling the log with a redundant row per cycle.
 */
export function createEventLogCursor(
  readHighestUpdateId: () => Promise<number | undefined>,
  recordAdvance: (updateId: number) => Promise<void>
): PollCursor {
  return {
    read: readHighestUpdateId,
    async write(updateId: number): Promise<void> {
      const covered = await readHighestUpdateId();
      if (covered !== undefined && covered >= updateId) return;
      await recordAdvance(updateId);
    },
  };
}

/** The narrow slice of a Drizzle connection this module needs. */
export type DbLike = Pick<PostgresJsDatabase, "execute">;

/** Supplies the DB connection. Matches the cockpit's own cached-getter style. */
export type DbGetter = () => Promise<DbLike | null>;

/**
 * The channel's DB handle.
 *
 * `cacheNegative: false` — unlike a read-only widget, a failed probe here must
 * not latch: the channel outlives a transient DB outage and needs to start
 * recording again once persistence recovers.
 */
const cachedChannelDb = createCachedSqlDbGetter({ cacheNegative: false });
export const getPrincipalChannelDb: DbGetter = async () => cachedChannelDb();

/**
 * Answer an ask from the channel, resolving the ref the principal typed.
 *
 * Returns human prose rather than a status object because the return value goes
 * straight to a phone: `asks.respond`'s own result shape would be noise there.
 */
export async function respondToAskFromChannel(askRef: string, text: string): Promise<string> {
  const repo = await getServerAskRepository();
  if (!repo) return "The ask store is unavailable right now — try again shortly.";

  try {
    const { respondToAsk } = await import("../adapters/shared/commands/asks");
    const { ask } = await respondToAsk(repo, {
      id: askRef,
      message: text,
      responder: "principal-channel",
    });
    return `Answered: ${ask.title ?? askRef}`;
  } catch (err: unknown) {
    // Relay the reason. "Answered" when it was not, or bare silence, are both
    // worse than a message saying which ask could not be resolved and why.
    return `Could not answer ${askRef}: ${err instanceof Error ? err.message : String(err)}`;
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
  config?: PrincipalChannelLaunchConfig;
  respondToAsk: (askRef: string, text: string) => Promise<string>;
  recordEvent: InboundEventRecorder;
  readHighestUpdateId: () => Promise<number | undefined>;
  onStarted?: (chatId: string) => void;
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

  const allowedUserIds = resolveAllowedUserIds(chatId, config.allowedUserIds);
  if (allowedUserIds.length === 0) {
    log.warn(
      "[principal-channel] group chat with no sender allowlist — ANY member of that group can " +
        "drive this swarm. Run: minsky config set principalChannel.allowedUserIds <id>[,<id>...]",
      { chatId }
    );
  }

  log.info("[principal-channel] inbound poller started", {
    chatId,
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    senderAllowlistSize: allowedUserIds.length,
  });
  opts.onStarted?.(chatId);

  return startPrincipalChannelPoller({
    token,
    chatId,
    auth: { allowedChatId: chatId, allowedUserIds },
    actuator,
    cursor: createEventLogCursor(opts.readHighestUpdateId, async (updateId) => {
      await opts.recordEvent("principal.poll_advanced", {
        // A distinct token so the recorder's dedupe does not confuse this with
        // the message row for the same update.
        token: `${inboundEventToken(updateId)}:advanced`,
        updateId,
        // No message produced this row — it exists because one did NOT.
        messageId: 0,
        route: "poll-advanced",
      });
    }),
    recordEvent: opts.recordEvent,
  });
}

/**
 * Read the highest Telegram update id this daemon has already recorded.
 *
 * Reads ALL FOUR event types. A rejected message advances the cursor too, or
 * one unauthorized message would be re-fetched on every restart forever; and
 * `principal.poll_advanced` carries the position past updates that produced no
 * message row at all (PR #2324 R3).
 */
export function createHighestUpdateIdReader(getDb: DbGetter): () => Promise<number | undefined> {
  return async () => {
    const db = await getDb();
    if (!db) return undefined;
    try {
      const { sql } = await import("drizzle-orm");
      const rows = (await db.execute(
        sql`SELECT MAX((payload->>'updateId')::bigint) AS max_id
            FROM system_events
            WHERE event_type::text IN (${RECEIVED_EVENT}, ${REJECTED_EVENT}, ${FAILED_EVENT}, ${ADVANCED_EVENT})`
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
export function createInboundEventRecorder(getDb: DbGetter): InboundEventRecorder {
  return async (eventType, payload: PrincipalMessageEventPayload) => {
    const db = await getDb();
    if (!db) throw new Error("persistence unavailable — cannot record the inbound audit event");

    const { sql } = await import("drizzle-orm");
    // The payload's own token, not one derived from the update id: the
    // failure-outcome row deliberately carries a suffixed token so it does not
    // collide with the pre-action row for the same update.
    const token = payload.token;
    const existing = (await db.execute(
      sql`SELECT 1 FROM system_events
          WHERE event_type::text IN (${RECEIVED_EVENT}, ${REJECTED_EVENT}, ${FAILED_EVENT}, ${ADVANCED_EVENT})
            AND payload->>'token' = ${token}
          LIMIT 1`
    )) as unknown[];

    // Reported, not thrown (PR #2324 R1 BLOCKING): a replay and a DB outage are
    // different situations — one means STOP, the other means proceed anyway —
    // and routing both through the same catch made the poller act on replays.
    if (Array.isArray(existing) && existing.length > 0) return "duplicate";

    // `::system_event_type` for the same bound-parameter reason as the SELECT
    // above, in the opposite direction: the value must reach the enum column as
    // the enum, not as text. It also fails LOUDLY if the migration adding the
    // value has not been applied, which is the behaviour to want — a silently
    // dropped audit row on an RCE-adjacent surface is far worse than an error.
    await db.execute(
      sql`INSERT INTO system_events (event_type, payload, actor)
          VALUES (${eventType}::system_event_type,
                  ${JSON.stringify(payload)}::jsonb,
                  'principal-channel')`
    );
    return "recorded";
  };
}
