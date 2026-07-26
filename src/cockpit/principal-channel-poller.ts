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
  getTelegramUpdates,
  sendTelegramMessage,
  sendTelegramTypingAction,
  type FetchFn,
  type InboundTelegramMessage,
} from "@minsky/domain/notify/telegram-transport";
import {
  buildInboundEventPayload,
  routeInboundMessage,
  type InboundAuthorization,
  type InboundRoute,
  type PrincipalMessageEventPayload,
} from "@minsky/domain/notify/principal-inbound";

/**
 * Long-poll seconds. 25s sits inside Telegram's own server-side ceiling while
 * keeping a message's worst-case pickup latency well under the "did it even
 * arrive?" threshold a human notices.
 */
const DEFAULT_LONG_POLL_SEC = 25;

/** Backoff after a failed poll, so a Telegram outage is not hammered. */
const ERROR_BACKOFF_MS = 30_000;

/** Cap on a single outbound reply. Telegram hard-rejects above 4096. */
const MAX_REPLY_CHARS = 3500;

/**
 * What the router's decision is carried out against.
 *
 * A seam, not an abstraction for its own sake: it is what lets every routing
 * and audit path be tested without spawning a `claude` process, and it is where
 * a future actuator (steering an arbitrary live conversation, once mt#3095's
 * conversation-keyed identity lands) drops in.
 */
export interface ChannelActuator {
  /** Hand text to the standing channel conversation; resolve with its reply. */
  converse(text: string): Promise<string>;
  /** Interrupt the current turn. Must not queue behind it. */
  interrupt(): Promise<string>;
  /** Abandon the current conversation; the next message starts fresh. */
  reset(): Promise<string>;
  /** Answer a specific ask by ref, with no agent turn in between. */
  answerAsk(askRef: string, text: string): Promise<string>;
}

/** Persisted poll cursor. Backed by the append-only inbound event log. */
export interface PollCursor {
  read(): Promise<number | undefined>;
  write(updateId: number): Promise<void>;
}

/** Append-only audit sink. One row per inbound update, before any side effect. */
export type InboundEventRecorder = (
  eventType: "principal.message_received" | "principal.message_rejected",
  payload: PrincipalMessageEventPayload
) => Promise<void>;

export interface PollCycleDeps {
  token: string;
  chatId: string;
  auth: InboundAuthorization;
  actuator: ChannelActuator;
  cursor: PollCursor;
  recordEvent: InboundEventRecorder;
  longPollSec?: number;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
}

export interface PollCycleOutcome {
  /** Messages Telegram returned, including ones the allowlist refused. */
  received: number;
  handled: number;
  rejected: number;
  /** Set when the poll itself failed; the caller backs off. */
  error?: string;
}

/**
 * Run one long-poll and act on everything it returns.
 *
 * Messages are handled SEQUENTIALLY, not concurrently: they are turns in one
 * conversation, and a human who sends two messages in a row means them in that
 * order. Racing them would interleave turns and destroy the grounding the
 * standing conversation exists to provide.
 */
export async function runPollCycle(deps: PollCycleDeps): Promise<PollCycleOutcome> {
  const offset = await deps.cursor.read();
  const result = await getTelegramUpdates({
    token: deps.token,
    ...(offset === undefined ? {} : { offset: offset + 1 }),
    timeoutSec: deps.longPollSec ?? DEFAULT_LONG_POLL_SEC,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  if (!result.ok) {
    return { received: 0, handled: 0, rejected: 0, error: result.detail };
  }

  let handled = 0;
  let rejected = 0;

  for (const message of result.messages) {
    const route = routeInboundMessage(message, deps.auth);

    // Audit BEFORE acting. An RCE-adjacent surface must leave a record of what
    // it was asked to do even if carrying it out then fails or hangs.
    await recordSafely(deps, message, route);

    if (route.kind === "rejected") {
      rejected += 1;
      log.warn("[principal-channel] refused an inbound message", {
        reason: route.reason,
        updateId: message.updateId,
      });
      continue;
    }

    await handleRoute(deps, message, route);
    handled += 1;
  }

  // Advance the cursor past EVERY update Telegram handed over, including ones
  // that failed to parse — otherwise an unparseable update is re-fetched
  // forever and the channel wedges behind it.
  if (result.highestUpdateId !== undefined) {
    await deps.cursor.write(result.highestUpdateId);
  }

  return { received: result.messages.length, handled, rejected };
}

/**
 * Record the audit row without letting a recorder failure drop the message.
 *
 * The audit is the priority, but a DB hiccup must not make the channel
 * unresponsive — a principal whose messages vanish during a Postgres blip has
 * a channel they cannot trust. The failure is logged loudly instead.
 */
async function recordSafely(
  deps: PollCycleDeps,
  message: InboundTelegramMessage,
  route: InboundRoute
): Promise<void> {
  try {
    await deps.recordEvent(
      route.kind === "rejected" ? "principal.message_rejected" : "principal.message_received",
      buildInboundEventPayload(message, route)
    );
  } catch (err: unknown) {
    log.error("[principal-channel] failed to record the inbound audit event", {
      updateId: message.updateId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleRoute(
  deps: PollCycleDeps,
  message: InboundTelegramMessage,
  route: Exclude<InboundRoute, { kind: "rejected" }>
): Promise<void> {
  // Silence reads as breakage on a chat channel, and a conversational turn can
  // take a while. Show the typing indicator before starting — except on
  // interrupt, whose whole point is to be immediate.
  if (route.kind !== "interrupt") {
    await sendTelegramTypingAction({
      token: deps.token,
      chatId: deps.chatId,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    });
  }

  let reply: string;
  try {
    reply = await runActuator(deps.actuator, route);
  } catch (err: unknown) {
    // Report the failure TO THE PRINCIPAL rather than only to the log. They are
    // holding a phone waiting for an answer; a silent swallow is the one
    // outcome the channel must never produce.
    reply = `Could not carry that out: ${err instanceof Error ? err.message : String(err)}`;
    log.error("[principal-channel] actuator failed", {
      route: route.kind,
      error: reply,
    });
  }

  await sendReply(deps, message, reply);
}

function runActuator(
  actuator: ChannelActuator,
  route: Exclude<InboundRoute, { kind: "rejected" }>
): Promise<string> {
  switch (route.kind) {
    case "ask-response":
      return actuator.answerAsk(route.askRef, route.text);
    case "interrupt":
      return actuator.interrupt();
    case "reset":
      return actuator.reset();
    case "channel-agent":
      return actuator.converse(route.text);
  }
}

async function sendReply(
  deps: PollCycleDeps,
  message: InboundTelegramMessage,
  reply: string
): Promise<void> {
  const text = reply.trim().length > 0 ? reply.trim() : "(no output)";
  const result = await sendTelegramMessage({
    token: deps.token,
    chatId: deps.chatId,
    text: truncateReply(text),
    replyToMessageId: message.messageId,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });
  if (!result.ok) {
    log.error("[principal-channel] reply delivery failed", { detail: result.detail });
  }
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
  opts: { errorBackoffMs?: number } = {}
): PollerHandle {
  const controller = new AbortController();
  const errorBackoffMs = opts.errorBackoffMs ?? ERROR_BACKOFF_MS;
  let stopped = false;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      let outcome: PollCycleOutcome;
      try {
        outcome = await runPollCycle({ ...deps, signal: controller.signal });
      } catch (err: unknown) {
        outcome = {
          received: 0,
          handled: 0,
          rejected: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (stopped) return;
      if (outcome.error) {
        log.warn("[principal-channel] poll failed; backing off", {
          error: outcome.error,
          backoffMs: errorBackoffMs,
        });
        await sleep(errorBackoffMs, controller.signal);
      }
    }
  };

  void loop();

  return {
    stop(): void {
      stopped = true;
      controller.abort();
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
