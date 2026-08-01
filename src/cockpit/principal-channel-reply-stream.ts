/**
 * Stream a turn into an edited placeholder instead of one blob at the end
 * (mt#3542).
 *
 * The principal's complaint: a 90-second turn was 90 seconds of nothing
 * followed by a wall of text, with no sign anything was happening.
 *
 * The mechanism is edit-in-place. Forwarding partial output as separate
 * MESSAGES would notify the principal's phone on every chunk — the objection
 * that kept `awaitTurnResult` discarding intermediate events in the first
 * place. Telegram does not notify on an edit, so one message can be revised
 * many times while the phone stays quiet.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **Every intermediate state is valid on its own.** Each edit is converted
 *    from the accumulated MARKDOWN; rendered HTML is never sliced. The
 *    converter always emits balanced tags for a truncated markdown input, which
 *    is what makes a mid-stream cut safe — and is why the formatter (mt#3465)
 *    had to land before this.
 * 2. **Delivery never regresses.** Streaming is an enhancement over a working
 *    path. If any edit fails, the final text is still delivered — a half-drawn
 *    reply that never settles is worse than the blob it replaced.
 * 3. **The cadence stays under Telegram's ceiling.** See {@link EDIT_THROTTLE_MS}.
 */

import { log } from "@minsky/shared/logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { editTelegramMessage, type FetchFn } from "@minsky/domain/notify/telegram-transport";
import { markdownToTelegramHtml } from "@minsky/domain/notify/markdown-to-telegram-html";

/**
 * Gap between edits.
 *
 * Telegram's Bot FAQ says *"In a single chat, avoid sending more than one
 * message per second"* — this channel is forum topics inside a PRIVATE chat,
 * not a supergroup, so the stricter 20-per-minute group limit does not apply.
 *
 * 1500ms rather than the documented 1000ms floor because edits are not the only
 * traffic in this chat: the placeholder send, the final settle, the 👀/👌
 * reactions, and the 4-second typing refresh all share that budget. Sitting
 * exactly at the ceiling leaves nothing for them.
 *
 * Telegram does NOT document whether an edit counts against the message rate at
 * all — the `editMessageText` reference carries no rate-limit language. This
 * value is therefore deliberately conservative rather than tuned.
 */
export const EDIT_THROTTLE_MS = 1_500;

/** How a stream puts text into the chat. Injected so the poller keeps ownership of send semantics. */
export interface ReplyStreamTransport {
  /**
   * Send a NEW message and resolve with its id, or `undefined` if it did not
   * land. Used for the placeholder and for each message after a chunk split.
   */
  send(text: string): Promise<number | undefined>;
}

export interface ReplyStreamOptions {
  token: string;
  chatId: string;
  transport: ReplyStreamTransport;
  /** Bounds the MARKDOWN of a single message; a longer turn splits across messages. */
  maxChars: number;
  /** Telegram's hard ceiling for one message, applied to the RENDERED payload. */
  maxRenderedChars: number;
  fetchFn?: FetchFn;
  throttleMs?: number;
  /** Injected for tests; production reads the clock. */
  now?: () => number;
}

export interface ReplyStream {
  /**
   * Report the text accumulated so far. Never throws and never blocks — it is
   * called from the actuator's event subscriber, which must not be made to wait
   * on a network round-trip.
   */
  push(accumulated: string): void;
  /**
   * Settle on the turn's authoritative text and resolve with the id of the
   * message carrying its tail.
   *
   * Resolves `undefined` when nothing was ever delivered, which is the caller's
   * signal to fall back to an ordinary send.
   */
  finish(finalText: string): Promise<number | undefined>;
  /** True once a placeholder exists — i.e. the stream owns the reply. */
  hasDelivered(): boolean;
}

/**
 * Render markdown for Telegram, falling back to unstyled text when the rendered
 * payload would exceed Telegram's own ceiling.
 *
 * Tags and entities inflate the payload, so markdown that fits the char budget
 * can still render past 4096. Sending the unstyled text beats sending something
 * Telegram rejects outright.
 */
export function renderTelegramPayload(
  markdown: string,
  maxRenderedChars: number
): { text: string; parseMode?: "HTML"; plainFallback?: string } {
  const html = markdownToTelegramHtml(markdown);
  if (html.length <= maxRenderedChars) {
    return { text: html, parseMode: "HTML", plainFallback: markdown };
  }
  return { text: markdown };
}

/**
 * Pick where to cut an over-long chunk.
 *
 * Prefers a paragraph break, then a line break, then a space — cutting
 * mid-sentence is worse to read, and cutting mid-word is worse still. Falls
 * back to a hard cut only when the window holds no break at all (a single
 * unbroken token longer than the budget).
 *
 * Only breaks in the last quarter of the window are considered; an early break
 * would waste most of a message.
 *
 * The returned index is PAST the separator, so the separator itself is consumed
 * by the cut rather than opening the next message with a blank line. The two
 * halves therefore do not concatenate back byte-for-byte — no content is lost,
 * only the whitespace the split happened on.
 */
export function findChunkBreak(text: string, limit: number): number {
  if (text.length <= limit) return text.length;

  // Surrogate-safe: a naive cut at `limit` can sever an emoji's surrogate pair
  // and put a lone surrogate on the wire. This is a chat channel — emoji in a
  // streamed reply are ordinary, not an edge case.
  const window = safeTruncate(text, limit, "head");
  const floor = Math.floor(limit * 0.75);

  for (const sep of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(sep);
    if (at >= floor) return at + sep.length;
  }
  return window.length;
}

export function createReplyStream(opts: ReplyStreamOptions): ReplyStream {
  const {
    token,
    chatId,
    transport,
    maxChars,
    maxRenderedChars,
    fetchFn,
    throttleMs = EDIT_THROTTLE_MS,
    now = () => Date.now(),
  } = opts;

  /** Latest accumulated text reported by the turn. */
  let pending = "";
  /** Chars already committed to CLOSED messages — the current message renders past this. */
  let offset = 0;
  /** The message currently being edited; `undefined` before the placeholder exists. */
  let currentMessageId: number | undefined;
  /** What the current message was last written with, so a no-op edit is skipped entirely. */
  let lastWritten = "";
  /** Set once editing has failed in a way that makes further streaming pointless. */
  let degraded = false;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let lastFlushAt = 0;
  let finished = false;

  /** Put `text` into the current message, opening one if needed. */
  async function write(text: string): Promise<void> {
    if (text.length === 0 || text === lastWritten) return;

    if (currentMessageId === undefined) {
      const id = await transport.send(text);
      if (id === undefined) {
        // The placeholder never landed. Nothing to edit into, so stop
        // streaming; `finish` falls back to an ordinary send.
        degraded = true;
        return;
      }
      currentMessageId = id;
      lastWritten = text;
      return;
    }

    const payload = renderTelegramPayload(text, maxRenderedChars);
    const result = await editTelegramMessage({
      token,
      chatId,
      messageId: currentMessageId,
      text: payload.text,
      ...(payload.parseMode ? { parseMode: payload.parseMode } : {}),
      ...(payload.plainFallback === undefined ? {} : { plainFallback: payload.plainFallback }),
      ...(fetchFn ? { fetchFn } : {}),
    });

    if (result.ok) {
      lastWritten = text;
      return;
    }

    // An edit failing mid-stream is not fatal: the message already in the chat
    // keeps its last good content, and `finish` still delivers the full text.
    // Marking degraded stops burning rate budget on a doomed edit loop.
    degraded = true;
    log.warn("[principal-channel] streaming edit failed; will settle with a plain send", {
      messageId: currentMessageId,
      status: result.status,
      detail: result.detail,
    });
  }

  /**
   * Write everything currently pending, splitting into additional messages
   * whenever the current one would exceed the per-message budget.
   */
  async function drain(): Promise<void> {
    if (degraded) return;

    // Loop rather than split once: a burst can push past the budget by more
    // than one message's worth between flushes.
    for (;;) {
      const remainder = pending.slice(offset);
      if (remainder.length <= maxChars) {
        await write(remainder);
        return;
      }

      const cut = findChunkBreak(remainder, maxChars);
      await write(remainder.slice(0, cut));
      if (degraded) return;

      // Close the current message and start a fresh one for what follows.
      offset += cut;
      currentMessageId = undefined;
      lastWritten = "";
    }
  }

  /**
   * Arm the next flush.
   *
   * **Cadence is favoured over latency for the newest chunk (PR #2538 R1).**
   * The wait is computed once, when the timer is armed, so a chunk arriving
   * just after that can wait most of a window before it is drawn. That is the
   * intended trade: the alternative — re-arming on every push — converges on
   * one write per chunk, which is the rate-limit behaviour the throttle exists
   * to prevent. The first flush is exempt (its wait computes to 0), so the
   * placeholder still appears immediately.
   */
  function schedule(): void {
    if (timer !== null || finished || degraded) return;
    const wait = Math.max(0, throttleMs - (now() - lastFlushAt));
    timer = setTimeout(() => {
      timer = null;
      lastFlushAt = now();
      inFlight = inFlight.then(drain).catch((err: unknown) => {
        // Never let a streaming failure escape into the turn.
        degraded = true;
        log.warn("[principal-channel] streaming flush threw; settling with a plain send", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, wait);
  }

  return {
    push(accumulated: string): void {
      if (finished || degraded) return;
      if (accumulated.length <= pending.length) return;
      pending = accumulated;
      schedule();
    },

    hasDelivered(): boolean {
      return currentMessageId !== undefined || offset > 0;
    },

    async finish(finalText: string): Promise<number | undefined> {
      finished = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight;

      // Editing is broken, so the message in the chat is stuck at whatever
      // partial text last landed. Report NOT-delivered so the caller sends the
      // complete reply as a fresh message.
      //
      // That can duplicate text the principal already sees, which is the
      // deliberate trade: SC6 puts delivering the whole answer above keeping the
      // transcript tidy. Claiming delivery here would leave them holding a
      // half-drawn reply that never settles — strictly worse than the single
      // blob streaming replaced.
      if (degraded) return undefined;

      // Nothing was ever put in the chat — the caller sends normally.
      if (currentMessageId === undefined && offset === 0) return undefined;

      // The resolved text is authoritative and can differ from what streamed
      // (a turn with tool-use rounds streams text around each round). Settle on
      // it rather than leaving the accumulation in place.
      //
      // Only the tail is rewritten: earlier messages were closed at chunk
      // boundaries and editing them back into agreement would cost an edit each
      // and rewrite history the principal has already read.
      pending = finalText;
      if (finalText.length <= offset) {
        // The final text is shorter than what has already been committed to
        // closed messages — nothing coherent to rewrite, so leave the chat as
        // it stands rather than emit a contradicting tail.
        return currentMessageId;
      }

      await drain();
      // The settle itself can fail — same rule as above: an unsettled message
      // is not a delivered reply.
      return degraded ? undefined : currentMessageId;
    },
  };
}
