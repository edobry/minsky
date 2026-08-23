/**
 * Telegram Bot API transport (mt#3228).
 *
 * The single place in the codebase that speaks the Telegram Bot API over the
 * wire. Raw `fetch` — no SDK, zero new dependencies (the constraint
 * `services/reviewer/src/alert-sink.ts` established in mt#2364 and this module
 * inherits when that sink delegated its send here).
 *
 * Callers: the reviewer's `TelegramAlertSink` (outbound circuit-breaker
 * alerts), the agent-invocable `principal.notify` command (outbound), and the
 * cockpit daemon's inbound poller (`getUpdates`).
 *
 * ## Token redaction is structural, not incidental
 *
 * Telegram embeds the bot token in the URL PATH (`/bot<token>/sendMessage`), so
 * any fetch error, redirect trace, or echoed request line carries the secret.
 * Every string this module returns has already passed through `redactSecret` —
 * callers cannot forget, because they never see an un-redacted string.
 *
 * ## Result unions, not exceptions
 *
 * Every call returns a discriminated result rather than throwing. The reviewer
 * sink is fail-open by contract (a sink failure must never break a sweep) and
 * the poller must survive transient network errors without unwinding its loop;
 * a union serves both without either wrapping calls in try/catch.
 *
 * @see mt#2364 — the original TelegramAlertSink whose Bot API call this absorbed
 * @see mt#3228 — the bidirectional principal channel
 * @see core.telegram.org/bots/api — `sendMessage`, `getUpdates`, `sendChatAction`
 */

import { safeTruncate } from "@minsky/shared/safe-truncate";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Bytes of a non-2xx response body retained for diagnostics. */
const MAX_ERROR_BODY = 500;

/**
 * Largest attachment this channel will forward, measured as the BASE64 PAYLOAD
 * (mt#3235, corrected in PR #2483 R1).
 *
 * The Messages API states its per-image ceiling in base64-encoded bytes, not
 * raw file bytes: "The maximum size per image is: 10 MB (base64-encoded) when
 * using the Claude API directly. 5 MB (base64-encoded) on Amazon Bedrock and
 * Google Cloud." (core docs, Vision → Image limits and costs, read 2026-07-31.)
 * Base64 inflates by 4/3, so a limit enforced on raw bytes admits files ~33%
 * over the real ceiling and fails downstream instead of here.
 *
 * 5 MB rather than 10 MB deliberately: it is the lowest documented ceiling
 * across the platforms a request can be routed through, so the channel behaves
 * the same regardless of which one is behind it. Telegram's own `getFile`
 * limit (20 MB) is far higher and never the binding constraint.
 */
const MAX_ENCODED_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * The raw-byte budget that yields {@link MAX_ENCODED_ATTACHMENT_BYTES} once
 * encoded — base64 emits 4 bytes per 3 input bytes.
 *
 * Used only for the two CHEAP pre-checks (Telegram's declared `file_size`, and
 * the downloaded length) so an oversized file is refused before it is encoded.
 * The authoritative check is still on the encoded string.
 */
const MAX_RAW_ATTACHMENT_BYTES = Math.floor((MAX_ENCODED_ATTACHMENT_BYTES / 4) * 3);

/**
 * Injectable fetch so tests never touch the network.
 *
 * The call signature only, not `typeof fetch`: the global carries runtime-
 * specific extras (Bun's `preconnect`) that a test double has no reason to
 * implement, and this module never uses them. `string | URL` rather than
 * `RequestInfo` because the reviewer workspace's lib does not declare the
 * latter, and every callsite here passes a string anyway.
 */
export type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Replace every occurrence of `secret` in `text` with a fixed marker.
 *
 * Telegram API URLs embed the bot token, so fetch errors and response echoes
 * can leak it — every string leaving this module passes through here.
 *
 * Canonical home for this helper; `scripts/reviewer-alerts/lib.ts` re-exports
 * it so the setup scripts and the runtime path cannot drift apart.
 */
export function redactSecret(secret: string, text: string): string {
  if (!secret) return text;
  return text.split(secret).join("***REDACTED***");
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendMessageOptions {
  token: string;
  chatId: string;
  text: string;
  /** Thread the outbound message as a reply to an earlier one. */
  replyToMessageId?: number;
  /**
   * Render `text` with Telegram's HTML parser (mt#3465).
   *
   * Opt-in, and the default stays plain: the two alert callers (the reviewer's
   * circuit-breaker sink, `notifyPrincipal`) send operator-authored strings
   * that are not Markdown, and mt#2364's contract is that an alert must never
   * fail to deliver because of formatting. Only the conversational reply path
   * opts in.
   *
   * `text` must already be valid Telegram HTML — see
   * `markdownToTelegramHtml`. Pair it with {@link plainFallback}.
   */
  parseMode?: "HTML";
  /**
   * The un-marked-up text to resend if the formatted attempt is rejected.
   *
   * Telegram answers malformed markup with a 400 and delivers NOTHING, which
   * on this channel means the principal silently gets no answer. Supplying the
   * original text turns that into a delivery that is merely unstyled —
   * preserving the "a delivery failure is worse than unstyled text" invariant
   * the plain-text default was built on, rather than trading it away.
   */
  plainFallback?: string;
  /**
   * Post into a specific Telegram DM forum topic (mt#3505).
   *
   * Optional and omitted by default so the two alert callers (the reviewer's
   * circuit-breaker sink, `notifyPrincipal`) — which never target a topic —
   * produce byte-for-byte the same wire payload as before this field existed.
   * A send to a thread id whose topic no longer exists answers HTTP 400 with
   * description "Bad Request: message thread not found" (verified live,
   * mt#3500 Phase 0) — reconciling that is Phase 2's job, not this field's.
   */
  messageThreadId?: number;
  /**
   * Deliver without a notification (mt#3711).
   *
   * Telegram notifies on a SEND but not on an EDIT, which is why the reply
   * stream was built to edit one message in place rather than post a message
   * per chunk (see `principal-channel-reply-stream.ts`). That framing treated
   * "separate message" and "notification" as inseparable; `disable_notification`
   * is what separates them, so a turn can render as successive chat messages —
   * the shape a chat interface actually has — while still buzzing the phone
   * once.
   *
   * Optional and omitted by default, mirroring {@link SendMessageOptions.messageThreadId}
   * above: a caller that does not set it produces byte-for-byte the same wire
   * payload as before this field existed, so the two alert callers (the
   * reviewer's circuit-breaker sink, `notifyPrincipal`) are unaffected.
   */
  disableNotification?: boolean;
  fetchFn?: FetchFn;
}

export type TelegramSendResult =
  | {
      ok: true;
      messageId: number;
      /**
       * Set when the formatted attempt was rejected and this delivery is the
       * plain-text retry (mt#3465).
       *
       * Surfaced rather than logged here: this module has no logger by design
       * (result unions, no side effects), and a silent fallback would make a
       * systematically-broken converter indistinguishable from a healthy one —
       * every message would still arrive, just never formatted. The caller
       * logs it.
       */
      fellBackToPlain?: true;
      /** Telegram's rejection of the markup, for the caller's log. */
      parseError?: string;
    }
  | { ok: false; status?: number; detail: string };

/**
 * Send a message to a chat.
 *
 * **Plain text by DEFAULT** — unchanged from the original contract: agent
 * output routinely contains SHAs, underscores, and error strings that a parse
 * mode can reject, and a delivery failure on an alert channel is worse than
 * unstyled text.
 *
 * A caller that wants formatting opts in with `parseMode` (mt#3465). When it
 * does, a 400 from Telegram — its answer to markup it cannot parse — is
 * retried once as plain text using {@link SendMessageOptions.plainFallback},
 * so the invariant above still holds for the formatted path: the worst case is
 * an unstyled message, never a missing one.
 */
export async function sendTelegramMessage(opts: SendMessageOptions): Promise<TelegramSendResult> {
  const {
    token,
    chatId,
    text,
    replyToMessageId,
    parseMode,
    plainFallback,
    messageThreadId,
    disableNotification,
    fetchFn = fetch,
  } = opts;

  const attempt = await postSendMessage({
    token,
    chatId,
    text,
    replyToMessageId,
    parseMode,
    messageThreadId,
    disableNotification,
    fetchFn,
  });

  // Only a 400 means "I could not parse that" — a 403/429/5xx is about the
  // chat or the service, and resending unstyled would not help.
  const shouldRetryPlain =
    !attempt.ok && attempt.status === 400 && parseMode !== undefined && plainFallback !== undefined;
  if (!shouldRetryPlain) return attempt;

  const parseError = attempt.ok ? "" : attempt.detail;
  const retry = await postSendMessage({
    token,
    chatId,
    text: plainFallback,
    replyToMessageId,
    parseMode: undefined,
    messageThreadId,
    disableNotification,
    fetchFn,
  });

  // Mark the degradation so the caller can log it. Without this the fallback
  // is invisible and a converter that started emitting bad markup would look
  // exactly like one that works.
  return retry.ok ? { ...retry, fellBackToPlain: true, parseError } : retry;
}

/**
 * Detect Telegram's specific "topic deleted" signal (mt#3500 Phase 0 live
 * probe, reconciled here in mt#3507).
 *
 * A `message_thread_id` whose topic no longer exists — the principal deleted
 * it from their phone — answers this EXACT HTTP 400 with this EXACT
 * description, measured live rather than guessed. Matched narrowly (both the
 * status AND the description substring) so an unrelated 400 — bad markup,
 * a malformed chat id — is never mistaken for topic drift and silently
 * rerouted to the standing conversation when the real cause was something
 * else.
 */
export function isThreadNotFoundError(result: TelegramSendResult): boolean {
  return (
    !result.ok &&
    result.status === 400 &&
    result.detail.includes("Bad Request: message thread not found")
  );
}

/** A send that fell back to the standing conversation after {@link isThreadNotFoundError}. */
export type ThreadFallbackSendResult = TelegramSendResult & { fellBackFromDeadTopic?: true };

/**
 * Send a message, reconciling drift when the target topic is gone (mt#3507).
 *
 * `sendTelegramMessage` itself stays ignorant of this: it is wire-level
 * transport, and reconciliation needs a place to record that the mapping is
 * dead, which only a caller with database access can provide. This wraps it
 * with exactly one policy: on {@link isThreadNotFoundError}, tell the caller
 * (so it can mark the mapping dead — never done here, since this module has
 * no persistence), then resend to the STANDING conversation (no thread id)
 * with a note appended so the delivered message itself says it fell back.
 * "A notification must never be lost to a stale mapping" is the whole point —
 * silently dropping the send, or silently landing it with no explanation,
 * both fail that.
 *
 * A message with no `messageThreadId` in the first place never runs this
 * path at all — the two alert callers (the reviewer's circuit-breaker sink,
 * `notifyPrincipal` with no task topic) produce byte-for-byte the same single
 * `sendTelegramMessage` call as before this function existed.
 */
export async function sendTelegramMessageWithThreadFallback(
  opts: SendMessageOptions & {
    /** Called once, before the fallback send, so the caller can mark the mapping dead. */
    onThreadNotFound?: (messageThreadId: number) => Promise<void> | void;
  }
): Promise<ThreadFallbackSendResult> {
  const { onThreadNotFound, ...sendOpts } = opts;
  const attempt = await sendTelegramMessage(sendOpts);

  if (sendOpts.messageThreadId === undefined || !isThreadNotFoundError(attempt)) {
    return attempt;
  }

  await onThreadNotFound?.(sendOpts.messageThreadId);

  const note =
    "\n\n[This topic could not be found — delivered to the standing conversation instead.]";
  const retry = await sendTelegramMessage({
    ...sendOpts,
    text: `${sendOpts.text}${note}`,
    ...(sendOpts.plainFallback === undefined
      ? {}
      : { plainFallback: `${sendOpts.plainFallback}${note}` }),
    messageThreadId: undefined,
  });

  return retry.ok ? { ...retry, fellBackFromDeadTopic: true } : retry;
}

/** One `sendMessage` round-trip. Shared by the formatted attempt and its retry. */
async function postSendMessage(opts: {
  token: string;
  chatId: string;
  text: string;
  replyToMessageId: number | undefined;
  parseMode: "HTML" | undefined;
  messageThreadId: number | undefined;
  disableNotification: boolean | undefined;
  fetchFn: FetchFn;
}): Promise<TelegramSendResult> {
  const {
    token,
    chatId,
    text,
    replyToMessageId,
    parseMode,
    messageThreadId,
    disableNotification,
    fetchFn,
  } = opts;
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
        ...(replyToMessageId === undefined ? {} : { reply_to_message_id: replyToMessageId }),
        ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
        ...(disableNotification === undefined ? {} : { disable_notification: disableNotification }),
      }),
    });
  } catch (err: unknown) {
    return {
      ok: false,
      detail: redactSecret(token, `network error: ${errorText(err)}`),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      detail: redactSecret(token, `HTTP ${response.status}${await bodySnippet(response)}`),
    };
  }

  const body = await readJson(response);
  const messageId = extractMessageId(body);
  if (messageId === undefined) {
    return {
      ok: false,
      status: response.status,
      detail: redactSecret(token, "Telegram returned 2xx without a message id"),
    };
  }
  return { ok: true, messageId };
}

/**
 * Outcome of an {@link editTelegramMessage} call.
 *
 * `notModified` is a SUCCESS, not a failure: Telegram answers a no-op edit with
 * a 400, and a streaming caller that re-sends identical text has not done
 * anything wrong. Collapsing it into `ok: false` would make a harmless race look
 * like a delivery fault.
 */
export type TelegramEditResult =
  | { ok: true; fellBackToPlain: boolean; notModified: boolean }
  | { ok: false; status?: number; detail: string };

/**
 * Replace the text of a message already in the chat (mt#3542).
 *
 * This is what makes streaming possible without spamming: Telegram does NOT
 * push a notification for an edit, so a reply can be revised many times while
 * the principal's phone stays quiet — the objection that argues against
 * streaming as separate MESSAGES is exactly what edit-in-place answers.
 *
 * **No thread parameter, deliberately.** `editMessageText` takes `chat_id` +
 * `message_id` and has no `message_thread_id` (verified against the Bot API
 * reference). A message is already in whatever topic it was sent to, so only
 * the initial send carries the thread id.
 *
 * `plainFallback` mirrors {@link sendTelegramMessage}: if the formatted text is
 * rejected, the unstyled text is tried once rather than losing the update.
 *
 * @see core.telegram.org/bots/api#editmessagetext
 */
export async function editTelegramMessage(opts: {
  token: string;
  chatId: string;
  messageId: number;
  text: string;
  parseMode?: "HTML";
  /** Unstyled text to retry with when the formatted attempt is rejected. */
  plainFallback?: string;
  fetchFn?: FetchFn;
}): Promise<TelegramEditResult> {
  const { token, chatId, messageId, text, parseMode, plainFallback, fetchFn = fetch } = opts;

  const first = await postEditMessageText({
    token,
    chatId,
    messageId,
    text,
    parseMode,
    fetchFn,
  });
  if (first.ok) return first;

  const canRetryPlain =
    parseMode !== undefined && plainFallback !== undefined && first.status === 400;
  if (!canRetryPlain) return first;

  const retry = await postEditMessageText({
    token,
    chatId,
    messageId,
    text: plainFallback,
    parseMode: undefined,
    fetchFn,
  });
  return retry.ok ? { ...retry, fellBackToPlain: true } : retry;
}

/** One `editMessageText` round-trip. Shared by the formatted attempt and its retry. */
async function postEditMessageText(opts: {
  token: string;
  chatId: string;
  messageId: number;
  text: string;
  parseMode: "HTML" | undefined;
  fetchFn: FetchFn;
}): Promise<TelegramEditResult> {
  const { token, chatId, messageId, text, parseMode, fetchFn } = opts;
  const url = `${TELEGRAM_API_BASE}/bot${token}/editMessageText`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        // `editMessageText` documents `link_preview_options`, not the legacy
        // `disable_web_page_preview` the send path still uses.
        link_preview_options: { is_disabled: true },
        ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
      }),
    });
  } catch (err: unknown) {
    return { ok: false, detail: redactSecret(token, `network error: ${errorText(err)}`) };
  }

  // Read the body ONCE, then interpret it — a Response body cannot be consumed
  // twice, and both the success check and the failure detail need it.
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    // intentional-swallow: an unreadable body is reported via the status below.
  }
  let envelope: Record<string, unknown> | null = null;
  try {
    envelope = asRecord(JSON.parse(raw));
  } catch {
    // intentional-swallow: a non-JSON body is handled as an un-parsed failure.
  }

  const description =
    typeof envelope?.["description"] === "string" ? (envelope["description"] as string) : "";

  // A no-op edit reports "message is not modified". Streaming re-sends
  // identical text whenever a turn pauses, so this is an expected steady-state
  // answer, not a fault. Checked BEFORE the ok-flag branch, and without keying
  // on a status code, because it is a success either way Telegram reports it.
  if (/message is not modified/i.test(description)) {
    return { ok: true, fellBackToPlain: false, notModified: true };
  }

  // HTTP 2xx is NOT sufficient (PR #2538 R1). The Bot API carries its own
  // `ok` flag and can answer 200 with `{ ok: false, description }`; trusting
  // the status alone would report a failed edit as applied, and the stream
  // would then advance its state and skip the fallback that guarantees
  // delivery. `sendMessage` already validates its envelope — this matches it.
  //
  // `result` is deliberately not shape-checked: `editMessageText` returns the
  // edited Message for a normal message but bare `true` for an inline one, so
  // there is no single shape to require.
  if (response.ok && envelope?.["ok"] === true) {
    return { ok: true, fellBackToPlain: false, notModified: false };
  }

  const detail =
    description.length > 0
      ? `HTTP ${response.status}: ${description}`
      : `HTTP ${response.status}${raw.length > 0 ? `: ${raw.slice(0, 200)}` : ""}`;
  return { ok: false, status: response.status, detail: redactSecret(token, detail) };
}

/**
 * Show the "typing…" indicator in the chat.
 *
 * Purely a latency-legibility affordance: an inbound message that takes an
 * agent turn to answer would otherwise read as silence. Best-effort by
 * design — a failure here must never affect the answer that follows, so the
 * result is a bare boolean the caller is free to ignore.
 */
export async function sendTelegramTypingAction(opts: {
  token: string;
  chatId: string;
  /**
   * Target topic in a forum chat (mt#3486). Without it the indicator appears
   * in the group's General topic while the reply lands in the entity topic —
   * a latency cue pointing at the wrong conversation is worse than none.
   */
  messageThreadId?: number;
  fetchFn?: FetchFn;
}): Promise<boolean> {
  const { token, chatId, messageThreadId, fetchFn = fetch } = opts;
  try {
    const response = await fetchFn(`${TELEGRAM_API_BASE}/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        action: "typing",
        ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The Bot API's `ReactionTypeEmoji` — the only reaction kind this sends. */
type ReactionTypeEmoji = { type: "emoji"; emoji: string };

/**
 * React to one of the principal's messages (mt#3486).
 *
 * This is the ONLY mechanism that can mark a SPECIFIC inbound message as
 * having reached a pipeline stage. Telegram's checkmarks cannot: a full-text
 * search of the Bot API returns zero occurrences of read-receipt or tick
 * state, so a bot can neither read nor set them. Reactions are the real
 * analogue of what the checkmarks appear to promise.
 *
 * **The emoji set is a fixed allowlist.** `ReactionTypeEmoji.emoji` is
 * documented as "Currently, it can be one of <list>", and an emoji outside it
 * is rejected with a 400. Rather than hard-code an allowlist that Telegram can
 * revise, this returns a bare boolean and swallows the rejection: an
 * unsupported emoji degrades to no reaction, never to a failed turn.
 *
 * Best-effort by contract, like {@link sendTelegramTypingAction} — a reaction
 * failure must never affect the reply, which is the whole point of an ack.
 *
 * Passing an empty `emoji` CLEARS the reaction, which is how a stage is
 * replaced rather than accumulated.
 *
 * @see core.telegram.org/bots/api#setmessagereaction
 */
export async function setTelegramMessageReaction(opts: {
  token: string;
  chatId: string;
  messageId: number;
  /** A single allowlisted emoji, or "" to clear. */
  emoji: string;
  fetchFn?: FetchFn;
}): Promise<boolean> {
  const { token, chatId, messageId, emoji, fetchFn = fetch } = opts;
  try {
    const response = await fetchFn(`${TELEGRAM_API_BASE}/bot${token}/setMessageReaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        // An empty array clears; `is_big` is deliberately omitted (the default
        // animation is right for a status marker).
        reaction:
          emoji.length === 0 ? [] : ([{ type: "emoji", emoji }] satisfies ReactionTypeEmoji[]),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

export type TelegramGetMeResult =
  | { ok: true; hasTopicsEnabled: boolean; allowsUsersToCreateTopics: boolean }
  | { ok: false; status?: number; detail: string };

/**
 * Probe the bot's own topic-mode capability (mt#3505, parent mt#3500).
 *
 * `has_topics_enabled` and `allows_users_to_create_topics` are two @BotFather
 * toggles with no setter in the Bot API — this is read-only. Both fields are
 * present-with-`false` on a bot with topic mode off, not absent, so a bot on
 * an older API build and one with the feature deliberately disabled are
 * indistinguishable from this call alone; the launch-time caller only needs
 * to know "on or off", not why.
 *
 * @see core.telegram.org/bots/api#user — `has_topics_enabled`,
 *   `allows_users_to_create_topics`
 */
export async function getTelegramMe(opts: {
  token: string;
  fetchFn?: FetchFn;
}): Promise<TelegramGetMeResult> {
  const { token, fetchFn = fetch } = opts;
  const url = `${TELEGRAM_API_BASE}/bot${token}/getMe`;

  let response: Response;
  try {
    response = await fetchFn(url, { method: "POST" });
  } catch (err: unknown) {
    return { ok: false, detail: redactSecret(token, `network error: ${errorText(err)}`) };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      detail: redactSecret(token, `HTTP ${response.status}${await bodySnippet(response)}`),
    };
  }

  const result = asRecord(asRecord(await readJson(response))?.["result"]);
  return {
    ok: true,
    hasTopicsEnabled: result?.["has_topics_enabled"] === true,
    allowsUsersToCreateTopics: result?.["allows_users_to_create_topics"] === true,
  };
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

/** One inbound message, narrowed to the fields the router consumes. */
export interface InboundTelegramMessage {
  /** Telegram's monotonic update id — the poll offset cursor and dedupe key. */
  updateId: number;
  messageId: number;
  chatId: string;
  /** Sender's user id. Checked against the allowlist alongside `chatId`. */
  fromId: string | undefined;
  text: string;
  /** Unix seconds, as Telegram reports it. */
  date: number | undefined;
  /** Set when the principal used Telegram's reply affordance. */
  replyToMessageId: number | undefined;
  /**
   * The quoted message's own text (mt#3243).
   *
   * The id alone conveys nothing usable — the agent cannot look a Telegram
   * message id up. The TEXT is what makes "focus on that one" resolve. Falls
   * back to the quoted message's `caption`, because media (photos, videos,
   * documents) carries its text there rather than in `text` — replying to a
   * captioned image is a common shape, and reading only `text` dropped the
   * quote silently (PR #2352 R1). Undefined when the reply targets a message
   * with neither, or when the principal did not reply at all.
   */
  replyToText: string | undefined;
  /**
   * Ingestible media the principal attached (mt#3235).
   *
   * File REFERENCES, not bytes: parsing is pure, and resolving a `file_id` to
   * bytes takes two network calls. The poller resolves these before handing the
   * message to the actuator.
   */
  attachments: InboundAttachmentRef[];
  /**
   * A human label for media this version recognizes but cannot ingest — a voice
   * note, a video, a sticker (mt#3235).
   *
   * Present so the channel can SAY it received something it cannot read.
   * Silence was the original defect: the principal sent two images and got
   * nothing back, with no signal anything had arrived.
   */
  unsupportedMedia: string | undefined;
  /**
   * Which DM forum topic this message arrived in (mt#3505, parent mt#3500).
   *
   * Undefined for a message in the standing (non-topic) conversation — Bot
   * API 9.3 documents `message_thread_id` as present "for supergroups and
   * private chats only" once topic mode is on; a bot without topic mode
   * enabled never sees this field at all, so the channel degrades to today's
   * single-conversation behavior automatically, with no gating logic needed.
   */
  messageThreadId: number | undefined;
  /**
   * Telegram's own flag confirming the message truly belongs to a topic,
   * echoed back verbatim (mt#3500 Phase 0 live probe). Kept alongside
   * `messageThreadId` rather than folded into it because Telegram documents
   * them as two distinct fields — this parser stays a faithful mirror of the
   * wire shape rather than inferring one from the other.
   */
  isTopicMessage: boolean;
}

/**
 * A reference to one attached file, before its bytes are fetched.
 *
 * `mediaType` is constrained to what the Messages API accepts as an image
 * source; a document with any other mime type is classified as unsupported
 * media instead, because forwarding a PDF as if it were a PNG produces an API
 * error rather than a useful turn.
 */
export interface InboundAttachmentRef {
  fileId: string;
  mediaType: SupportedImageMediaType;
  /** Telegram supplies this for documents; photos are unnamed. */
  fileName: string | undefined;
}

/** Image media types the Messages API accepts as a base64 image source. */
export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

function asSupportedImageMediaType(value: unknown): SupportedImageMediaType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return SUPPORTED_IMAGE_MEDIA_TYPES.find((candidate) => candidate === normalized);
}

export interface GetUpdatesOptions {
  token: string;
  /**
   * Telegram: "Must be greater by one than the highest among the identifiers
   * of previously received updates." Omit to receive whatever the server still
   * holds (retained at most 24h).
   */
  offset?: number;
  /** Long-poll seconds. 0 is short polling; the poller passes a real value. */
  timeoutSec?: number;
  fetchFn?: FetchFn;
  /** Abort handle so a shutdown does not wait out the long poll. */
  signal?: AbortSignal;
}

export type TelegramUpdatesResult =
  | { ok: true; messages: InboundTelegramMessage[]; highestUpdateId: number | undefined }
  | { ok: false; status?: number; detail: string };

/**
 * Long-poll for updates.
 *
 * `allowed_updates: ["message"]` narrows the subscription to what the router
 * handles — edited messages, callback queries, and channel posts are not part
 * of the v1 surface and are dropped server-side rather than parsed and
 * discarded here.
 */
export async function getTelegramUpdates(opts: GetUpdatesOptions): Promise<TelegramUpdatesResult> {
  const { token, offset, timeoutSec = 0, fetchFn = fetch, signal } = opts;
  const url = `${TELEGRAM_API_BASE}/bot${token}/getUpdates`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(offset === undefined ? {} : { offset }),
        timeout: timeoutSec,
        allowed_updates: ["message"],
      }),
      ...(signal ? { signal } : {}),
    });
  } catch (err: unknown) {
    return {
      ok: false,
      detail: redactSecret(token, `network error: ${errorText(err)}`),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      detail: redactSecret(
        token,
        classifyGetUpdatesFailure(response.status, await bodySnippet(response))
      ),
    };
  }

  const body = await readJson(response);
  const messages = parseInboundUpdates(body);
  return {
    ok: true,
    messages,
    highestUpdateId: highestUpdateIdOf(body),
  };
}

/**
 * Turn an operator-facing message out of a non-ok `getUpdates` status.
 *
 * 409 and 401 are the two failures with a specific remedy, and both are
 * silent-until-explained otherwise: 409 means a webhook is registered on the
 * bot (Telegram: "This method will not work if an outgoing webhook is set
 * up"), 401 means the token is wrong or revoked.
 */
export function classifyGetUpdatesFailure(status: number, extra = ""): string {
  if (status === 401) {
    return `Telegram rejected the bot token (401).${extra}`;
  }
  if (status === 409) {
    return (
      `getUpdates is blocked because a webhook is registered on this bot (409). ` +
      `Delete it (deleteWebhook), or point the channel at a bot with no webhook.${extra}`
    );
  }
  return `Telegram getUpdates failed (HTTP ${status})${extra}`;
}

/**
 * Extract the messages this channel handles from a `getUpdates` body.
 *
 * Shape-tolerant: any update lacking the fields the router needs (an id, a
 * chat, non-empty text) is skipped rather than throwing, so one malformed or
 * newly-introduced update type cannot stall the poll loop.
 *
 * Exported for direct unit testing without a fetch stub.
 */
export function parseInboundUpdates(body: unknown): InboundTelegramMessage[] {
  const results: InboundTelegramMessage[] = [];
  for (const update of updateArrayOf(body)) {
    const updateId = update["update_id"];
    if (typeof updateId !== "number") continue;

    const message = asRecord(update["message"]);
    if (!message) continue;

    const messageId = message["message_id"];
    if (typeof messageId !== "number") continue;

    const chat = asRecord(message["chat"]);
    const chatId = chat?.["id"];
    if (chatId === undefined) continue;

    // `caption` is where a photo or document carries its text — reading only
    // `text` is what silently dropped every image the principal sent (mt#3235).
    const rawText = message["text"] ?? message["caption"];
    const text = typeof rawText === "string" ? rawText : "";
    const attachments = extractAttachments(message);
    const unsupportedMedia = describeUnsupportedMedia(message);

    // Skip only a message carrying NOTHING this channel can act on. A message
    // with no text but an image is now a message; so is one whose only content
    // is a voice note, because the channel owes the principal an answer saying
    // it cannot read it.
    if (text.trim().length === 0 && attachments.length === 0 && unsupportedMedia === undefined) {
      continue;
    }

    const from = asRecord(message["from"]);
    const replyTo = asRecord(message["reply_to_message"]);
    const replyToMessageId = replyTo?.["message_id"];
    // `text` first: a message has one or the other, but prefer the primary
    // field if a future update type ever carries both.
    const replyToTextRaw = replyTo?.["text"] ?? replyTo?.["caption"];
    const messageThreadId = message["message_thread_id"];

    results.push({
      updateId,
      messageId,
      chatId: String(chatId),
      fromId: from?.["id"] === undefined ? undefined : String(from["id"]),
      text,
      date: typeof message["date"] === "number" ? message["date"] : undefined,
      replyToMessageId: typeof replyToMessageId === "number" ? replyToMessageId : undefined,
      replyToText: typeof replyToTextRaw === "string" ? replyToTextRaw : undefined,
      attachments,
      unsupportedMedia,
      messageThreadId: typeof messageThreadId === "number" ? messageThreadId : undefined,
      isTopicMessage: message["is_topic_message"] === true,
    });
  }
  return results;
}

/**
 * Highest `update_id` in a `getUpdates` body, across ALL updates — including
 * ones `parseInboundUpdates` skips.
 *
 * The next poll's offset must clear every update the server just handed over,
 * not just the ones that parsed. Deriving the cursor from parsed messages
 * instead would re-fetch an unparseable update forever.
 */
export function highestUpdateIdOf(body: unknown): number | undefined {
  let highest: number | undefined;
  for (const update of updateArrayOf(body)) {
    const updateId = update["update_id"];
    if (typeof updateId !== "number") continue;
    if (highest === undefined || updateId > highest) highest = updateId;
  }
  return highest;
}

// ---------------------------------------------------------------------------
// Attachment fetch
// ---------------------------------------------------------------------------

export type TelegramFileResult =
  | { ok: true; base64: string; mediaType: SupportedImageMediaType }
  | { ok: false; detail: string };

/**
 * Resolve one attachment reference to base64 bytes (mt#3235).
 *
 * Two calls, because Telegram splits them: `getFile` trades a `file_id` for a
 * short-lived `file_path`, and the bytes live at a DIFFERENT origin path
 * (`/file/bot<token>/<file_path>`) than the API methods. Both embed the token
 * in the URL, so both error paths redact.
 *
 * @see core.telegram.org/bots/api#getfile
 */
export async function fetchTelegramFile(opts: {
  token: string;
  ref: InboundAttachmentRef;
  fetchFn?: FetchFn;
  /**
   * Refuse an attachment whose BASE64 payload exceeds this. Raw-byte checks
   * along the way are derived from it, not the other way round.
   */
  maxEncodedBytes?: number;
}): Promise<TelegramFileResult> {
  const { token, ref, fetchFn = fetch, maxEncodedBytes = MAX_ENCODED_ATTACHMENT_BYTES } = opts;
  const maxRawBytes =
    maxEncodedBytes === MAX_ENCODED_ATTACHMENT_BYTES
      ? MAX_RAW_ATTACHMENT_BYTES
      : Math.floor((maxEncodedBytes / 4) * 3);

  let metaResponse: Response;
  try {
    metaResponse = await fetchFn(`${TELEGRAM_API_BASE}/bot${token}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: ref.fileId }),
    });
  } catch (err: unknown) {
    return { ok: false, detail: redactSecret(token, `network error: ${errorText(err)}`) };
  }
  if (!metaResponse.ok) {
    return {
      ok: false,
      detail: redactSecret(
        token,
        `getFile failed (HTTP ${metaResponse.status})${await bodySnippet(metaResponse)}`
      ),
    };
  }

  const meta = asRecord(asRecord(await readJson(metaResponse))?.["result"]);
  const filePath = meta?.["file_path"];
  if (meta === null || typeof filePath !== "string" || filePath.length === 0) {
    return { ok: false, detail: "getFile returned no file_path" };
  }
  const declaredSize = meta["file_size"];
  if (typeof declaredSize === "number" && declaredSize > maxRawBytes) {
    return { ok: false, detail: oversizeDetail(declaredSize, maxRawBytes) };
  }

  let fileResponse: Response;
  try {
    fileResponse = await fetchFn(`${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`, {
      method: "GET",
    });
  } catch (err: unknown) {
    return { ok: false, detail: redactSecret(token, `network error: ${errorText(err)}`) };
  }
  if (!fileResponse.ok) {
    return {
      ok: false,
      detail: redactSecret(token, `file download failed (HTTP ${fileResponse.status})`),
    };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await fileResponse.arrayBuffer();
  } catch (err: unknown) {
    return { ok: false, detail: redactSecret(token, `could not read body: ${errorText(err)}`) };
  }
  // Checked again after download: `file_size` is advisory and absent often
  // enough that trusting it alone would let an unbounded body through.
  if (bytes.byteLength > maxRawBytes) {
    return { ok: false, detail: oversizeDetail(bytes.byteLength, maxRawBytes) };
  }

  // The authoritative check (PR #2483 R1). The two raw-byte checks above are
  // cheap guards derived from this one; the API's ceiling is on the ENCODED
  // payload, and encoding is the only place its exact size is known. Padding
  // makes the encoded length slightly exceed the 4/3 estimate for inputs whose
  // length is not a multiple of 3, so a file can clear the raw guard and still
  // land here.
  const base64 = toBase64(new Uint8Array(bytes));
  if (base64.length > maxEncodedBytes) {
    return {
      ok: false,
      detail: `image is ${base64.length} bytes once base64-encoded, over the ${maxEncodedBytes} limit`,
    };
  }

  return { ok: true, base64, mediaType: ref.mediaType };
}

/** Shared wording so the pre- and post-download refusals read identically. */
function oversizeDetail(actualRawBytes: number, limitRawBytes: number): string {
  return (
    `image is ${actualRawBytes} bytes, over the ${limitRawBytes}-byte limit ` +
    `(base64 encoding would push it past the API's encoded-payload ceiling)`
  );
}

/**
 * Base64-encode binary bytes.
 *
 * **Why not `Buffer` (PR #2483 R2).** `Buffer.from(uint8).toString("base64")`
 * is the obvious implementation and does not typecheck in this repo: the
 * `Buffer` type in scope declares only `string | any[]` overloads, and
 * importing it explicitly from `node:buffer` resolves to the same shim, so the
 * call fails with TS2345 either way. Passing an array instead would allocate
 * millions of JS numbers for a multi-megabyte image.
 *
 * **`btoa` is present on both runtimes** — verified 2026-07-31 on this machine:
 * `typeof btoa === "function"` under Bun (what the cockpit daemon actually
 * runs) and under Node v23.4.0, where it has been a global since v16. It is
 * not a browser-only API.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads each byte as its own
 * argument. 8192 keeps every call an order of magnitude below the engine's
 * argument ceiling while still doing the work in few enough passes to be
 * irrelevant at this module's 5 MB limit.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x2000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Pull ingestible image references out of a message.
 *
 * Photos: Telegram sends an ASCENDING array of size variants of one image, so
 * the last entry is the largest. Picking it by `file_size` rather than trusting
 * the ordering costs nothing and does not depend on an undocumented invariant.
 * Telegram re-encodes every `photo` to JPEG.
 *
 * Documents: this is the "send an uncompressed screenshot" path, which is the
 * shape a principal actually uses to show a UI defect, so it matters more than
 * its position in the spec suggests. Only image mime types are taken; anything
 * else falls through to {@link describeUnsupportedMedia}.
 */
function extractAttachments(message: Record<string, unknown>): InboundAttachmentRef[] {
  const refs: InboundAttachmentRef[] = [];

  const photo = message["photo"];
  if (Array.isArray(photo)) {
    let largest: Record<string, unknown> | undefined;
    let largestSize = -1;
    for (const entry of photo) {
      const variant = asRecord(entry);
      if (!variant || typeof variant["file_id"] !== "string") continue;
      const size = typeof variant["file_size"] === "number" ? variant["file_size"] : 0;
      if (size >= largestSize) {
        largest = variant;
        largestSize = size;
      }
    }
    if (largest && typeof largest["file_id"] === "string") {
      refs.push({ fileId: largest["file_id"], mediaType: "image/jpeg", fileName: undefined });
    }
  }

  const document = asRecord(message["document"]);
  const documentFileId = document?.["file_id"];
  const documentMediaType = asSupportedImageMediaType(document?.["mime_type"]);
  if (typeof documentFileId === "string" && documentMediaType !== undefined) {
    refs.push({
      fileId: documentFileId,
      mediaType: documentMediaType,
      fileName: typeof document?.["file_name"] === "string" ? document["file_name"] : undefined,
    });
  }

  return refs;
}

/**
 * Name the media this version cannot ingest, for the acknowledgement reply.
 *
 * Returns a label rather than a boolean because the reply says WHAT arrived —
 * "I can't read voice notes yet" is actionable; "I can't read that" is not.
 * A document with an unsupported mime type lands here by design: it is real
 * content the principal sent that this channel is not going to read.
 */
function describeUnsupportedMedia(message: Record<string, unknown>): string | undefined {
  const labels: Array<[string, string]> = [
    ["voice", "a voice message"],
    ["audio", "an audio file"],
    ["video", "a video"],
    ["video_note", "a video note"],
    ["animation", "an animation"],
    ["sticker", "a sticker"],
    ["location", "a location"],
    ["contact", "a contact"],
    ["poll", "a poll"],
  ];
  for (const [field, label] of labels) {
    if (asRecord(message[field]) !== null) return label;
  }

  // A document whose mime type is not an image the Messages API accepts —
  // recognized, deliberately not ingested.
  const document = asRecord(message["document"]);
  if (document && asSupportedImageMediaType(document["mime_type"]) === undefined) {
    const name = typeof document["file_name"] === "string" ? document["file_name"] : undefined;
    const mime = typeof document["mime_type"] === "string" ? document["mime_type"] : "unknown type";
    return name === undefined ? `a file (${mime})` : `the file ${name} (${mime})`;
  }

  return undefined;
}

function updateArrayOf(body: unknown): Array<Record<string, unknown>> {
  const record = asRecord(body);
  const result = record?.["result"];
  if (!Array.isArray(result)) return [];
  return result.filter((entry): entry is Record<string, unknown> => asRecord(entry) !== null);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractMessageId(body: unknown): number | undefined {
  const result = asRecord(asRecord(body)?.["result"]);
  const messageId = result?.["message_id"];
  return typeof messageId === "number" ? messageId : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Bounded, guarded read of an error body — never breaks the caller's path. */
async function bodySnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    return `: ${safeTruncate(text, MAX_ERROR_BODY, "head")}`;
  } catch {
    return "";
  }
}
