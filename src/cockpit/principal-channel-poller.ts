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
  sendTelegramMessage,
  sendTelegramTypingAction,
  type FetchFn,
  type InboundTelegramMessage,
} from "@minsky/domain/notify/telegram-transport";
import { markdownToTelegramHtml } from "@minsky/domain/notify/markdown-to-telegram-html";
import {
  buildInboundEventPayload,
  inboundEventToken,
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
 * a future actuator (steering an arbitrary live conversation, once mt#3095's
 * conversation-keyed identity lands) drops in.
 */
/**
 * One resolved image, ready to attach to a turn (mt#3235).
 *
 * Declared here rather than imported from the driven-session host so the
 * actuator seam stays free of the host's types — a future actuator that is not
 * backed by a `claude` child still speaks this interface.
 */
export interface ChannelImage {
  base64: string;
  mediaType: string;
}

export interface ChannelActuator {
  /**
   * Hand text to the standing channel conversation; resolve with its reply.
   *
   * `replyToText` is the quoted message when the principal used Telegram's
   * reply affordance (mt#3243). Optional because most messages are not
   * replies — and because the reply target is context for the turn, not a
   * routing decision, so the poller stays out of how it is presented.
   */
  converse(text: string, replyToText?: string, images?: ChannelImage[]): Promise<string>;
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

/** Append-only audit sink. One row per inbound update, before any side effect. */
export type InboundEventRecorder = (
  eventType: InboundEventType,
  payload: PrincipalMessageEventPayload
) => Promise<RecordOutcome>;

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
  /** Acted on AND the actuator succeeded. */
  handled: number;
  /** Acted on but the actuator threw. Counted apart from `handled` so a
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
    return emptyCycle({ error: result.detail });
  }

  let handled = 0;
  let failed = 0;
  let rejected = 0;
  let duplicates = 0;

  for (const message of result.messages) {
    const route = routeInboundMessage(message, deps.auth);

    // Audit BEFORE acting. An RCE-adjacent surface must leave a record of what
    // it was asked to do even if carrying it out then fails or hangs.
    const recorded = await recordSafely(deps, message, route);

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

    if (route.kind === "rejected") {
      rejected += 1;
      log.warn("[principal-channel] refused an inbound message", {
        reason: route.reason,
        updateId: message.updateId,
      });
      continue;
    }

    const succeeded = await handleRoute(deps, message, route);
    if (succeeded) handled += 1;
    else failed += 1;
  }

  // Advance the cursor past EVERY update Telegram handed over, including ones
  // that failed to parse — otherwise an unparseable update is re-fetched
  // forever and the channel wedges behind it.
  if (result.highestUpdateId !== undefined) {
    await deps.cursor.write(result.highestUpdateId);
  }

  return { received: result.messages.length, handled, failed, rejected, duplicates };
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
): Promise<RecordOutcome> {
  try {
    return await deps.recordEvent(
      route.kind === "rejected" ? "principal.message_rejected" : "principal.message_received",
      buildInboundEventPayload(message, route)
    );
  } catch (err: unknown) {
    log.error("[principal-channel] failed to record the inbound audit event", {
      updateId: message.updateId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "recorded";
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
  if (route.kind !== "interrupt") {
    void sendTelegramTypingAction({
      token: deps.token,
      chatId: deps.chatId,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    }).catch(() => {
      // Already swallows its own errors; this guards the unawaited promise.
    });
  }

  // Resolve attachments to bytes BEFORE the turn (mt#3235). Two network calls
  // per image, so it happens once here rather than inside the actuator, which
  // is the seam every test stubs.
  const { images, notes } = await resolveAttachments(deps, route);

  const startedAtMs = Date.now();
  let reply: string;
  let succeeded = true;
  try {
    reply = await runActuator(deps.actuator, route, images, notes);
  } catch (err: unknown) {
    succeeded = false;
    const detail = err instanceof Error ? err.message : String(err);
    // Report the failure TO THE PRINCIPAL rather than only to the log. They are
    // holding a phone waiting for an answer; a silent swallow is the one
    // outcome the channel must never produce.
    reply = `Could not carry that out: ${detail}`;
    log.error("[principal-channel] actuator failed", { route: route.kind, error: detail });
    await recordFailureOutcome(deps, message, route, detail);
  }

  const replyMessageId = await sendReply(deps, message, reply);

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
}

function runActuator(
  actuator: ChannelActuator,
  route: Exclude<InboundRoute, { kind: "rejected" }>,
  images: ChannelImage[],
  notes: string[]
): Promise<string> {
  switch (route.kind) {
    case "ask-response":
      return actuator.answerAsk(route.askRef, route.text);
    case "interrupt":
      return actuator.interrupt();
    case "reset":
      return actuator.reset();
    case "unsupported-media":
      // Answered here, with no agent turn: there is nothing for an agent to
      // act on, and the whole point is that the principal hears back at all
      // (mt#3235). Naming what arrived is what makes the answer useful.
      return Promise.resolve(
        `I got ${route.label}, but I can't read that yet — text, photos, and image files only. ` +
          `Send it as a caption or describe it and I'll pick it up from there.`
      );
    case "channel-agent":
      return actuator.converse(withChannelNotes(route.text, notes), route.replyToText, images);
  }
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
  reply: string
): Promise<number | undefined> {
  const text = reply.trim().length > 0 ? reply.trim() : "(no output)";

  // Truncate the MARKDOWN, then convert (mt#3465). Doing it in this order
  // means the length budget applies to what the principal actually reads
  // rather than to tag overhead, and the converter — which always emits
  // balanced tags — never sees a string cut through the middle of one.
  const plain = truncateReply(text);
  const html = markdownToTelegramHtml(plain);

  // Tags and entities inflate the payload, so a markdown body inside the
  // budget can still exceed Telegram's own 4096 ceiling. Send the unstyled
  // text rather than a message Telegram will reject outright.
  const formatted = html.length <= TELEGRAM_MAX_MESSAGE_CHARS;
  if (!formatted) {
    log.info("[principal-channel] reply too long once rendered; sending unstyled", {
      plainChars: plain.length,
      htmlChars: html.length,
    });
  }

  const result = await sendTelegramMessage({
    token: deps.token,
    chatId: deps.chatId,
    text: formatted ? html : plain,
    ...(formatted ? { parseMode: "HTML" as const, plainFallback: plain } : {}),
    replyToMessageId: message.messageId,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });
  if (!result.ok) {
    log.error("[principal-channel] reply delivery failed", { detail: result.detail });
    return undefined;
  }
  if (result.fellBackToPlain) {
    // The message DID arrive, so this is not an error — but it means the
    // converter emitted markup Telegram refused, and without a log that is
    // invisible: every reply would keep landing, just never formatted.
    log.warn("[principal-channel] Telegram rejected the rendered HTML; sent unstyled instead", {
      parseError: result.parseError,
      plainChars: plain.length,
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
        outcome = emptyCycle({ error: err instanceof Error ? err.message : String(err) });
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
