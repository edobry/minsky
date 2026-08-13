/**
 * Deciding which harness-transcript turns are missing from an entity thread
 * (mt#4073).
 *
 * ## What this exists to stop
 *
 * `createEntityThreadReplyRecorder` writes each agent reply to
 * `entity_thread_turns` as it streams; when that write fails the reply goes to
 * the in-memory buffer in `src/cockpit/entity-thread-reply-buffer.ts`. A daemon
 * restart drops that buffer, and because the GET route omits `pendingReplies`
 * when the buffer is empty, the notice vanishes at the same moment. The
 * operator is left with a thread that has a gap in it and nothing saying so.
 *
 * The reply is not actually gone. The same driven session's output is ALSO
 * ingested into `agent_transcript_turns` by the cockpit's transcript-watcher,
 * which tails a JSONL file the daemon does not write — so it survives the
 * restart that loses the buffer. This module decides which of those transcript
 * turns the thread is missing, so they can be appended back.
 *
 * ## Why the comparison is not string equality
 *
 * The two paths normalize the same model output differently, and this is
 * measured rather than assumed:
 *
 * - The recorder joins one event's text blocks with `""`
 *   (`extractAssistantTextFromEvent`, `src/cockpit/entity-thread-launch.ts`).
 * - The transcript extractor joins with `"\n"` (`extractAssistantText`,
 *   ./turn-extractor.ts).
 * - The transcript accumulates consecutive assistant lines sharing a
 *   `message.id` into ONE row (mt#3883), where the recorder writes one turn per
 *   EVENT.
 *
 * So one transcript turn can correspond to N stored turns, with different
 * whitespace. Equality would miss a reply that in fact landed and re-append it
 * — reintroducing the duplicate-turn hazard through the fix for it, since
 * `appendEntityThreadTurn` allocates `seq` as `MAX(seq)+1` and is not
 * idempotent. Hence containment over normalized text.
 *
 * @see mt#4073 — this module
 * @see ../storage/schemas/entity-threads-schema.ts — the recovered-turn columns
 * @see src/cockpit/entity-thread-transcript-reconciler.ts — the IO half
 */

/**
 * Tolerance when deciding whether a transcript turn predates the thread's
 * window.
 *
 * Mirrors `CLOCK_SKEW_TOLERANCE_MS` in the reply buffer, and for the same
 * reason: the daemon's clock stamps one side and Postgres's clock the other, so
 * this only has to beat skew between the two, never resolve a close call.
 */
export const RECONCILE_SKEW_TOLERANCE_MS = 30_000;

/** An agent turn already stored on the thread. */
export interface StoredThreadTurn {
  content: string;
  createdAtMs: number;
}

/** One ingested assistant turn from the thread's harness conversation. */
export interface TranscriptAssistantTurn {
  conversationId: string;
  turnIndex: number;
  text: string;
  /** When the model finished the turn, per the ingested transcript. */
  endedAtMs: number;
}

export interface SelectRecoverableTurnsInput {
  /** Agent turns already on the thread. */
  storedAgentTurns: StoredThreadTurn[];
  /** Candidate turns from the thread's conversation(s), any order. */
  transcriptTurns: TranscriptAssistantTurn[];
  /**
   * When the thread's own history begins — the earliest turn of ANY role.
   * Used as the window anchor when the thread has no agent turn yet; see
   * {@link selectRecoverableTurns}.
   */
  threadStartedAtMs?: number;
  skewToleranceMs?: number;
}

/**
 * Collapse the differences the two write paths introduce, and nothing else.
 *
 * Whitespace runs become a single space and the ends are trimmed, so `""`-joined
 * and `"\n"`-joined renderings of the same blocks compare equal. Case and
 * punctuation are left alone: this is a defect-tolerance normalization, not a
 * fuzzy match, and two replies differing only in case are genuinely different
 * replies.
 */
export function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Is this transcript turn already represented among the thread's stored turns?
 *
 * CONTAINMENT, not equality, and deliberately asymmetric: a stored turn counts
 * as accounting for the transcript turn when the stored content appears WITHIN
 * it. That is the direction the split produces — the transcript merges what the
 * recorder wrote separately, so each stored turn is a segment of the merged row,
 * never the other way around.
 *
 * **Under-recovers rather than duplicates, on purpose.** When the recorder wrote
 * two turns for one model message and only ONE of them landed, a single match
 * makes the whole transcript turn look accounted for, and the missing half is
 * not recovered. The alternative — appending the merged row because part of it
 * is absent — would put the landed half on screen twice. Criterion 3 is a hard
 * "never append a reply that already landed"; a missed partial is a gap the
 * operator is still TOLD about (criterion 2), while a duplicate turn is silent
 * corruption of the record. So the tie goes to under-recovering.
 *
 * An empty stored turn matches nothing: `"".includes()` is true of every string,
 * which would suppress every recovery on a single blank row.
 */
export function isTranscriptTurnStored(
  transcriptText: string,
  storedAgentTurns: StoredThreadTurn[]
): boolean {
  const haystack = normalizeForMatch(transcriptText);
  if (haystack.length === 0) return true;
  return storedAgentTurns.some((stored) => {
    const needle = normalizeForMatch(stored.content);
    if (needle.length === 0) return false;
    return haystack.includes(needle);
  });
}

/**
 * The turns this thread is missing, oldest first.
 *
 * Two independent filters, and BOTH are load-bearing:
 *
 * 1. **The window.** Only turns after the thread's anchor are eligible. Without
 *    it the reconciler would backfill a conversation's entire assistant history
 *    into the thread — including turns produced before the recorder was ever
 *    registered, which were never thread replies. This is the over-recovery
 *    hazard, the exact mirror of the duplicate hazard filter 2 guards.
 *
 *    The anchor is the newest stored AGENT turn, because everything at or before
 *    it demonstrably reached the table. A thread with no agent turn yet has no
 *    such evidence, so it falls back to when the thread's own history begins
 *    ({@link SelectRecoverableTurnsInput.threadStartedAtMs}) — an assistant turn
 *    predating the thread cannot be a reply to it. With NEITHER anchor available
 *    there is nothing bounding the conversation's history against this thread's,
 *    so nothing is eligible: recovering into an unbounded window is the failure
 *    this filter exists to prevent, and refusing is the safe direction.
 *
 * 2. **Containment** — see {@link isTranscriptTurnStored}.
 *
 * Ordering is by `endedAtMs`, so replies are appended in the order the agent
 * actually produced them.
 *
 * **Not by `(conversationId, turnIndex)`** — that was the first cut and it is
 * wrong across a conversation swap (PR #2971 R1). Conversation ids are UUIDs, so
 * comparing them orders by an arbitrary string: the REPLACED conversation holds
 * the chronologically EARLIER replies, and whether they sort before or after the
 * current conversation's depends on how two random UUIDs happen to compare.
 * `turnIndex` is only meaningful WITHIN one conversation and cannot order across
 * two. Time is the only key that is comparable across both, which is exactly the
 * multi-conversation case the swap column exists to support.
 */
export function selectRecoverableTurns(
  input: SelectRecoverableTurnsInput
): TranscriptAssistantTurn[] {
  const skew = input.skewToleranceMs ?? RECONCILE_SKEW_TOLERANCE_MS;

  const newestStoredAgentMs = input.storedAgentTurns.reduce<number | null>(
    (newest, turn) => (newest === null || turn.createdAtMs > newest ? turn.createdAtMs : newest),
    null
  );
  const anchorMs = newestStoredAgentMs ?? input.threadStartedAtMs ?? null;
  if (anchorMs === null) return [];

  const eligible = input.transcriptTurns.filter((turn) => turn.endedAtMs > anchorMs - skew);

  return eligible
    .filter((turn) => !isTranscriptTurnStored(turn.text, input.storedAgentTurns))
    .sort((a, b) =>
      // `turnIndex` breaks ties only within one conversation, where it is the
      // authoritative order; across conversations it is meaningless, so it is
      // reached only when two turns share an instant.
      a.endedAtMs === b.endedAtMs
        ? a.conversationId === b.conversationId
          ? a.turnIndex - b.turnIndex
          : 0
        : a.endedAtMs - b.endedAtMs
    );
}
