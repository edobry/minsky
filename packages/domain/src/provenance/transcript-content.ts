/**
 * Content resolution for a stored `TranscriptMessage` — the single accessor for
 * "what text does this message actually carry?".
 *
 * ## Why this module exists
 *
 * A stored transcript row holds the raw harness JSONL line verbatim:
 * `{ type, message: { role, content }, timestamp, uuid, ... }`. The text lives at
 * `message.content`. But `TranscriptMessage` (the seam's TS type) declares a FLAT
 * `content` field, which describes the pre-extracted shape the transitional
 * `AgentTranscriptService.ingestTranscript` writes — a shape with zero live rows.
 *
 * Reading `msg.content` on a live row therefore yields `undefined`, silently, with no
 * type error. Three consumers did exactly that:
 *
 * - `detectors/unasked-direction-analyzer.ts` — 496 of 496 recorded runs produced no
 *   findings because every message rendered as the non-text marker (mt#4196, this
 *   module's origin).
 * - `provenance/authorship-judge.ts` — same shape, and its verdicts are CONSUMED on the
 *   session-merge path rather than logged (mt#4225).
 * - `provenance/transcript-service.ts` `countCorrections` — reached from
 *   `computeMessageStats`, so `MessageStats.corrections` is structurally 0 for stored
 *   transcripts (mt#4225).
 *
 * A fourth consumer, `transcripts/event-adapter.ts`, DISCOVERED this during mt#3157 and
 * fixed it — in a module-private helper, so the other three kept reading the wrong field.
 * That is the actual defect this module closes: the fix existed and could not be reached.
 * The resolver below is that helper, hoisted verbatim in behavior and imported by
 * `event-adapter.ts` rather than duplicated.
 *
 * ## Deliberately one function behind one seam
 *
 * mt#2580 (ADR-025 endgame) will re-point every reader OFF the PG `transcript` blob and
 * drop the column. When it does, one shared resolver is a single site to re-point; four
 * inlined copies would not be. Keep it that way.
 *
 * @see mt#4196 — the analyzer defect that surfaced this
 * @see mt#4225 — the two remaining blind consumers
 * @see mt#3157 — where the live shape was first verified against real rows
 */

import type { TranscriptMessage } from "./transcript-service";

/**
 * Rendered in place of a message carrying no extractable text.
 *
 * Exported because it is the BLINDNESS SIGNATURE: a transcript rendering as mostly this
 * string is the shape of a broken read, not of a quiet session. `nonTextRatio` below is
 * what makes that signature observable rather than something a reader must notice.
 */
export const NON_TEXT_MARKER = "[non-text content]";

/**
 * Resolve a message's actual content payload, nested shape first.
 *
 * Reads `message.content` (the live stored shape) when it actually CARRIES a value, and
 * falls back to the flat `.content` field (the seam's declared type, this repo's older
 * fixtures, and any restored legacy archive) otherwise. Order matters: a row carrying BOTH
 * should be read as the harness wrote it.
 *
 * "Carries a value" rather than "has the key": a nested `content` that is `undefined` or
 * `null` yields nothing to read, so treating its mere presence as authoritative would
 * suppress the fallback and return nothing from a message that had text one field over.
 */
export function resolveTranscriptMessageContent(msg: TranscriptMessage): unknown {
  const nested = msg.message;
  if (nested !== null && typeof nested === "object") {
    const nestedContent = nested.content;
    // Gate on the VALUE, not on key existence. `"content" in nested` is true for
    // `{ content: undefined }`, which would return undefined and skip the flat fallback —
    // in the one function whose job is to try both shapes. Carried over from the helper
    // this was hoisted from (mt#3157); caught in review on PR #3085.
    if (nestedContent !== undefined && nestedContent !== null) return nestedContent;
  }
  return msg.content;
}

/**
 * Extract prompt-renderable text from a resolved content payload.
 *
 * Returns `null` — not `""` — when the payload is neither a string nor a block array, so
 * callers can distinguish "this message has no text" from "this message's text is empty".
 * Collapsing those two is what makes a blind read indistinguishable from a quiet session.
 */
export function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((block) => block?.type === "text")
      .map((block) => block?.text ?? "")
      .join(" ");
  }
  return null;
}

/** A message's resolved text, plus whether it fell back to the marker. */
export interface ResolvedMessageText {
  /** The extracted text, or `NON_TEXT_MARKER` when nothing was extractable. */
  text: string;
  /** True when `text` is the marker rather than real content. */
  isNonText: boolean;
}

/**
 * Resolve one message to renderable text.
 *
 * The `isNonText` flag is the point of returning a struct rather than a string: it lets a
 * caller count fallbacks without re-deriving them by string-comparing against the marker,
 * which would also match a message whose real text happens to be that literal.
 */
export function resolveMessageText(msg: TranscriptMessage): ResolvedMessageText {
  const extracted = extractTextFromContent(resolveTranscriptMessageContent(msg));
  if (extracted === null) return { text: NON_TEXT_MARKER, isNonText: true };
  return { text: extracted, isNonText: false };
}

/**
 * Fraction of messages that resolve to no text at all (0 for an empty input).
 *
 * This is the measurement the analyzer's 496 blind runs could not make about themselves.
 */
export function nonTextRatio(messages: readonly TranscriptMessage[]): number {
  if (messages.length === 0) return 0;
  const nonText = messages.reduce((n, msg) => (resolveMessageText(msg).isNonText ? n + 1 : n), 0);
  return nonText / messages.length;
}

/**
 * Above this fraction, a rendering is treated as blind rather than quiet.
 *
 * 0.9 rather than 1.0 deliberately: the failure this catches renders 100% of messages as
 * the marker, and a threshold set at exactly 1.0 would be defeated by a single legitimately
 * text-bearing message in an otherwise blind transcript.
 */
export const BLINDNESS_RATIO_THRESHOLD = 0.9;

/** Verdict on whether a transcript rendering carries information at all. */
export interface BlindRenderingVerdict {
  /** Fraction of messages that resolved to the marker. */
  ratio: number;
  /** True when `ratio` exceeds `BLINDNESS_RATIO_THRESHOLD` over a non-empty transcript. */
  blind: boolean;
  /** Messages considered. */
  messageCount: number;
}

/**
 * Judge whether a rendered transcript is blind.
 *
 * An EMPTY transcript is never blind — there is nothing to fail to read, and reporting it
 * as blind would fire this check on every legitimately empty session.
 */
export function detectBlindRendering(
  messages: readonly TranscriptMessage[]
): BlindRenderingVerdict {
  const ratio = nonTextRatio(messages);
  return {
    ratio,
    blind: messages.length > 0 && ratio > BLINDNESS_RATIO_THRESHOLD,
    messageCount: messages.length,
  };
}
