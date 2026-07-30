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
  fetchFn?: FetchFn;
}

export type TelegramSendResult =
  | { ok: true; messageId: number }
  | { ok: false; status?: number; detail: string };

/**
 * Send a message to a chat.
 *
 * Plain text with no `parse_mode`: agent output routinely contains SHAs,
 * underscores, and error strings that Markdown/HTML parse modes reject or
 * mangle, and a delivery failure on an alert channel is worse than unstyled
 * text.
 */
export async function sendTelegramMessage(opts: SendMessageOptions): Promise<TelegramSendResult> {
  const { token, chatId, text, replyToMessageId, fetchFn = fetch } = opts;
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
        ...(replyToMessageId === undefined ? {} : { reply_to_message_id: replyToMessageId }),
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
  fetchFn?: FetchFn;
}): Promise<boolean> {
  const { token, chatId, fetchFn = fetch } = opts;
  try {
    const response = await fetchFn(`${TELEGRAM_API_BASE}/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
    return response.ok;
  } catch {
    return false;
  }
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

    const text = message["text"];
    if (typeof text !== "string" || text.trim().length === 0) continue;

    const from = asRecord(message["from"]);
    const replyTo = asRecord(message["reply_to_message"]);
    const replyToMessageId = replyTo?.["message_id"];
    // `text` first: a message has one or the other, but prefer the primary
    // field if a future update type ever carries both.
    const replyToTextRaw = replyTo?.["text"] ?? replyTo?.["caption"];

    results.push({
      updateId,
      messageId,
      chatId: String(chatId),
      fromId: from?.["id"] === undefined ? undefined : String(from["id"]),
      text,
      date: typeof message["date"] === "number" ? message["date"] : undefined,
      replyToMessageId: typeof replyToMessageId === "number" ? replyToMessageId : undefined,
      replyToText: typeof replyToTextRaw === "string" ? replyToTextRaw : undefined,
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
// Internals
// ---------------------------------------------------------------------------

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
