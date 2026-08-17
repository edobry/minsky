/**
 * Stream a turn into the chat as successive messages (mt#3542, mt#3711).
 *
 * The principal's first complaint (mt#3542): a 90-second turn was 90 seconds
 * of nothing followed by a wall of text, with no sign anything was happening.
 * That was answered by editing ONE placeholder message in place.
 *
 * The second complaint (mt#3711) was about that answer: *"that's how chat
 * works: just a bunch of small messages instead of editing previous ones to
 * make them longer."* A single message that grows for 90 seconds gives the
 * reader no sense of what is new and moves the text under their eyes while
 * they read it.
 *
 * **The constraint that forced one message no longer binds.** The original
 * rationale was that separate MESSAGES notify the phone on every chunk — the
 * objection that kept `awaitTurnResult` discarding intermediate events at all
 * — and that only an EDIT is silent. That treated "separate message" and
 * "notification" as inseparable, and Telegram's `disable_notification` is
 * exactly what separates them. Verified live on this channel 2026-08-16 (probe
 * run `002529`, `scripts/principal-channel/verify-silent-send.ts`): a silenced
 * send raised no notification, a plain send between two silenced ones raised
 * one, so the channel was demonstrably live throughout.
 *
 * So the unit is now a **semantic block** — a run of prose between tool calls —
 * rather than a char-budget overflow. Each block is its own message; the first
 * message of a turn notifies and every later one is silenced, which keeps the
 * one-buzz-per-turn behaviour the edit-in-place design was protecting.
 *
 * Four properties this module exists to guarantee:
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
 *    Sends and edits now share that budget, where edits used to have it alone.
 * 4. **Nothing the reader has already read is taken away.** The settle may
 *    extend what is on screen; it may never replace it with something shorter.
 *    See {@link ReplyStream.finish}.
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
   * land. Used for the placeholder, for each semantic block after the first,
   * and for each message after a chunk split.
   *
   * `silent` asks the transport to deliver without raising a notification. It
   * is what makes per-block messages possible at all: without it, a turn with
   * five blocks would buzz five times. The FIRST message of a turn is never
   * silent — the principal must still learn the turn happened.
   */
  send(text: string, opts?: { silent?: boolean }): Promise<number | undefined>;
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
   * Close the current semantic block, so the next text opens a NEW message.
   *
   * Called when a tool call starts: the prose before it is a complete thought
   * and the prose after it is a new one. Same contract as {@link push} — never
   * throws, never blocks. The boundary is recorded at the accumulated length
   * SEEN NOW, so text arriving before the next flush still lands on the correct
   * side of it.
   *
   * A block with no text in it opens no message: back-to-back tool calls with
   * nothing said between them produce one boundary, not several empty ones.
   */
  sealBlock(): void;
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
  /**
   * The last message this stream successfully put text into.
   *
   * Distinct from {@link currentMessageId}, which a block seal clears: after a
   * turn that ends on a tool call there IS no current message, and reporting
   * `undefined` from `finish` would tell the caller nothing was delivered and
   * send the whole reply a second time.
   */
  let lastDeliveredId: number | undefined;
  /** What the current message was last written with, so a no-op edit is skipped entirely. */
  let lastWritten = "";
  /** Set once editing has failed in a way that makes further streaming pointless. */
  let degraded = false;
  /**
   * Accumulated-text offsets where a semantic block ends, oldest first.
   *
   * A queue rather than a single value because two tool calls can land between
   * flushes, and collapsing them would merge blocks that the reader saw as
   * separate thoughts.
   */
  const sealPoints: number[] = [];
  /** How many messages this stream has SENT — only the first may notify. */
  let sentCount = 0;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let lastFlushAt = 0;
  let finished = false;

  /** Detach from the current message, so the next write opens a new one. */
  function closeCurrentMessage(): void {
    currentMessageId = undefined;
    lastWritten = "";
  }

  /** Put `text` into the current message, opening one if needed. */
  async function write(text: string): Promise<void> {
    if (text.length === 0 || text === lastWritten) return;

    if (currentMessageId === undefined) {
      // Every message after the first is silenced. This is the whole
      // mechanism: it is what lets a turn be many messages and still cost the
      // principal exactly one notification.
      const id = await transport.send(text, sentCount === 0 ? {} : { silent: true });
      sentCount += 1;
      if (id === undefined) {
        // The message never landed. Nothing to edit into, so stop streaming;
        // `finish` falls back to an ordinary send.
        degraded = true;
        return;
      }
      currentMessageId = id;
      lastDeliveredId = id;
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
      lastDeliveredId = currentMessageId;
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
   * Write everything currently pending, closing a message at each semantic
   * block boundary and splitting into additional messages whenever one would
   * exceed the per-message budget.
   *
   * The two reasons to close a message are deliberately handled in the same
   * loop but kept distinct: a SEAL is a boundary the turn declared, and a
   * SPLIT is one the char budget forced. Only the first is a block.
   *
   * **`paced` is invariant 3 (SC4), and it is new pressure.** Under
   * edit-in-place a flush produced ONE write, so the throttle alone kept the
   * cadence legal. Now a flush can find several blocks waiting and would emit a
   * SEND for each, back to back, inside one window — and a send is far more
   * likely than an edit to count against Telegram's ~1/sec ceiling. So a paced
   * pass opens at most one NEW message and re-arms for the rest, which spreads
   * queued blocks across throttle windows instead of bursting them.
   *
   * `finish` drains UNPACED: invariant 2 outranks invariant 3, and deferring
   * there would mean returning from a settle with text still undelivered.
   */
  async function drain(paced = false): Promise<void> {
    if (degraded) return;

    let opened = 0;

    // Loop rather than split once: a burst can push past the budget by more
    // than one message's worth between flushes, and several blocks can be
    // waiting at the same time.
    for (;;) {
      // A boundary at or behind what is already committed describes an empty
      // block — a tool call with nothing said since the last one. Drop it
      // rather than opening a message for it.
      while (sealPoints.length > 0 && (sealPoints[0] ?? 0) <= offset) sealPoints.shift();

      const blockEnd = sealPoints[0] ?? pending.length;
      const remainder = pending.slice(offset, blockEnd);

      // About to open a NEW message, and this pass already opened one: hand the
      // rest to the next window rather than sending twice in a row.
      if (paced && opened > 0 && currentMessageId === undefined && remainder.length > 0) {
        schedule();
        return;
      }
      if (currentMessageId === undefined && remainder.length > 0) opened += 1;

      if (remainder.length > maxChars) {
        const cut = findChunkBreak(remainder, maxChars);
        await write(remainder.slice(0, cut));
        if (degraded) return;
        offset += cut;
        closeCurrentMessage();
        continue;
      }

      await write(remainder);
      if (degraded) return;

      // Nothing declared a boundary here, so the message stays open for the
      // next chunk of the same block.
      if (sealPoints.length === 0) return;

      offset = sealPoints.shift() ?? offset;
      closeCurrentMessage();
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
      inFlight = inFlight
        .then(() => drain(true))
        .catch((err: unknown) => {
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

    sealBlock(): void {
      if (finished || degraded) return;
      // Record the boundary at the length seen NOW. Deferring it to flush time
      // would put text that arrived after the tool call into the block before
      // it — the reader would see the next thought appended to the previous
      // message and then a new message start mid-sentence.
      const at = pending.length;
      if ((sealPoints[sealPoints.length - 1] ?? -1) === at) return;
      sealPoints.push(at);
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

      // FLUSH WHAT THE STREAM STILL OWES, FIRST.
      //
      // The settle below reasons about "what is on screen", and pacing means
      // that is not the same as "what was streamed": a paced flush defers
      // queued blocks to the next window, and `finished` above just cancelled
      // that window. Reasoning about the settle before this ran would compare
      // the resolved text against text the reader never received, and the
      // append branch — which advances `offset` to `pending.length` — would
      // then skip straight past it. Unpaced, because invariant 2 (delivery
      // never regresses) outranks invariant 3 (cadence).
      await drain();
      if (degraded) return undefined;

      // THE SETTLE MAY ONLY ADD (SC5; the principal's second report, mt#3711
      // R2: *"when you were done you overwrote everything you previously wrote
      // and the message shrank back down"*).
      //
      // The resolved text is authoritative and can differ from what streamed —
      // a turn with tool-use rounds streams interstitial prose around each
      // round while `result` carries only the final answer. The old behaviour
      // was to overwrite the open message with it, which on exactly those
      // turns made the message visibly collapse and took back text the
      // principal had already read. Content already in the chat is not a
      // draft; it is something they have seen.
      //
      // So: extend when the resolved text extends what streamed, do nothing
      // when it is already on screen, and otherwise deliver it as a NEW
      // message rather than in place of anything.
      // BOTH COMPARISONS BELOW ARE AGAINST `pending`, NEVER AGAINST `offset`
      // (mt#4240). The `drain` above has just written everything `pending`
      // holds, so at this point the chat shows exactly `pending`: the closed
      // messages carry `[0, offset)` and the open one carries the rest. That
      // makes `pending` the record of what was DELIVERED, and `offset` only
      // the record of where messages were CUT.
      //
      // Reasoning about delivery from `offset` conflated the two, and was
      // wrong in exactly the cases where a message had just been closed.
      // `pending.slice(offset)` is EMPTY when a block seal ended the turn, and
      // it is only the trailing CHUNK when a long answer was split across
      // messages. Both left the already-on-screen check unable to see text
      // that was plainly on screen, so the settle fell through to the
      // new-message branch and sent the whole answer a second time — the
      // principal's report of the channel answering twice with identical text,
      // on 12 of 41 measured turns.
      //
      // Compared with trailing whitespace trimmed on both sides. The deltas
      // and the resolved text come from different fields of the same turn and
      // drift by a trailing newline often enough that an exact compare would
      // re-open the duplicate path for the most ordinary reason there is.
      const delivered = pending.trimEnd();
      const resolved = finalText.trimEnd();

      // EXTENDS what streamed — deliver only the part they have not seen.
      //
      // APPENDS to `pending`; never ASSIGNS over it (PR #3091 R1 BLOCKING).
      // Assigning `pending = finalText` looks equivalent and is not, because
      // the guard above compares TRIMMED copies: when the two differ only by
      // trailing whitespace the branch still fires, and the assignment then
      // hands `drain` a value SHORTER than what is on screen, which edits the
      // message down and takes back a character the reader was given. That is
      // invariant 4 — the one this whole settle exists to protect — broken by
      // the fix for invariant 2.
      //
      // Appending the delta makes the branch structurally unable to shrink
      // rather than merely unlikely to: `pending` only ever grows here, so the
      // equal-after-trim case computes an empty delta and `write` short-circuits
      // on `text === lastWritten` with no edit issued at all. A length guard
      // would fix the reported case; this fixes the class.
      if (resolved.startsWith(delivered)) {
        pending += resolved.slice(delivered.length);
        await drain();
        return degraded ? undefined : (currentMessageId ?? lastDeliveredId);
      }

      // ALREADY READ — the deltas carried it, so leave every message as it
      // stands.
      //
      // Anchored at the END rather than searched for anywhere in `pending`,
      // which keeps PR #3039's protection intact: a short resolved answer —
      // "Done.", "Yes." — can appear in some earlier block by coincidence, and
      // a bare `includes` would suppress the final answer entirely on the
      // reasoning that the reader "has seen it". `endsWith` cannot make that
      // mistake, because the final answer is the LAST thing streamed or it was
      // never delivered at all; a coincidental earlier occurrence never matches.
      //
      // So PR #3039 narrowed the right check on the wrong axis. WHERE the text
      // sits is what separates the two failure directions; WHICH MESSAGE it
      // happened to land in never did, and scoping by message is what made the
      // check blind to a closed one.
      if (delivered.endsWith(resolved)) return lastDeliveredId;

      // Genuinely new text that does not continue what is on screen: the
      // timeout notice, the mid-turn-swap notice, or a `result` that diverged.
      // It belongs in the chat, and it belongs in its OWN message.
      closeCurrentMessage();
      offset = pending.length;
      pending += finalText;
      await drain();
      return degraded ? undefined : (currentMessageId ?? lastDeliveredId);
    },
  };
}
