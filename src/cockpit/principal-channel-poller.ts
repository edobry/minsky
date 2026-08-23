/**
 * Inbound principal-channel poller (mt#3228).
 *
 * Long-polls Telegram for the principal's messages and drives the local swarm
 * with them. Runs in the cockpit daemon — the LOCAL one, on the principal's own
 * machine.
 *
 * ## Why local, when the reviewer service is the always-on scheduler host
 *
 * mt#2238 (Rung 3 — "remote interface, local execution") names the hard part of
 * driving a local agent from a remote surface: an authenticated inbound
 * cloud->local control channel, an RCE-adjacent surface needing a threat model.
 *
 * Long polling dissolves that problem. The daemon makes an OUTBOUND HTTPS
 * request to api.telegram.org and the principal's messages arrive as its
 * response — no inbound port, no tunnel, no NAT traversal, no new ingress.
 * Telegram is the relay. Running this in the cloud instead would REINTRODUCE
 * the ingress problem, because the cloud would then need a way to reach the
 * local `claude` binary.
 *
 * The cost is honest: the channel is live only while this daemon runs. The
 * swarm runs on this machine, so when it is down there is nothing to talk to.
 * Cloud-originated OUTBOUND alerts (the reviewer's Telegram sink) are
 * unaffected and keep working.
 *
 * ## Exactly one poller per bot
 *
 * Telegram hands each update to ONE getUpdates caller and, once acknowledged
 * via the offset, will not hand it over again. A second poller on the same bot
 * silently steals messages. The reviewer service only ever SENDS; this is the
 * sole poller. Note that while it runs it also consumes the updates
 * `scripts/reviewer-alerts/discover-chat-id.ts` reads, so that script reports
 * "no chats visible" — expected, not a regression (the chat id is already
 * discovered).
 *
 * @see mt#3228 — the bidirectional principal channel
 * @see mt#2238 — Rung 3, the remote-control seam this is the first instance of
 * @see ../../packages/domain/src/notify/principal-inbound.ts — the routing decision
 */

import { log } from "@minsky/shared/logger";
import {
  fetchTelegramFile,
  getTelegramUpdates,
  sendTelegramMessageWithThreadFallback,
  sendTelegramTypingAction,
  setTelegramMessageReaction,
  type FetchFn,
  type InboundTelegramMessage,
} from "@minsky/domain/notify/telegram-transport";
import {
  createReplyStream,
  renderTelegramPayload,
  type ReplyStream,
} from "./principal-channel-reply-stream";
import {
  REACTION_DONE,
  REACTION_ERROR,
  REACTION_RECEIVED,
} from "@minsky/domain/notify/principal-reactions";
import {
  buildInboundEventPayload,
  inboundEventToken,
  routeInboundMessage,
  type InboundAuthorization,
  type InboundRoute,
  type PrincipalMessageEventPayload,
} from "@minsky/domain/notify/principal-inbound";
import { registerSelfSchedulingSweep } from "./sweepers";
import type { DegradedDedupe } from "./principal-channel-degraded-dedupe";
import { withDeadline } from "@minsky/domain/utils/deadline";
// Value import, not a cycle: this module's only edge back from the session driver is
// `import type` (erased at runtime), so nothing loads twice.
import { DEFAULT_READY_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from "./principal-channel-driver";

/**
 * Long-poll seconds. 25s sits inside Telegram's own server-side ceiling while
 * keeping a message's worst-case pickup latency well under the "did it even
 * arrive?" threshold a human notices.
 */
const DEFAULT_LONG_POLL_SEC = 25;

/** Backoff after a failed poll, so a Telegram outage is not hammered. */
const ERROR_BACKOFF_MS = 30_000;

/**
 * Wall-clock bound on a single DB step inside a poll cycle (mt#4183 SC2) —
 * the cursor read, the cursor write, and the per-message audit write.
 *
 * None of these carried ANY bound before: they receive no `AbortSignal` and
 * the Postgres driver imposes no deadline, so a connection that goes away without
 * settling its promise parks the cycle forever with nothing thrown and nothing
 * logged. That is the shape of the 2026-08-16 incident, where the loop sat on
 * an empty cycle for ~44 hours (mt#4183 `## SC3 falsifier result`).
 *
 * 30s is deliberately far above a healthy statement (sub-second against the
 * Supabase pooler) and far below anything an operator would wait through. The
 * point is not to tune latency — it is that the worst case becomes an error
 * the loop's existing catch already handles, instead of silence.
 */
const DB_STEP_DEADLINE_MS = 30_000;

/**
 * Wall-clock bound on the long poll, as a function of the SERVER-side
 * long-poll parameter (mt#4183 SC2).
 *
 * Telegram's Bot API `getUpdates` takes `timeout` — "Timeout in seconds for
 * long polling" — which asks the SERVER to hold the request open that long and
 * return an empty result if nothing arrives. It is not a client deadline, and
 * `getTelegramUpdates` sets none of its own: it forwards the caller's signal
 * and otherwise uses a bare `fetch`. So a healthy poll legitimately takes up
 * to `longPollSec`, and any client bound below that would abort every healthy
 * poll and convert a working channel into a permanent error-backoff loop.
 *
 * Match/extend/deviate vs. the vendor's documented model: **extend.** The
 * server-side `timeout` is used exactly as documented; this adds the
 * client-side deadline the API does not provide, at 2x the server value so the
 * response body has generous room to transfer before the bound trips.
 */
function longPollDeadlineMs(longPollSec: number): number {
  return longPollSec * 2 * 1000;
}

/** The name this poller registers under in the sweep-liveness registry (mt#4185). */
export const PRINCIPAL_CHANNEL_SWEEP_NAME = "principal-channel poll";

/**
 * Longest legitimate gap between two progress reports from the poll loop
 * (mt#4185) — the meta-watchdog treats twice this as a stall.
 *
 * DERIVED, not chosen. The loop reports progress after every await that could
 * park, so the widest legitimate gap is the slowest single one: handling one
 * message, which the session driver already bounds. Both terms are real enforced
 * ceilings, not intentions — `awaitTurnResult` resolves its promise from a
 * `setTimeout` on every path, so a turn cannot outlast the turn timeout.
 *
 * Idle and failing cadences sit far inside this: a long poll returns within
 * {@link DEFAULT_LONG_POLL_SEC} and a failing one retries after
 * {@link ERROR_BACKOFF_MS}. Importing the two terms rather than restating
 * their sum is deliberate — a budget that silently stopped tracking the
 * timeouts it is derived from would produce a restart loop against a turn that
 * was still legitimately running.
 */
export const PRINCIPAL_CHANNEL_PROGRESS_BUDGET_MS =
  DEFAULT_READY_TIMEOUT_MS + DEFAULT_TURN_TIMEOUT_MS;

/** Cap on a single outbound reply. Telegram hard-rejects above 4096. */
const MAX_REPLY_CHARS = 3500;

/**
 * Telegram's own hard ceiling for a single message (mt#3465).
 *
 * {@link MAX_REPLY_CHARS} bounds the MARKDOWN; this bounds what actually goes
 * on the wire after tags and entities inflate it. The two are different limits
 * and both have to hold.
 */
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * What the router's decision is carried out against.
 *
 * A seam, not an abstraction for its own sake: it is what lets every routing
 * and audit path be tested without spawning a `claude` process, and it is where
 * a future session driver (steering an arbitrary live conversation, once mt#3095's
 * conversation-keyed identity lands) drops in.
 */
/**
 * One resolved image, ready to attach to a turn (mt#3235).
 *
 * Declared here rather than imported from the driven-session host so the
 * session driver seam stays free of the host's types — a future session driver that is not
 * backed by a `claude` child still speaks this interface.
 */
export interface ChannelImage {
  base64: string;
  mediaType: string;
}

/**
 * Everything a turn needs beyond its text (mt#3542).
 *
 * An options object rather than more positional parameters: the signature was
 * already at three positionals with two optional, and `onPartial` would have
 * made a fourth — the shape where call sites start passing `undefined`
 * placeholders to reach the argument they care about.
 */
export interface ConverseOptions {
  /**
   * The quoted message when the principal used Telegram's reply affordance
   * (mt#3243). Optional because most messages are not replies — and because the
   * reply target is context for the turn, not a routing decision, so the poller
   * stays out of how it is presented.
   */
  replyToText?: string;
  images?: ChannelImage[];
  /**
   * Called with the assistant text accumulated SO FAR as the turn produces it
   * (mt#3542), for rendering progress into the chat.
   *
   * Advisory, and not every session driver emits it. The resolved value — not the
   * last `onPartial` argument — is the turn's authoritative answer: a turn with
   * tool-use rounds streams text around each round, while the resolved result
   * carries the final reply. Callers settle on the resolved value, but only
   * ADDITIVELY — see `principal-channel-reply-stream.ts`'s `finish`.
   */
  onPartial?: (accumulated: string) => void;
  /**
   * Called when a tool call interrupts the assistant's prose (mt#3711).
   *
   * The prose before a tool call is a finished thought, so this is where a
   * streamed reply closes one message and opens the next — the difference
   * between a turn that reads like chat and one paragraph that keeps growing.
   * Advisory in exactly the same way `onPartial` is: a session driver that does not
   * emit it degrades to one message per turn, which is the previous behaviour.
   */
  onBlockEnd?: () => void;
}

export interface ChannelDriver {
  /** Hand text to the standing channel conversation; resolve with its reply. */
  converse(text: string, opts?: ConverseOptions): Promise<string>;
  /** Interrupt the current turn. Must not queue behind it. */
  interrupt(): Promise<string>;
  /** Abandon the current conversation; the next message starts fresh. */
  reset(): Promise<string>;
  /** Answer a specific ask by ref, with no agent turn in between. */
  answerAsk(askRef: string, text: string): Promise<string>;
}

/** Outcome of a `/bind` attempt (mt#3507). */
export type BindTopicOutcome =
  | { kind: "bound"; taskId: string }
  | { kind: "invalid-task"; detail: string };

/** Persisted poll cursor. Backed by the append-only inbound event log. */
export interface PollCursor {
  read(): Promise<number | undefined>;
  write(updateId: number): Promise<void>;
}

/** Which append-only event a record call writes. */
export type InboundEventType =
  | "principal.message_received"
  | "principal.message_rejected"
  | "principal.message_failed"
  | "principal.poll_advanced";

/**
 * Outcome of a record attempt.
 *
 * `"duplicate"` is a RETURN VALUE, not an exception (PR #2324 R1 BLOCKING):
 * signalling a replay by throwing meant it landed in the same catch as a
 * genuine DB failure, and the poller's "keep going despite a persistence
 * hiccup" behaviour then silently re-executed the replay — defeating the
 * dedupe entirely. The two outcomes need different handling, so they get
 * different channels.
 */
export type RecordOutcome = "recorded" | "duplicate";

/**
 * What {@link recordSafely} reports — the recorder's two outcomes plus the one
 * only it can observe (mt#4252).
 *
 * `"unrecorded"` means the durable write did not land. It is a THIRD thing, not
 * a flavour of `"recorded"`: the recorder deliberately separated "this is a
 * replay" from "the database failed" (PR #2324 R1), and returning `"recorded"`
 * for a failure re-collapsed that distinction at the caller — the poller could
 * not tell a message it had already run from one it had not, so during an
 * outage it ran every re-served message again, every cycle.
 *
 * Kept off {@link RecordOutcome} and {@link InboundEventRecorder} on purpose:
 * the recorder cannot report this, because it THROWS instead. Only the wrapper
 * that catches the throw can, so only the wrapper's signature widens.
 *
 * Per ADR-035 rule 2, what to DO about it is the consumer's decision — see
 * {@link runPollCycle}'s handling, which consults the per-process fallback
 * dedupe rather than assuming either answer.
 */
export type SafeRecordOutcome = RecordOutcome | "unrecorded";

/** Append-only audit sink. One row per inbound update, before any side effect. */
export type InboundEventRecorder = (
  eventType: InboundEventType,
  payload: PrincipalMessageEventPayload
) => Promise<RecordOutcome>;

export interface PollCycleDeps {
  token: string;
  chatId: string;
  auth: InboundAuthorization;
  /** The standing (non-topic) conversation's session driver — used for a message with no thread id. */
  sessionDriver: ChannelDriver;
  /**
   * Resolve the session driver for a specific Telegram topic (mt#3505, parent
   * mt#3500).
   *
   * Called ONLY for a message carrying a `messageThreadId` — a message with
   * none always uses {@link sessionDriver} instead, unconditionally, so a poller
   * launched without topic support (this field omitted) behaves EXACTLY as
   * before. The resolver is expected to return the SAME session driver instance for
   * the same thread id across calls (a cache, not a fresh session driver per
   * message) — see `./principal-channel-driver.ts`'s
   * `createTopicDriverRegistry`, which is what the composition root
   * (`./principal-channel-launch.ts`) backs this with.
   */
  resolveTopicDriver?: (messageThreadId: number) => Promise<ChannelDriver>;
  /**
   * Carry out a `/bind` (mt#3507). Called only for a `bind` route ALREADY
   * confirmed to carry a thread id — a `/bind` typed in the standing
   * conversation is refused before this is ever consulted, since there is no
   * topic there to bind. Omitted entirely for a poller launched without
   * topic support, in which case `/bind` answers that binding is not
   * available on this channel.
   */
  bindTopic?: (messageThreadId: number, taskRef: string) => Promise<BindTopicOutcome>;
  /**
   * Record that a topic's mapping is dead after Telegram reports its thread
   * gone (mt#3507 drift reconciliation) — see
   * `telegram-transport.ts`'s `sendTelegramMessageWithThreadFallback`, which
   * this is wired into for every threaded reply. Omitted degrades to "the
   * reply still falls back correctly, it just cannot be recorded."
   */
  markTopicDead?: (chatId: string, messageThreadId: number) => Promise<void>;
  cursor: PollCursor;
  recordEvent: InboundEventRecorder;
  /**
   * Per-process fallback dedupe, consulted ONLY when a durable audit write
   * fails (mt#4252).
   *
   * Omitted, the cycle behaves exactly as it did before this existed — a failed
   * write is treated as new and the message runs — so a caller that does not
   * wire it is not silently made stricter. The composition root
   * (`./principal-channel-launch.ts`) supplies it, and also reads its snapshot
   * for the `principalChannel.dedupe` health substate.
   */
  degradedDedupe?: DegradedDedupe;
  longPollSec?: number;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  /**
   * Called each time the cycle demonstrably advanced past an await that could
   * have parked (mt#4185).
   *
   * Wired by {@link startPrincipalChannelPoller} to its sweep-liveness
   * registration; omitted, the cycle behaves exactly as before. Must not
   * throw and must not block — it stamps a timestamp.
   */
  onProgress?: () => void;
  /**
   * Override the wall-clock bounds a cycle applies to its DB steps (mt#4183).
   *
   * Present so a test can exercise the deadline branch in milliseconds rather
   * than waiting out {@link DB_STEP_DEADLINE_MS}. Production never sets it —
   * the default IS the bound, so omitting this changes nothing.
   */
  dbStepDeadlineMs?: number;
}

export interface PollCycleOutcome {
  /** Messages Telegram returned, including ones the allowlist refused. */
  received: number;
  /** Acted on AND the session driver succeeded. */
  handled: number;
  /** Acted on but the session driver threw. Counted apart from `handled` so a
   * channel that is answering-but-failing is distinguishable from a healthy
   * one (PR #2324 R1 — "attempted" was being conflated with "succeeded"). */
  failed: number;
  rejected: number;
  /** Already recorded by a previous run; skipped without re-executing. */
  duplicates: number;
  /** Set when the poll itself failed; the caller backs off. */
  error?: string;
}

/**
 * Run one long-poll and act on everything it returns.
 *
 * Messages are handled SEQUENTIALLY WITHIN one conversation, but conversations
 * for DIFFERENT topics run concurrently (mt#3505, parent mt#3500). A human who
 * sends two messages in a row means them in that order — racing them would
 * interleave turns and destroy the grounding a conversation exists to
 * provide — but two messages in two DIFFERENT topics are two independent
 * conversations, and there is no reason one should wait on the other.
 *
 * Serialization is per {@link topicKeyFor}, via a tiny per-key promise chain
 * (`enqueue` below): the first task for a key runs immediately, and each
 * subsequent task for the SAME key is chained onto the previous one's
 * completion, so ordering within a key is preserved exactly as it always was
 * for the single-conversation case (every message shares the `"standing"`
 * key). Different keys have independent chains and therefore run
 * concurrently — no lock, no scheduler, just promise chaining.
 */
export async function runPollCycle(deps: PollCycleDeps): Promise<PollCycleOutcome> {
  // Report progress after each await that could park (mt#4185) — never on a
  // timer of its own. The question the liveness registry is asking is "did
  // this loop ADVANCE", not "is this process alive", and only a settled await
  // answers the first one.
  const noteProgress = deps.onProgress ?? ((): void => {});

  const longPollSec = deps.longPollSec ?? DEFAULT_LONG_POLL_SEC;
  const dbStepDeadlineMs = deps.dbStepDeadlineMs ?? DB_STEP_DEADLINE_MS;

  const offset = await withDeadline(deps.cursor.read(), dbStepDeadlineMs);
  noteProgress();
  const result = await withDeadline(
    getTelegramUpdates({
      token: deps.token,
      ...(offset === undefined ? {} : { offset: offset + 1 }),
      timeoutSec: longPollSec,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    }),
    longPollDeadlineMs(longPollSec)
  );
  noteProgress();

  if (!result.ok) {
    return emptyCycle({ error: result.detail });
  }

  let handled = 0;
  let failed = 0;
  let rejected = 0;
  let duplicates = 0;

  // One promise chain per conversation key, so messages in the SAME
  // conversation stay strictly ordered while different conversations run
  // concurrently. `.then(task, task)` runs `task` regardless of whether the
  // prior task in the chain resolved or rejected — `handleRoute` never
  // actually throws (its own try/catch reports a failure as a return value),
  // but chaining defensively here means one topic's chain can never wedge
  // because of another message's unexpected error.
  const chains = new Map<string, Promise<unknown>>();
  const enqueue = (key: string, task: () => Promise<void>): Promise<void> => {
    const prior = chains.get(key) ?? Promise.resolve();
    const next = prior.then(task, task);
    chains.set(key, next);
    return next;
  };
  const pending: Promise<void>[] = [];

  for (const message of result.messages) {
    const route = routeInboundMessage(message, deps.auth);

    // Audit BEFORE acting. An RCE-adjacent surface must leave a record of what
    // it was asked to do even if carrying it out then fails or hangs.
    // Bounded (mt#4183 SC2). A deadline here aborts the whole cycle rather
    // than skipping one message, which is the safe direction: the throw
    // happens BEFORE `cursor.write`, so the cursor does not advance and the
    // next cycle re-fetches the same batch. Anything already recorded comes
    // back as a duplicate and is skipped, so the retry is idempotent.
    const recorded = await withDeadline(recordSafely(deps, message, route), dbStepDeadlineMs);
    noteProgress();

    // A replay of an update a previous run already recorded. Skipping is the
    // whole point of the idempotency token: Telegram re-delivers up to 24h of
    // updates to a poller that restarts without a readable cursor, and acting
    // on them again would re-run a day of the principal's instructions.
    if (recorded === "duplicate") {
      duplicates += 1;
      log.info("[principal-channel] skipping an already-recorded update", {
        updateId: message.updateId,
      });
      continue;
    }

    // The durable dedupe could not be consulted (mt#4252). Decide here, on the
    // one question this process CAN still answer — have I already acted on this
    // token? — rather than assuming either answer. Assuming "new" re-runs the
    // principal's messages for the length of the outage; assuming "duplicate"
    // would make the channel go silent, which is the failure both fail-opens
    // exist to prevent, so criterion 2 rules it out.
    if (recorded === "unrecorded") {
      const token = inboundEventToken(message.updateId);
      const fallback = deps.degradedDedupe?.admitUnrecorded(token) ?? "recorded";
      if (fallback === "duplicate") {
        duplicates += 1;
        log.warn("[principal-channel] skipping a replay while the audit log is unwritable", {
          updateId: message.updateId,
        });
        continue;
      }
      log.warn("[principal-channel] acting on a message without a durable audit row", {
        updateId: message.updateId,
      });
    }

    if (route.kind === "rejected") {
      rejected += 1;
      log.warn("[principal-channel] refused an inbound message", {
        reason: route.reason,
        updateId: message.updateId,
      });
      continue;
    }

    const key = topicKeyFor(message);
    pending.push(
      enqueue(key, async () => {
        const succeeded = await handleRoute(deps, message, route);
        if (succeeded) handled += 1;
        else failed += 1;
        // Per MESSAGE, not per cycle: a cycle carrying several messages would
        // otherwise report nothing until the last one settled, so the budget
        // would have to cover N turns instead of one.
        noteProgress();
      })
    );
  }

  // Wait for every conversation's queued work — across ALL keys — before
  // returning, so a caller awaiting this cycle still sees every reply sent
  // and every counter final, exactly as when everything ran sequentially.
  await Promise.all(pending);

  // Advance the cursor past EVERY update Telegram handed over, including ones
  // that failed to parse — otherwise an unparseable update is re-fetched
  // forever and the channel wedges behind it.
  if (result.highestUpdateId !== undefined) {
    await withDeadline(deps.cursor.write(result.highestUpdateId), dbStepDeadlineMs);
    noteProgress();
  }

  return { received: result.messages.length, handled, failed, rejected, duplicates };
}

/**
 * The per-conversation serialization key for a message (mt#3505).
 *
 * `"standing"` for a message with no thread id — every such message shares
 * ONE key, so they stay strictly ordered exactly as before this change.
 * A message carrying a thread id gets a key scoped to that thread, so two
 * different topics never share a chain.
 */
function topicKeyFor(message: InboundTelegramMessage): string {
  return message.messageThreadId === undefined ? "standing" : `topic:${message.messageThreadId}`;
}

/**
 * Resolve the session driver a message's conversation should be carried out
 * against (mt#3505).
 *
 * A message with no thread id ALWAYS uses the standing session driver, regardless
 * of whether `resolveTopicDriver` is configured — the untouched default the
 * spec calls for. Only a message carrying a thread id consults the resolver,
 * and only when one was supplied; a poller launched without topic support
 * (the resolver omitted) falls back to standing rather than throwing, so it
 * degrades safely.
 */
async function resolveDriverForMessage(
  deps: PollCycleDeps,
  message: InboundTelegramMessage
): Promise<ChannelDriver> {
  if (message.messageThreadId !== undefined && deps.resolveTopicDriver) {
    return deps.resolveTopicDriver(message.messageThreadId);
  }
  return deps.sessionDriver;
}

/** A cycle that acted on nothing, optionally carrying a poll error. */
function emptyCycle(extra: { error?: string } = {}): PollCycleOutcome {
  return { received: 0, handled: 0, failed: 0, rejected: 0, duplicates: 0, ...extra };
}

/**
 * Record the audit row without letting a recorder FAILURE drop the message.
 *
 * The audit is the priority, but a DB hiccup must not make the channel
 * unresponsive — a principal whose messages vanish during a Postgres blip has a
 * channel they cannot trust. So a thrown error is logged and treated as
 * `"recorded"`: proceed, unaudited, rather than go silent.
 *
 * A DUPLICATE is a different thing entirely and must not take that path — it is
 * the recorder reporting "this was already acted on", which is a reason to
 * STOP. Hence the return value rather than an exception.
 */
async function recordSafely(
  deps: PollCycleDeps,
  message: InboundTelegramMessage,
  route: InboundRoute
): Promise<SafeRecordOutcome> {
  try {
    const outcome = await deps.recordEvent(
      route.kind === "rejected" ? "principal.message_rejected" : "principal.message_received",
      buildInboundEventPayload(message, route)
    );
    // The write landed, so the durable dedupe is authoritative again. Stamped
    // here rather than inferred later: this is the only place that observes the
    // outcome, and mem#862's lesson is that an instrument placed anywhere else
    // is blind to the failures that stop it being reached.
    deps.degradedDedupe?.noteDurableWrite();
    return outcome;
  } catch (err: unknown) {
    log.error("[principal-channel] failed to record the inbound audit event", {
      updateId: message.updateId,
      error: err instanceof Error ? err.message : String(err),
    });
    // NOT "recorded" (mt#4252). Reporting a failure as a success is what let a
    // DB outage re-run the principal's messages once per backoff cycle: the
    // caller could not distinguish "the dedupe says this is new" from "the
    // dedupe could not be consulted". Those call for different handling, so
    // per ADR-035 rule 2 the caller gets to decide rather than being handed a
    // substituted answer.
    return "unrecorded";
  }
}

/**
 * Record that carrying out a message failed.
 *
 * Best-effort and deliberately separate from the pre-action row: "audit before
 * action" says what the channel was ASKED to do, and without this the log never
 * says whether it worked (PR #2324 R1). A failure to record the failure is
 * logged and dropped — the principal has already been told, and a recursive
 * audit failure helps nobody.
 */
async function recordFailureOutcome(
  deps: PollCycleDeps,
  message: InboundTelegramMessage,
  route: InboundRoute,
  detail: string
): Promise<void> {
  try {
    await deps.recordEvent("principal.message_failed", {
      ...buildInboundEventPayload(message, route),
      // A distinct token: the pre-action row already holds the plain one, and
      // the recorder's dedupe would otherwise treat this as that same row.
      token: `${inboundEventToken(message.updateId)}:failed`,
      failureDetail: detail,
    });
  } catch (err: unknown) {
    log.error("[principal-channel] failed to record the failure outcome", {
      updateId: message.updateId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleRoute(
  deps: PollCycleDeps,
  message: InboundTelegramMessage,
  route: Exclude<InboundRoute, { kind: "rejected" }>
): Promise<boolean> {
  // Silence reads as breakage on a chat channel, and a conversational turn can
  // take a while. Show the typing indicator before starting — except on
  // interrupt, whose whole point is to be immediate.
  //
  // NOT awaited (PR #2329 R1): the indicator is cosmetic, and awaiting it puts
  // a network call with no timeout in front of the work the principal actually
  // asked for. A hung Telegram would delay the answer — including the failure
  // answer — behind a decoration.
  //
  // The indicator now LOOPS for the turn's duration (mt#3486). Telegram expires
  // a chat action after ~5 seconds, so a single call left every turn longer
  // than that looking exactly like silence — which is the complaint this
  // addresses, not a cosmetic upgrade.
  const typing =
    route.kind === "interrupt"
      ? null
      : startTypingLoop({
          token: deps.token,
          chatId: deps.chatId,
          messageThreadId: message.messageThreadId,
          // The poller's shutdown signal, so stopping the poller stops the
          // indicator immediately rather than whenever this turn happens to
          // finish (PR #2525 R2).
          ...(deps.signal ? { signal: deps.signal } : {}),
          ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
        });

  // Mark the message as picked up (mt#3486). This is the only mechanism that
  // can mark a SPECIFIC inbound message — Telegram's checkmarks are a client
  // affordance a bot can neither read nor set.
  void react(deps, message, REACTION_RECEIVED);

  // `finally` guarantees the interval is cleared on EVERY exit, including one
  // this function does not handle (PR #2525 R1). The explicit stop below still
  // runs first — it controls WHEN the cue disappears; this only guarantees it
  // disappears at all. A leaked interval would keep calling `sendChatAction`
  // for a turn nobody is waiting on, forever.
  try {
    // Resolve attachments to bytes BEFORE the turn (mt#3235). Two network calls
    // per image, so it happens once here rather than inside the session driver, which
    // is the seam every test stubs.
    const { images, notes } = await resolveAttachments(deps, route);

    const startedAtMs = Date.now();

    // Stream the turn into an edited placeholder (mt#3542). Only a
    // `channel-agent` route runs an agent turn at all — every other route
    // synthesizes its answer immediately, so there is nothing to stream and no
    // placeholder is created.
    const stream = route.kind === "channel-agent" ? createStreamFor(deps, message) : undefined;

    let reply: string;
    let succeeded = true;
    try {
      if (route.kind === "bind") {
        // No conversation session driver involved: binding writes a mapping row, it
        // does not carry out a turn.
        reply = await handleBind(deps, message, route);
      } else {
        const sessionDriver = await resolveDriverForMessage(deps, message);
        reply = await runSessionDriver(sessionDriver, route, images, notes, stream);
      }
    } catch (err: unknown) {
      succeeded = false;
      const detail = err instanceof Error ? err.message : String(err);
      // Report the failure TO THE PRINCIPAL rather than only to the log. They are
      // holding a phone waiting for an answer; a silent swallow is the one
      // outcome the channel must never produce.
      reply = `Could not carry that out: ${detail}`;
      log.error("[principal-channel] session driver failed", { route: route.kind, error: detail });
      await recordFailureOutcome(deps, message, route, detail);
    }

    // Stop the indicator BEFORE the reply lands, so the two never overlap — a
    // "typing…" still showing under a delivered answer reads as a second reply
    // that never arrives.
    typing?.stop();

    // Settle the stream on the authoritative text. It resolves `undefined` when
    // nothing was ever streamed (a turn that produced no partials, or one whose
    // placeholder never landed), which is the signal to deliver normally —
    // SC6: streaming is an enhancement, never a way to lose a reply.
    const streamedMessageId = stream === undefined ? undefined : await stream.finish(reply);
    const replyMessageId =
      streamedMessageId !== undefined ? streamedMessageId : await sendReply(deps, message, reply);
    const delivered = replyMessageId !== undefined;

    // Make a streaming no-op VISIBLE (PR #2538 R1, non-blocking).
    //
    // The reviewer's concern was that dropped deltas are silent. They are, and
    // that matters: if the event shape ever changes, `partialAssistantText`
    // returns null for every frame, streaming quietly stops, and the reply
    // still arrives — so nothing anywhere looks wrong and the feature is just
    // gone.
    //
    // Logging per dropped delta would be the wrong altitude: thinking and
    // tool-call deltas are dropped constantly BY DESIGN, so it would be noise
    // that hides the signal. The actionable event is a whole agent turn that
    // streamed nothing, which is once per turn and close to impossible in
    // normal operation.
    if (stream !== undefined && !stream.hasDelivered()) {
      log.info("[principal-channel] the turn produced no streamed partials", {
        updateId: message.updateId,
        replyChars: reply.length,
      });
    }

    // Close the ack (mt#3486). Replaces the pickup reaction rather than
    // accumulating, so the message carries exactly one state at a time.
    //
    // Gated on DELIVERY, not just on the session driver (PR #2525 R4): a turn can run
    // clean and still fail to reach the principal — a 400, a 429, a dead topic.
    // In that case the reaction is the ONLY signal they get, since the reply
    // itself is what went missing, so marking it 👌 would assert delivery of
    // something they never received.
    void react(deps, message, succeeded && delivered ? REACTION_DONE : REACTION_ERROR);

    // Log the SUCCESS path too (mt#3234). Without this the log only ever showed
    // failures, so "no errors" got read as "replies delivered" — an inference
    // that was wrong. `replyMessageId` is the delivery receipt: present means
    // Telegram accepted the reply, absent means it did not.
    log.info("[principal-channel] handled an inbound message", {
      updateId: message.updateId,
      route: route.kind,
      succeeded,
      durationMs: Date.now() - startedAtMs,
      replyMessageId,
    });
    return succeeded;
  } finally {
    typing?.stop();
  }
}

/**
 * Answer a `/bind` (mt#3507).
 *
 * Refuses, rather than binds silently or crashes, in the two cases the spec
 * calls out by name: no topic to bind (the standing conversation has no
 * mapping row — `messageThreadId` is checked here, not in the pure router,
 * because the router does no I/O and this is the first place that can act on
 * it), and a malformed/nonexistent task id (surfaced by `deps.bindTopic`,
 * which never writes a row in that case).
 */
async function handleBind(
  deps: PollCycleDeps,
  message: InboundTelegramMessage,
  route: Extract<InboundRoute, { kind: "bind" }>
): Promise<string> {
  if (message.messageThreadId === undefined) {
    return (
      "/bind only works inside a topic — the standing conversation has no topic to bind. " +
      "Open a topic thread and try again there."
    );
  }
  if (!deps.bindTopic) {
    return "Binding isn't available on this channel yet.";
  }

  const outcome = await deps.bindTopic(message.messageThreadId, route.taskRef);
  switch (outcome.kind) {
    case "bound":
      return `Bound this topic to ${outcome.taskId}. Notifications about it will land here.`;
    case "invalid-task":
      return `Could not bind: ${outcome.detail}`;
  }
}

/**
 * Build the stream that renders a turn's progress into the chat (mt#3542).
 *
 * The placeholder is sent through the SAME path as an ordinary reply — thread
 * targeting, dead-topic fallback, HTML-with-plain-fallback — so a streamed
 * reply lands exactly where a non-streamed one would. Only the subsequent
 * edits are new.
 */
function createStreamFor(deps: PollCycleDeps, message: InboundTelegramMessage): ReplyStream {
  return createReplyStream({
    token: deps.token,
    chatId: deps.chatId,
    maxChars: MAX_REPLY_CHARS,
    maxRenderedChars: TELEGRAM_MAX_MESSAGE_CHARS,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    transport: {
      // `silent` rides through to Telegram's `disable_notification` (mt#3711),
      // which is what lets a turn be several messages and still cost the
      // principal one notification.
      send: (text: string, opts?: { silent?: boolean }) =>
        sendReply(deps, message, text, opts?.silent === true ? { silent: true } : {}),
    },
  });
}

function runSessionDriver(
  sessionDriver: ChannelDriver,
  route: Exclude<InboundRoute, { kind: "rejected" } | { kind: "bind" }>,
  images: ChannelImage[],
  notes: string[],
  stream?: ReplyStream
): Promise<string> {
  switch (route.kind) {
    case "ask-response":
      return sessionDriver.answerAsk(route.askRef, route.text);
    case "interrupt":
      return sessionDriver.interrupt();
    case "reset":
      return sessionDriver.reset();
    case "unsupported-media":
      // Answered here, with no agent turn: there is nothing for an agent to
      // act on, and the whole point is that the principal hears back at all
      // (mt#3235). Naming what arrived is what makes the answer useful.
      return Promise.resolve(
        `I got ${route.label}, but I can't read that yet — text, photos, and image files only. ` +
          `Send it as a caption or describe it and I'll pick it up from there.`
      );
    case "channel-agent":
      return sessionDriver.converse(withChannelNotes(route.text, notes), {
        ...(route.replyToText === undefined ? {} : { replyToText: route.replyToText }),
        ...(images.length > 0 ? { images } : {}),
        ...(stream
          ? {
              onPartial: (accumulated: string) => stream.push(accumulated),
              onBlockEnd: () => stream.sealBlock(),
            }
          : {}),
      });
  }
}

/**
 * Telegram expires a chat action after about five seconds.
 *
 * Refreshing at four leaves headroom for a slow round-trip without the
 * indicator visibly flickering off between refreshes.
 */
const TYPING_REFRESH_MS = 4_000;

/** A running typing indicator. */
interface TypingLoop {
  stop(): void;
}

/**
 * Keep the "typing…" indicator alive for the duration of a turn (mt#3486).
 *
 * The single fire-and-forget call this replaces was correct for a fast reply
 * and wrong for every slow one: the indicator expired after ~5s and the
 * remaining 90 seconds of a real agent turn looked precisely like the channel
 * having dropped the message. That is the complaint, not a polish item.
 *
 * Every property of the original call is preserved — unawaited, self-swallowing,
 * never able to delay or fail the answer. The loop only changes how LONG the
 * cue lasts.
 */
export function startTypingLoop(opts: {
  token: string;
  chatId: string;
  messageThreadId?: number;
  fetchFn?: FetchFn;
  /**
   * Refresh cadence. Overridable ONLY so tests can observe the loop actually
   * looping — at the 4s default a test would finish before a single refresh
   * fired, so an assertion about stopping would pass whether or not stopping
   * worked.
   */
  refreshMs?: number;
  /**
   * The poller's shutdown signal (PR #2525 R2).
   *
   * Per-turn teardown is not sufficient on its own. `stop()` on the poller
   * aborts this signal, but a turn already in flight keeps awaiting its
   * session driver — so without this listener the interval would go on calling
   * `sendChatAction` after the poller was told to stop, for as long as the
   * abandoned turn ran. Binding to the signal makes shutdown immediate rather
   * than eventual.
   */
  signal?: AbortSignal;
}): TypingLoop {
  let stopped = false;

  const send = (): void => {
    if (stopped) return;
    void sendTelegramTypingAction(opts).catch(() => {
      // Already swallows its own errors; this guards the unawaited promise.
    });
  };

  let timer: ReturnType<typeof setInterval> | null = null;

  const loop: TypingLoop = {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      opts.signal?.removeEventListener("abort", onAbort);
    },
  };

  // Named so it can be removed on stop — an accumulating listener on the
  // poller's long-lived signal would be its own leak, one per turn.
  function onAbort(): void {
    loop.stop();
  }

  // Subscribe BEFORE reading `aborted`, then re-check (PR #2525 R3).
  //
  // Checking first and subscribing after would be correct today — nothing
  // between them suspends, so no abort can interleave on a single-threaded
  // event loop — but that correctness rests on an invariant a later edit could
  // break by introducing one `await`. Subscribe-then-check needs no such
  // argument: whichever way the abort arrives, exactly one of the two paths
  // catches it, and `stop()` is idempotent.
  opts.signal?.addEventListener("abort", onAbort);
  if (opts.signal?.aborted === true) {
    loop.stop();
    return loop;
  }

  send();
  timer = setInterval(send, opts.refreshMs ?? TYPING_REFRESH_MS);
  // The listener may have fired during `send()` in a future where that
  // suspends; honour it rather than leaving an interval behind.
  if (stopped) {
    clearInterval(timer);
    timer = null;
  }

  return loop;
}

/**
 * Mark the principal's message with a pipeline-state reaction (mt#3486).
 *
 * Fire-and-forget by contract: the ack exists to make the pipeline legible, so
 * it must never be able to delay or fail the thing it is reporting on. A
 * rejected emoji (Telegram's allowlist is fixed and revisable) degrades to no
 * reaction, which is why `verify-reaction-emoji.ts` exists to catch that
 * silence deliberately rather than in production.
 */
async function react(
  deps: PollCycleDeps,
  message: InboundTelegramMessage,
  emoji: string
): Promise<void> {
  await setTelegramMessageReaction({
    token: deps.token,
    chatId: deps.chatId,
    messageId: message.messageId,
    emoji,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });
}

/**
 * Append channel-level notes to the text the agent sees.
 *
 * These are facts about the DELIVERY, not the principal's words — an image that
 * could not be fetched, a voice note attached alongside a caption. Bracketed
 * and labelled so the agent can tell them apart from what was actually typed,
 * and included at all so the agent does not answer a message about a screenshot
 * while unaware the screenshot never arrived.
 */
function withChannelNotes(text: string, notes: string[]): string {
  if (notes.length === 0) return text;
  const rendered = `[channel note: ${notes.join("; ")}]`;
  return text.trim().length === 0 ? rendered : `${text}\n\n${rendered}`;
}

/**
 * Fetch the bytes for a route's attachments (mt#3235).
 *
 * A fetch failure degrades to a NOTE rather than failing the turn: the caption
 * is usually the substance, and answering "I couldn't load the image you sent"
 * beats answering nothing. Telegram's `file_path` is short-lived, so a delayed
 * poll cycle hitting a 404 here is an expected condition, not an anomaly.
 */
async function resolveAttachments(
  deps: PollCycleDeps,
  route: Exclude<InboundRoute, { kind: "rejected" }>
): Promise<{ images: ChannelImage[]; notes: string[] }> {
  if (route.kind !== "channel-agent") return { images: [], notes: [] };

  const notes: string[] = [];
  if (route.unsupportedMedia !== undefined) {
    notes.push(`the principal also sent ${route.unsupportedMedia}, which cannot be read`);
  }

  const images: ChannelImage[] = [];
  for (const ref of route.attachments) {
    const fetched = await fetchTelegramFile({
      token: deps.token,
      ref,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    });
    if (fetched.ok) {
      images.push({ base64: fetched.base64, mediaType: fetched.mediaType });
      continue;
    }
    log.warn("[principal-channel] could not fetch an attachment", { detail: fetched.detail });
    notes.push(`an attached image could not be loaded (${fetched.detail})`);
  }

  return { images, notes };
}

/**
 * Deliver the reply, returning Telegram's message id for it.
 *
 * The id is the delivery RECEIPT (mt#3234) — the caller logs it so the question
 * "did a reply actually reach the phone?" is answerable from the log instead of
 * inferred from the absence of an error. `undefined` means it did not land.
 */
async function sendReply(
  deps: PollCycleDeps,
  message: InboundTelegramMessage,
  reply: string,
  opts: { silent?: boolean } = {}
): Promise<number | undefined> {
  const text = reply.trim().length > 0 ? reply.trim() : "(no output)";

  // Truncate the MARKDOWN, then convert (mt#3465). Doing it in this order
  // means the length budget applies to what the principal actually reads
  // rather than to tag overhead, and the converter — which always emits
  // balanced tags — never sees a string cut through the middle of one.
  const plain = truncateReply(text);
  // Shared with the streaming path (mt#3542) so a placeholder, every edit, and
  // the final settle all render by exactly the same rules.
  const payload = renderTelegramPayload(plain, TELEGRAM_MAX_MESSAGE_CHARS);
  const formatted = payload.parseMode !== undefined;
  if (!formatted) {
    log.info("[principal-channel] reply too long once rendered; sending unstyled", {
      plainChars: plain.length,
      // Same key as the rejection warn below (PR #2538 R1) — two names for the
      // same quantity make the pair unqueryable in aggregate.
      htmlChars: payload.text.length,
    });
  }

  const markTopicDead = deps.markTopicDead;
  const result = await sendTelegramMessageWithThreadFallback({
    token: deps.token,
    chatId: deps.chatId,
    text: payload.text,
    ...(formatted ? { parseMode: "HTML" as const, plainFallback: plain } : {}),
    replyToMessageId: message.messageId,
    // Deliver without a notification when the caller asks (mt#3711). Only the
    // streaming path sets it, and only for the second and later messages of a
    // turn — an ordinary reply, and the FIRST message of a streamed turn, must
    // still reach the phone.
    ...(opts.silent === true ? { disableNotification: true } : {}),
    // Post the reply INTO the topic it answers (mt#3505) — otherwise a reply
    // to a topic-routed conversation would land in General even though the
    // turn itself ran against that topic's conversation.
    ...(message.messageThreadId === undefined ? {} : { messageThreadId: message.messageThreadId }),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    // Drift reconciliation (mt#3507): if the topic this reply targets was
    // deleted since the inbound message arrived, fall back to the standing
    // conversation rather than losing the reply — the never-resurrect rule
    // still holds because this send already had a reason to happen (it is a
    // reply, not a standalone housekeeping message).
    ...(markTopicDead
      ? {
          onThreadNotFound: (threadId: number) => markTopicDead(deps.chatId, threadId),
        }
      : {}),
  });
  if (!result.ok) {
    log.error("[principal-channel] reply delivery failed", { detail: result.detail });
    return undefined;
  }
  if (result.fellBackFromDeadTopic) {
    log.warn(
      "[principal-channel] the topic this reply targeted is gone; delivered to the standing conversation instead",
      { messageThreadId: message.messageThreadId }
    );
  }
  if (result.fellBackToPlain) {
    // The message DID arrive, so this is not an error — but it means the
    // converter emitted markup Telegram refused, and without a log that is
    // invisible: every reply would keep landing, just never formatted.
    log.warn("[principal-channel] Telegram rejected the rendered HTML; sent unstyled instead", {
      parseError: result.parseError,
      plainChars: plain.length,
      // Both lengths (PR #2505 R1): the ratio is the first thing worth seeing
      // when diagnosing a rejection, and plain alone does not give it.
      htmlChars: payload.text.length,
    });
  }
  return result.messageId;
}

/**
 * Trim an over-long reply to fit Telegram's message ceiling.
 *
 * Truncates the HEAD of the overflow rather than the tail of the message: an
 * agent's answer puts its conclusion last, so keeping the end preserves what
 * the principal actually asked for.
 */
export function truncateReply(text: string, maxChars: number = MAX_REPLY_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = "[...truncated...]\n";
  return marker + text.slice(text.length - (maxChars - marker.length));
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface PollerHandle {
  stop(): void;
}

/**
 * Poll continuously until stopped.
 *
 * A self-rescheduling async loop rather than `setInterval`: a long poll already
 * blocks for up to `longPollSec`, and an interval would stack overlapping polls
 * on the same bot — which is the "two pollers steal each other's updates"
 * failure in a single process.
 */
export function startPrincipalChannelPoller(
  deps: Omit<PollCycleDeps, "signal">,
  opts: { errorBackoffMs?: number; progressBudgetMs?: number } = {}
): PollerHandle {
  const errorBackoffMs = opts.errorBackoffMs ?? ERROR_BACKOFF_MS;
  let stopped = false;

  // One controller PER CYCLE rather than one for the poller's whole lifetime
  // (mt#4185). An AbortController aborts once and stays aborted, so a lifetime
  // controller can express "shut down" and can never express "abandon this
  // cycle and start another" — which is the only recovery the meta-watchdog is
  // in a position to ask for.
  let cycle = new AbortController();

  const liveness = registerSelfSchedulingSweep({
    name: PRINCIPAL_CHANNEL_SWEEP_NAME,
    progressBudgetMs: opts.progressBudgetMs ?? PRINCIPAL_CHANNEL_PROGRESS_BUDGET_MS,
    restart: (): void => {
      // Abandon whatever this cycle is parked on. It only clears a park in an
      // await that OBSERVES the signal (today: the long poll); a park in the
      // cursor read or the event write is detected and logged here but settles
      // only once mt#4183's per-await bounds land.
      cycle.abort();
    },
  });

  const loop = async (): Promise<void> => {
    while (!stopped) {
      cycle = new AbortController();
      let outcome: PollCycleOutcome;
      try {
        outcome = await runPollCycle({
          ...deps,
          signal: cycle.signal,
          onProgress: liveness.noteProgress,
        });
      } catch (err: unknown) {
        outcome = emptyCycle({ error: err instanceof Error ? err.message : String(err) });
      }
      if (stopped) return;
      if (outcome.error) {
        liveness.noteFailure(outcome.error);
        log.warn("[principal-channel] poll failed; backing off", {
          error: outcome.error,
          backoffMs: errorBackoffMs,
        });
        // An aborted signal makes this resolve immediately, so a restart
        // retries at once instead of serving out a backoff it did not earn.
        await sleep(errorBackoffMs, cycle.signal);
      } else {
        liveness.noteSuccess();
      }
    }
  };

  void loop();

  return {
    stop(): void {
      stopped = true;
      liveness.stop();
      cycle.abort();
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
