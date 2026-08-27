/**
 * Composition root for the principal channel (mt#3228).
 *
 * Binds the poller to its real collaborators — Telegram credentials, the
 * append-only event log, the driven-session driver, the ask substrate — and
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
 * @see ./principal-channel-driver.ts — what carries out the decisions
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import { getConfiguration } from "@minsky/domain/configuration/index";
import type { PrincipalChannelConfig } from "@minsky/domain/configuration/schemas/principal-channel";
import {
  markTelegramChannelTopicDead,
  resolvePrincipalChannel,
  createRealPrincipalChannelDeps,
  type PrincipalChannelResolution,
} from "@minsky/domain/notify/principal-channel";
import {
  inboundEventToken,
  type PrincipalMessageEventPayload,
} from "@minsky/domain/notify/principal-inbound";
import { getTelegramMe, type TelegramGetMeResult } from "@minsky/domain/notify/telegram-transport";
import { parseTaskId } from "@minsky/domain/tasks/task-id";
import {
  createCachedSqlDbGetter,
  getServerAskRepository,
  getServerTaskService,
  describeServerPersistenceUnavailability,
} from "./db-providers";
import {
  getSweepLivenessSnapshot,
  META_WATCHDOG_STALL_MULTIPLIER,
  type SweepLivenessSnapshot,
} from "./sweepers";
import { createDrivenSessionDriver, createTopicDriverRegistry } from "./principal-channel-driver";
import {
  startPrincipalChannelPoller,
  PRINCIPAL_CHANNEL_SWEEP_NAME,
  type BindTopicOutcome,
  type ChannelDriver,
  type InboundEventRecorder,
  type PollCursor,
  type PollerHandle,
} from "./principal-channel-poller";
import {
  createDegradedDedupe,
  type DegradedDedupe,
  type DegradedDedupeSnapshot,
} from "./principal-channel-degraded-dedupe";
import type { PermissionMode } from "./driven-session-host";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

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
      error: getLoggableErrorSummary(err),
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
  // In-process high-water mark (mt#4252). ADVANCE-ONLY, and deliberately not a
  // second source of truth: the log is still where the position lives, and a
  // restart starts from the log alone.
  //
  // What it covers is the window the log cannot: while Postgres is unreachable,
  // `readHighestUpdateId` fails open to `undefined` (its own docblock justifies
  // that with the idempotency token — which lives in the database that just
  // failed), the poll goes out with no offset, and Telegram re-serves every
  // unconfirmed update. Remembering where we got to is what stops that from
  // repeating once per backoff cycle.
  let mark: number | undefined;

  return {
    async read(): Promise<number | undefined> {
      const durable = await readHighestUpdateId();
      // `max(memory, db)`, which resolves both directions of disagreement
      // correctly: on a cold boot memory is empty and the log wins, and during
      // an outage the log is silent and memory carries. A recovered read that
      // comes back LOWER than what this process has already served never moves
      // the mark backwards.
      if (durable !== undefined && (mark === undefined || durable > mark)) mark = durable;
      return mark;
    },
    async write(updateId: number): Promise<void> {
      // BEFORE the durable write, not after. `recordAdvance` is precisely the
      // call that throws when the DB is down — advancing after it would leave
      // the mark unset for the whole outage, which is the defect this exists to
      // fix rather than a detail of ordering.
      if (mark === undefined || updateId > mark) mark = updateId;

      // Unchanged: "has the log already covered this?" is a question about the
      // log, so it keeps using the raw reader rather than the marked `read`
      // above. Answering it from memory would suppress the `poll_advanced` row
      // that exists to record an update the message rows cannot express.
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

// ---------------------------------------------------------------------------
// Topic mapping + per-topic session drivers (mt#3505, parent mt#3500)
// ---------------------------------------------------------------------------

/**
 * Deterministic `driven_sessions.local_id` for one Telegram DM forum topic.
 *
 * Lives in the SAME keyspace `entityThreadLocalId` established
 * (`packages/domain/src/transcripts/entity-thread-store.ts`) — readable, not
 * hashed, deterministic from stable identifiers Telegram itself assigns
 * (`chatId`, `messageThreadId`), per the mt#3505 spec's explicit instruction.
 * Deterministic on purpose: the id needs no lookup to derive, only the
 * mapping row (see {@link ensureTelegramChannelTopic}) needs a lookup, and
 * that row's whole job is to say "have I seen this topic before", not to
 * hand back an id that could otherwise only be looked up.
 */
export function telegramTopicLocalId(chatId: string, messageThreadId: number): string {
  return `telegram-topic:${chatId}:${messageThreadId}`;
}

/** Deps {@link ensureTelegramChannelTopic} needs — just a DB getter, injected for tests. */
export interface EnsureTelegramChannelTopicDeps {
  getDb: DbGetter;
}

/**
 * Ensure a `telegram_channel_topics` mapping row exists for (chatId,
 * messageThreadId), returning the topic's deterministic `localId` either way.
 *
 * Best-effort: a DB outage or a failed insert logs a warning and still
 * returns the localId rather than throwing — the mapping table is the bot's
 * ONLY inventory of topics (Telegram exposes no `getForumTopics`), but a
 * transient persistence hiccup must not stop the principal's message from
 * being answered. The insert itself is idempotent (`ON CONFLICT ... DO
 * NOTHING` on the unique `(chat_id, message_thread_id)` index), so a
 * redelivered Telegram update racing a fresh one is harmless.
 */
export async function ensureTelegramChannelTopic(
  chatId: string,
  messageThreadId: number,
  deps: EnsureTelegramChannelTopicDeps
): Promise<string> {
  const localId = telegramTopicLocalId(chatId, messageThreadId);
  const db = await deps.getDb();
  if (!db) {
    log.warn(
      "[principal-channel] could not persist a topic mapping (no DB); continuing without it",
      { chatId, messageThreadId }
    );
    return localId;
  }
  try {
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      INSERT INTO telegram_channel_topics (local_id, chat_id, message_thread_id)
      VALUES (${localId}, ${chatId}, ${messageThreadId})
      ON CONFLICT (chat_id, message_thread_id) DO NOTHING
    `);
  } catch (err: unknown) {
    log.warn("[principal-channel] failed to record a topic mapping", {
      chatId,
      messageThreadId,
      error: getLoggableErrorSummary(err),
    });
  }
  return localId;
}

/** Deps {@link bindTelegramChannelTopicToTask} needs. */
export interface BindTelegramChannelTopicDeps {
  getDb: DbGetter;
  /**
   * Resolve a task by id, or null if it does not exist. Defaults to the real
   * TaskService; overridable so a test never spins up a real one.
   */
  getTask?: (taskId: string) => Promise<unknown | null>;
}

/**
 * Bind (chatId, messageThreadId)'s topic mapping to a task (mt#3507's
 * `/bind` command).
 *
 * All-or-nothing: the task id is validated (parseable) and confirmed to
 * exist BEFORE any write happens, so a malformed or nonexistent task id never
 * leaves a half-written row — the spec's explicit requirement. Never creates
 * the task; a task that does not exist is refused, not conjured.
 *
 * The write itself is an upsert (`INSERT ... ON CONFLICT DO UPDATE`), not an
 * `UPDATE`-only statement: `/bind` is the FIRST message in a topic often
 * enough (a principal opening a fresh topic and immediately naming its task)
 * that the mapping row may not exist yet — `ensureTelegramChannelTopic` is
 * normally what creates it, but that only runs when a message is routed
 * through `resolveDriverForMessage`, which a `bind` route deliberately
 * skips (see `principal-channel-poller.ts`'s `handleBind`). Only the
 * `entity_type`/`entity_id` columns are ever touched here — `local_id`
 * (and therefore `driven_sessions.local_id`, which shares that keyspace) is
 * never written to by this function, which is what keeps the bound
 * conversation's identity unchanged before and after a bind.
 */
export async function bindTelegramChannelTopicToTask(
  chatId: string,
  messageThreadId: number,
  taskRef: string,
  deps: BindTelegramChannelTopicDeps
): Promise<BindTopicOutcome> {
  const parsed = parseTaskId(taskRef.trim());
  if (!parsed) {
    return {
      kind: "invalid-task",
      detail: `"${taskRef}" isn't a task id I recognize (expected e.g. mt#123).`,
    };
  }
  const taskId = parsed.full;

  const getTask = deps.getTask ?? defaultGetTask;
  const task = await getTask(taskId);
  if (!task) {
    return { kind: "invalid-task", detail: `${taskId} does not exist.` };
  }

  const db = await deps.getDb();
  if (!db) {
    return {
      kind: "invalid-task",
      detail: "the topic mapping store is unavailable right now — try again shortly.",
    };
  }

  const localId = telegramTopicLocalId(chatId, messageThreadId);
  try {
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      INSERT INTO telegram_channel_topics (local_id, chat_id, message_thread_id, entity_type, entity_id)
      VALUES (${localId}, ${chatId}, ${messageThreadId}, 'task', ${taskId})
      ON CONFLICT (chat_id, message_thread_id)
      DO UPDATE SET entity_type = 'task', entity_id = ${taskId}, updated_at = now()
    `);
  } catch (err: unknown) {
    log.warn("[principal-channel] failed to bind a topic to a task", {
      chatId,
      messageThreadId,
      taskId,
      error: getLoggableErrorSummary(err),
    });
    return {
      kind: "invalid-task",
      detail: "could not save the binding — try again shortly.",
    };
  }
  return { kind: "bound", taskId };
}

async function defaultGetTask(taskId: string): Promise<unknown | null> {
  const service = await getServerTaskService();
  if (!service) return null;
  return service.getTask(taskId);
}

/** Deps {@link createTopicDriverResolver} needs to build and cache per-topic session drivers. */
export interface TopicDriverResolverDeps {
  chatId: string;
  getDb: DbGetter;
  /**
   * Build a fresh session driver bound to `localId`. Production wraps
   * `createDrivenSessionDriver` with the channel's `cwd`/`permissionMode`/
   * `respondToAsk` fixed and only `localId` varying per topic; tests inject a
   * stub so no `claude` process is ever spawned.
   */
  buildSessionDriver: (localId: string) => ChannelDriver;
}

/**
 * Build the poller's `resolveTopicDriver` dependency (mt#3505).
 *
 * The registry (`createTopicDriverRegistry`) is what makes this safe to
 * call once per inbound message rather than once per topic: the SAME
 * session driver instance is returned for a topic across calls, preserving that
 * instance's own "one caller at a time" concurrency contract (see
 * `./principal-channel-driver.ts`'s docblock) while different topics get
 * independent instances and therefore run concurrently.
 */
export function createTopicDriverResolver(
  deps: TopicDriverResolverDeps
): (messageThreadId: number) => Promise<ChannelDriver> {
  const registry = createTopicDriverRegistry();
  return async (messageThreadId: number) => {
    const localId = await ensureTelegramChannelTopic(deps.chatId, messageThreadId, {
      getDb: deps.getDb,
    });
    return registry.getOrCreate(localId, () => deps.buildSessionDriver(localId));
  };
}

/**
 * Log the bot's topic-mode capability at startup (mt#3505 success criterion).
 *
 * Diagnostic only — it NEVER gates or fails channel startup, in either
 * direction. When `has_topics_enabled` is false, Telegram simply never sends
 * a `message_thread_id` on any inbound message, so the channel degrades to
 * today's single-conversation behavior automatically; this only makes that
 * state legible to whoever is reading the daemon's log, per the spec's
 * "operator-legible log line rather than failing."
 */
export async function logTopicModeCapability(
  token: string,
  getMe: (opts: { token: string }) => Promise<TelegramGetMeResult> = getTelegramMe
): Promise<void> {
  const result = await getMe({ token });
  if (!result.ok) {
    log.warn(
      "[principal-channel] could not probe topic-mode capability via getMe; continuing without it",
      { detail: result.detail }
    );
    return;
  }
  log.info("[principal-channel] topic-mode capability probe", {
    hasTopicsEnabled: result.hasTopicsEnabled,
    allowsUsersToCreateTopics: result.allowsUsersToCreateTopics,
  });
  if (!result.hasTopicsEnabled) {
    log.warn(
      "[principal-channel] topic mode is OFF for this bot — the channel behaves as a single " +
        "standing conversation until it is enabled for this bot in @BotFather",
      {}
    );
  }
}

/**
 * What the channel is actually doing, for the `/api/health` surface (mt#3608,
 * retry ceiling removed mt#3683).
 *
 * Mirrors {@link getDbStatus}'s shape deliberately: a module-level last-known
 * state a health endpoint can read on every request without probing anything.
 *
 * The states an operator needs to tell apart:
 * - `unconfigured` — the credentials are genuinely absent. Operator action.
 * - `retrying` — a read failed and the fault is classified TRANSIENT. Per
 *   ADR-035 rule 1, this never gives up on its own: past mt#3608's original
 *   ~2-minute/6-attempt schedule it keeps retrying on a widening, capped
 *   backoff (see {@link resolveWithRetry}) rather than settling into
 *   `failed`. `lastAttemptAt`/`nextAttemptAt` (ADR-035 rule 4) are what make
 *   "still actively retrying" legible against "gave up" without reading the
 *   reason prose.
 * - `failed` — a DIFFERENT fault class: an exception raised AFTER
 *   credentials resolved (poller/session driver construction — see
 *   {@link startPrincipalChannel}'s catch block). No longer reachable from a
 *   credential-read failure, since that path no longer exhausts.
 *
 * `attempts` belongs to `retrying` ONLY (mt#3689). It used to appear on
 * `failed` too, always as the literal `1`, which made one field carry two
 * meanings across two fault classes: on `retrying` it is a live count of
 * credential reads, on `failed` it counted nothing — the failure happened once,
 * after credentials had already resolved. That is an invitation to misread, and
 * the misreading is not hypothetical: mt#3683's root cause was established by
 * reading `attempts: 7` against a six-entry schedule, so this counter is
 * load-bearing for diagnosis precisely when an operator is under pressure.
 * `state` already separates the two classes, so dropping the field loses no
 * information. ADR-035 rule 4 requires `mode`/`reason`/`lastAttemptAt` at
 * MINIMUM and does not name `attempts`, so omitting it here stays within the
 * rule — which sets a floor on the status shape, not a ceiling.
 */
export type PrincipalChannelStatus =
  | { state: "disabled" }
  | { state: "starting" }
  | {
      state: "running";
      chatId: string;
      /** ISO timestamp of the moment the poller was launched. */
      since: string;
      /**
       * ISO timestamp of the poll loop's most recent PROGRESS (mt#4183),
       * projected from the sweep-liveness registry — not written here.
       *
       * Null means the loop has reported nothing since `since`. That is normal
       * for the first second of a channel's life and a fault after that, which
       * is why staleness below is measured against `lastProgressAt ?? since`
       * rather than treating null as "no opinion".
       */
      lastProgressAt: string | null;
      /**
       * Which dedupe the channel is currently relying on (mt#4252).
       *
       * `running` on its own says the loop is turning; it says nothing about
       * whether the loop can still tell a replay from a new message. Those come
       * apart exactly when Postgres is unreachable — the loop keeps reporting
       * progress every cycle, so the staleness projection above has no input
       * that would move it off `running`, while every unconfirmed message is
       * being re-served. This is the field that distinguishes the two.
       *
       * Optional so a caller constructing a `running` status by hand (the
       * test-only setter below, and existing callers) is unaffected; absent
       * means "not reported", not "durable".
       */
      dedupe?: DegradedDedupeSnapshot;
    }
  | {
      /**
       * The poller was launched and has stopped making progress (mt#4183).
       *
       * This is the state whose absence let a wedged poller report `running`
       * for ~44 hours. It is a PROJECTION, computed on read from the registry
       * entry mt#4185 registers — there is no write site for it, which is the
       * point: a latch is what failed here, so the honest surface is one that
       * cannot go stale because nothing has to remember to update it.
       */
      state: "stalled";
      chatId: string;
      since: string;
      lastProgressAt: string | null;
      /** How long progress has been absent — "stalled 4 minutes" vs "stalled 4 days". */
      staleForMs: number;
      /** The threshold crossed, so the reading is interpretable without knowing the budget. */
      thresholdMs: number;
    }
  | { state: "unconfigured"; reason: string }
  | {
      state: "retrying";
      reason: string;
      attempts: number;
      /** ISO timestamp of the attempt that just failed. */
      lastAttemptAt: string;
      /**
       * ISO timestamp of the next scheduled attempt (mt#3683 SC3) — the
       * field that makes "actively retrying" distinguishable from "gave
       * up" without inferring it from `attempts` alone.
       */
      nextAttemptAt: string;
    }
  | { state: "failed"; reason: string };

let channelStatus: PrincipalChannelStatus = { state: "disabled" };

/**
 * The running poller's fallback dedupe (mt#4252), or undefined before launch.
 *
 * Held here, beside {@link channelStatus}, because it has two readers that
 * cannot see each other: the poll cycle consults it when a durable audit write
 * fails, and {@link getPrincipalChannelStatus} projects its snapshot onto the
 * health payload. One object, so the thing that OBSERVES the failure is the
 * thing that REPORTS it.
 */
let channelDedupe: DegradedDedupe | undefined;

/**
 * Last-known channel status. Read-only; never triggers work. Safe to call from
 * a health endpoint on every request.
 */
export function getPrincipalChannelStatus(
  deps: {
    now?: () => number;
    snapshot?: () => SweepLivenessSnapshot[];
  } = {}
): PrincipalChannelStatus {
  // Only the running latch needs projecting. Every other state is written by a
  // path that is still executing when it writes, so it cannot outlive its
  // subject the way `running` did.
  if (channelStatus.state !== "running") return channelStatus;

  // Projected, never latched (mt#4252) — the dedupe derives its own mode by
  // comparing the last durable write against the last fallback, so nothing has
  // to remember to clear it when the DB recovers. That is the same discipline
  // mt#4183 applied to `running`/`stalled` here, for the same reason.
  const dedupeSnapshot = channelDedupe?.snapshot();
  const withDedupe = <T extends { state: "running" | "stalled" }>(status: T): T => {
    if (dedupeSnapshot === undefined || status.state !== "running") return status;
    return { ...status, dedupe: dedupeSnapshot };
  };

  const now = deps.now?.() ?? Date.now();
  const snapshot = (deps.snapshot ?? getSweepLivenessSnapshot)();
  const entry = snapshot.find((e) => e.name === PRINCIPAL_CHANNEL_SWEEP_NAME);

  // No registrant: the poller is not reporting into the registry at all. Say
  // nothing rather than guess — inventing a staleness from `since` alone would
  // report a healthy channel as stalled on any build where registration moved.
  if (!entry) return withDedupe(channelStatus);

  const lastProgressAt = entry.lastAttemptAt;
  // The threshold is the REGISTRY's, read off the entry — not a second constant
  // maintained here. ADR-035 rule 4 asks subsystems to converge on one status
  // shape; two thresholds for one liveness question is the same divergence one
  // level down, and it would drift the first time either side was tuned.
  const thresholdMs = entry.intervalMs * META_WATCHDOG_STALL_MULTIPLIER;
  // `?? since` is what closes the first-cycle case: a loop that parks before
  // its first progress call leaves `lastAttemptAt` null forever, and measuring
  // against launch time is what makes that visible instead of permanently
  // unevaluated. (The registry-side half of the same gap is mt#4206.)
  const referenceMs = Date.parse(lastProgressAt ?? channelStatus.since);
  if (Number.isNaN(referenceMs)) return withDedupe({ ...channelStatus, lastProgressAt });

  const staleForMs = now - referenceMs;
  if (staleForMs <= thresholdMs) return withDedupe({ ...channelStatus, lastProgressAt });

  return {
    state: "stalled",
    chatId: channelStatus.chatId,
    since: channelStatus.since,
    lastProgressAt,
    staleForMs,
    thresholdMs,
  };
}

/** Reset to the pre-start state. For tests. */
export function resetPrincipalChannelStatus(): void {
  channelStatus = { state: "disabled" };
  // Cleared alongside the status (mt#4252) — leaving a dedupe behind would let
  // one test's degraded snapshot appear in the next test's health projection.
  channelDedupe = undefined;
}

/**
 * TEST-ONLY: install a dedupe so the health projection can be exercised without
 * running the whole launch path (mt#4252). Sibling of
 * {@link _setPrincipalChannelStatusForTest}, and cleared by
 * {@link resetPrincipalChannelStatus}.
 */
export function _setPrincipalChannelDedupeForTest(dedupe: DegradedDedupe | undefined): void {
  channelDedupe = dedupe;
}

/**
 * TEST-ONLY: put the latch into a chosen state without running the whole
 * credential-resolution and poller-construction path (mt#4183).
 *
 * The projection in {@link getPrincipalChannelStatus} is the unit under test
 * for SC1, and reaching `running` legitimately requires live credentials, a
 * spawned session driver and a real poller. Seeding the latch is what lets the
 * projection be tested on its own terms; the projection itself reads the
 * registry through its injected `snapshot` seam, so nothing here is patched.
 */
export function _setPrincipalChannelStatusForTest(status: PrincipalChannelStatus): void {
  channelStatus = status;
}

/**
 * Seed schedule for a FAILED credential read's backoff (mt#3608, revised
 * mt#3683 — the ceiling this schedule used to impose is gone).
 *
 * Six attempts on a doubling backoff from 2s spans ~2 minutes. mt#3608 read
 * exhausting this schedule as proof the fault was not the transient class it
 * exists for, and gave up permanently. That premise did not hold: the
 * 2026-08-04 outage stayed down for ~5 hours and cleared on its own at the
 * next daemon restart with NO environment change — a fault a fixed schedule
 * cannot outlast is not evidence it was never transient, only that the
 * schedule was too short. (Its `exit null` signature was checked directly
 * against this runtime — see {@link resolvePrincipalChannel}'s caller,
 * `readPulumiChatId` in `packages/domain/src/notify/principal-channel.ts` —
 * and reproduces the Pulumi subprocess's 5s `timeout` firing, not a
 * PATH/spawn failure: `Bun.spawnSync` throws synchronously with a distinct
 * `ENOENT`/"Executable not found in $PATH" message when the binary itself is
 * unresolvable, verified live in this Bun runtime, so a killed-by-timeout
 * process — which DOES produce `exitCode: null` with empty stderr, also
 * verified live — is the only way this exact reason string is produced. No
 * binary-resolution fix is warranted.)
 *
 * This array is now only the SEED: {@link resolveWithRetry} never stops
 * retrying on its own while the failure stays classified `transient` — past
 * this schedule it keeps doubling the last delay, capped at
 * {@link CREDENTIAL_RETRY_MAX_DELAY_MS}, per ADR-035 rule 1 ("register the
 * retry", not "bound the attempt count") and mirroring mt#3635's
 * container-retry cap (`packages/domain/src/composition/container.ts`'s
 * `RETRY_MAX_INTERVAL_MS`).
 */
export const CREDENTIAL_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000];

/**
 * Ceiling for the backoff once the seed schedule above is exhausted
 * (mt#3683). Bounds the RATE of a long outage, not the attempt COUNT: a
 * multi-hour fault settles at one attempt per 5 minutes instead of doubling
 * into hour-long gaps, while a restart-recovering fault (this task's
 * originating incident) is still retried well within the window an operator
 * would notice. Mirrors mt#3635's `RETRY_MAX_INTERVAL_MS` — the same class of
 * transient Pulumi/network fault, the same chosen cap.
 */
export const CREDENTIAL_RETRY_MAX_DELAY_MS = 5 * 60_000;

/**
 * Floor for any retry wait (mt#3689).
 *
 * The backoff past the seed schedule widens by MULTIPLYING the previous delay,
 * so a non-positive seed multiplies to itself forever: a `[0]` schedule yields
 * an unbroken run of zero-length waits — a busy loop inside the mechanism that
 * exists to stop hammering a failing dependency. The invariant was held only by
 * the literal value of {@link CREDENTIAL_RETRY_DELAYS_MS}, not by the code, so
 * any future edit to that array (or the injected `retryDelaysMs` test seam)
 * could reintroduce it silently.
 *
 * Applied at BOTH ends, which is what makes it hold: as a floor on the base
 * {@link nextRetryDelayMs} doubles from (so the sequence actually widens rather
 * than pinning at the floor), and as a floor on the delay finally slept
 * (so a non-positive entry read straight out of the seed schedule, which never
 * reaches `nextRetryDelayMs`, cannot produce a zero wait either).
 *
 * Inert for production: every entry in the shipped schedule is >= 2000ms, so
 * this clamp never binds there. The value is bounded from below by what it is
 * protecting against — a spin — and from above by not wanting to slow a real
 * recovery: each attempt already costs up to the 5s Pulumi spawn timeout in
 * `packages/domain/src/notify/principal-channel.ts`, so a 1s floor is small
 * against the work an attempt does while still guaranteeing forward progress.
 */
export const CREDENTIAL_RETRY_MIN_DELAY_MS = 1_000;

/**
 * Clamp a retry wait into `[CREDENTIAL_RETRY_MIN_DELAY_MS, maxDelayMs]`.
 *
 * Non-finite input resolves to `maxDelayMs` rather than propagating: `NaN`
 * would survive `Math.max`/`Math.min` unchanged and reach `sleep()` as a wait
 * of unspecified length, which is the failure this guard exists to rule out.
 *
 * **The floor is applied LAST, and wins when the interval is empty** (PR #2662
 * R1). A caller may set `maxDelayMs` BELOW the floor, which asks for two
 * incompatible things; applying the cap last would return a sub-floor delay and
 * make this function's own contract false. The floor wins because the two
 * bounds are not the same kind of constraint: the floor rules out a spin, which
 * is a correctness property of the retry, while the cap expresses a preferred
 * rate for a long outage. Losing the preference is survivable; reintroducing
 * the busy loop this guard exists to prevent is not.
 */
function clampRetryDelayMs(delayMs: number, maxDelayMs: number): number {
  if (!Number.isFinite(delayMs)) return Math.max(maxDelayMs, CREDENTIAL_RETRY_MIN_DELAY_MS);
  return Math.max(Math.min(delayMs, maxDelayMs), CREDENTIAL_RETRY_MIN_DELAY_MS);
}

/**
 * Resolve credentials, retrying only while the failure is one a retry can fix.
 *
 * A genuinely-unconfigured channel returns immediately: retrying an absent
 * credential just delays a message the operator needs to see.
 *
 * No attempt ceiling (mt#3683 / ADR-035 rule 1). While the failure stays
 * classified `transient`, this loop never gives up on its own — the only way
 * out besides success is a definitive non-transient verdict (checked above)
 * or a process restart. `delaysMs` seeds the schedule; {@link nextRetryDelayMs}
 * takes over once it's exhausted, so the return type stays a plain
 * {@link PrincipalChannelResolution} with `configured: false, transient: true`
 * now structurally unreachable in practice rather than a state callers have
 * to keep handling (see the defensive comment on that branch in
 * {@link startPrincipalChannel}).
 */
export async function resolveWithRetry(deps: {
  /**
   * Resolve the channel's credentials. Takes no arguments: the credential
   * dependencies are bound where this is CONSTRUCTED (see the default below),
   * so the poller never chooses them and a test injects a fake resolver
   * without needing to know what a real one is made of (mt#3609).
   */
  resolve: () => Promise<PrincipalChannelResolution>;
  sleep: (ms: number) => Promise<void>;
  delaysMs: readonly number[];
  /** Ceiling once `delaysMs` is exhausted. Defaults to {@link CREDENTIAL_RETRY_MAX_DELAY_MS}; overridable for tests. */
  maxDelayMs?: number;
  /** Injected clock for `lastAttemptAt`/`nextAttemptAt` so tests don't depend on wall time. */
  now?: () => number;
}): Promise<PrincipalChannelResolution> {
  const maxDelayMs = deps.maxDelayMs ?? CREDENTIAL_RETRY_MAX_DELAY_MS;
  const now = deps.now ?? Date.now;
  let attempt = 0;
  // Fires once, the moment an outage crosses what mt#3608's schedule used to
  // treat as "exhausted" — an elevated, self-driven signal (mt#3683 SC4) that
  // does not depend on anyone polling /api/health: the ordinary per-attempt
  // log.warn below already fires at every interval regardless of whether
  // anyone is watching, but this marks the specific moment worth a louder
  // line in any log-based alerting.
  let loggedPastOriginalWindow = false;
  for (;;) {
    const resolution = await deps.resolve();
    if (resolution.configured || !resolution.transient) {
      // Clear a stale `retrying` before returning (PR #2582 R1). Without this,
      // a resolution that SUCCEEDED on attempt 2 left the status reading
      // "retrying" — a health field describing a retry that already finished.
      // `starting` is the honest neutral: the caller sets `running` (or the
      // unconfigured verdict) immediately after this returns.
      if (channelStatus.state === "retrying") channelStatus = { state: "starting" };
      return resolution;
    }

    const scheduled = deps.delaysMs[attempt];
    // mt#3689: the clamp wraps BOTH paths. A seeded entry is read straight out
    // of `delaysMs` and never reaches `nextRetryDelayMs`, so flooring only the
    // computed path would still sleep 0ms for a `[0]` schedule's first attempt.
    const delayMs = clampRetryDelayMs(
      scheduled !== undefined ? scheduled : nextRetryDelayMs(attempt, deps.delaysMs, maxDelayMs),
      maxDelayMs
    );

    if (scheduled === undefined && !loggedPastOriginalWindow) {
      loggedPastOriginalWindow = true;
      log.error(
        "[principal-channel] credential read still failing past the original ~2-minute " +
          "retry window; continuing on a widening, capped backoff rather than giving up",
        { reason: resolution.reason, attempt: attempt + 1 }
      );
    }

    const nowMs = now();
    channelStatus = {
      state: "retrying",
      reason: resolution.reason,
      attempts: attempt + 1,
      lastAttemptAt: new Date(nowMs).toISOString(),
      nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
    };
    log.warn("[principal-channel] credential read failed; retrying", {
      reason: resolution.reason,
      attempt: attempt + 1,
      nextRetryMs: delayMs,
    });
    await deps.sleep(delayMs);
    attempt += 1;
  }
}

/**
 * Delay for an attempt past the end of the seeded schedule (mt#3683).
 *
 * Keeps doubling the schedule's LAST entry rather than restarting the
 * doubling from scratch, so the transition out of the seed schedule is
 * continuous (no downward jump back to a short delay) — capped at
 * `maxDelayMs` so a long outage settles at a fixed rate instead of doubling
 * into ever-longer gaps. `2 ** n` growing past `Number.MAX_VALUE` for an
 * extremely long outage safely evaluates to `Infinity`, and `Math.min` still
 * clamps that to `maxDelayMs` — no overflow, no special-case needed.
 */
function nextRetryDelayMs(
  attempt: number,
  delaysMs: readonly number[],
  maxDelayMs: number
): number {
  // mt#3689: floor the BASE, not just the result. Doubling a non-positive base
  // yields that base forever, so clamping only the output would pin every wait
  // at the floor instead of widening — positive, but still not a backoff.
  const lastSeeded = Math.max(
    delaysMs[delaysMs.length - 1] ?? maxDelayMs,
    CREDENTIAL_RETRY_MIN_DELAY_MS
  );
  const doublingsPastSchedule = attempt - delaysMs.length + 1;
  return Math.min(lastSeeded * 2 ** doublingsPastSchedule, maxDelayMs);
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
  /** Injected for tests so a retry sequence does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; production uses {@link CREDENTIAL_RETRY_DELAYS_MS}. */
  retryDelaysMs?: readonly number[];
}): Promise<PollerHandle | null> {
  const config = opts.config ?? loadPrincipalChannelLaunchConfig();
  if (!config.enabled) {
    channelStatus = { state: "disabled" };
    return null;
  }

  channelStatus = { state: "starting" };
  const resolution = await resolveWithRetry({
    // Production wiring, bound here rather than defaulted inside the domain
    // module (ADR-026, mt#3609).
    resolve: () => resolvePrincipalChannel(createRealPrincipalChannelDeps()),
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    delaysMs: opts.retryDelaysMs ?? CREDENTIAL_RETRY_DELAYS_MS,
  });

  if (!resolution.configured) {
    // Two different situations, deliberately logged differently (mt#3608). The
    // old single warn said "enabled but not configured" for both, which reads
    // as an operator oversight and is why a repeating fault looked like a
    // settled config state.
    //
    // The `transient` branch is now DEFENSIVE, not a live path (mt#3683):
    // resolveWithRetry never returns while `transient` is true — it retries
    // indefinitely instead (see its own docblock). Kept because the return
    // type still expresses `{configured: false, transient: true}` as a value
    // TypeScript can't statically rule out here, and a silent behavior change
    // if that contract is ever loosened is worse than one unreachable branch.
    if (resolution.transient) {
      log.error("[principal-channel] credentials could not be read; channel NOT running", {
        reason: resolution.reason,
      });
    } else {
      channelStatus = { state: "unconfigured", reason: resolution.reason };
      log.warn("[principal-channel] enabled but not configured; not starting", {
        reason: resolution.reason,
      });
    }
    return null;
  }

  const { token, chatId } = resolution.config;

  // Same class as the stale-`retrying` fix above (PR #2582 R1): every path out
  // of here must leave a status that is TRUE. Credentials resolved, but the
  // steps below can still throw — and an escaping exception would leave the
  // health field reading `starting` forever, which is the same "reports a
  // state it is not in" defect one step later.
  try {
    return await startResolvedChannel({ opts, config, token, chatId });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    channelStatus = { state: "failed", reason };
    throw err;
  }
}

/** The post-credential half of {@link startPrincipalChannel}. */
async function startResolvedChannel(args: {
  opts: {
    respondToAsk: (askRef: string, text: string) => Promise<string>;
    recordEvent: InboundEventRecorder;
    readHighestUpdateId: () => Promise<number | undefined>;
    onStarted?: (chatId: string) => void;
  };
  config: PrincipalChannelLaunchConfig;
  token: string;
  chatId: string;
}): Promise<PollerHandle | null> {
  const { opts, config, token, chatId } = args;

  // Diagnostic only (mt#3505) — never gates startup either way. See
  // logTopicModeCapability's own docblock for why: when topic mode is off,
  // Telegram simply never sends a message_thread_id, so the channel degrades
  // automatically. Fire-and-forget-adjacent but still awaited so the log line
  // reliably lands before the "inbound poller started" line below it.
  await logTopicModeCapability(token);

  const sessionDriver = createDrivenSessionDriver({
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    respondToAsk: opts.respondToAsk,
  });
  const resolveTopicDriver = createTopicDriverResolver({
    chatId,
    getDb: getPrincipalChannelDb,
    buildSessionDriver: (localId) =>
      createDrivenSessionDriver({
        cwd: config.cwd,
        permissionMode: config.permissionMode,
        respondToAsk: opts.respondToAsk,
        localId,
      }),
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
  // `since` is written here and never again; `lastProgressAt` is a placeholder
  // the getter recomputes from the registry on every read (mt#4183). Storing a
  // progress timestamp HERE would rebuild the latch this task exists to remove.
  channelStatus = {
    state: "running",
    chatId,
    since: new Date().toISOString(),
    lastProgressAt: null,
  };
  opts.onStarted?.(chatId);

  // Fresh per launch (mt#4252): its whole authority is "did THIS process
  // already act on this token", so carrying one across a relaunch would let a
  // stale set suppress a message the new poller has not actually answered.
  channelDedupe = createDegradedDedupe();

  return startPrincipalChannelPoller({
    token,
    chatId,
    degradedDedupe: channelDedupe,
    auth: { allowedChatId: chatId, allowedUserIds },
    sessionDriver,
    resolveTopicDriver,
    bindTopic: (messageThreadId, taskRef) =>
      bindTelegramChannelTopicToTask(chatId, messageThreadId, taskRef, {
        getDb: getPrincipalChannelDb,
      }),
    markTopicDead: (deadChatId, messageThreadId) =>
      markTelegramChannelTopicDead(deadChatId, messageThreadId, { getDb: getPrincipalChannelDb }),
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
        error: getLoggableErrorSummary(err),
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
    if (!db) {
      throw new Error(
        `persistence unavailable — cannot record the inbound audit event. ${await describeServerPersistenceUnavailability()}`
      );
    }

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
