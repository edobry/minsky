#!/usr/bin/env bun
// Pure text transform for the terminal deeplink linkifier (mt#2565).
//
// Everything here is `(text, state) -> (text, state)` with no fs, no clock, no
// env — the functional-core / imperative-shell split ADR-036 prescribes. The
// shell (`linkify-message-display.ts`) reads stdin, carries the fence state
// across deltas, and writes the hook envelope.
//
// WHAT IS REWRITTEN
//   `mt#NNNN` -> [mt#NNNN](minsky://task/mt%23NNNN)
//   `PR #N`   -> [PR #N](minsky://changeset/N)
//
// Both targets are DERIVABLE from the visible label by pure string transform,
// which is the whole reason they are the v1 scope. `mem#N` / `ask#N` / `ws#N`
// are deliberately absent: ADR-029 makes the full UUID the sole deeplink target
// for those types, so linkifying one requires resolving a short id against an
// id-set — an IO this hook cannot afford (see the header of the shell for the
// per-delta cost model). A bare short id therefore stays bare, which is exactly
// today's behavior, not a regression.
//
// WHAT IS LEFT ALONE
//   - anything inside a fenced code block, including a fence that OPENED in an
//     earlier delta (the reason this module is stateful at all)
//   - inline code spans, blockquote lines, existing markdown links, and URLs
//   - a trailing partial line, unless the message is ending (`final`), so a ref
//     split across two deltas can never be rewritten from half a match
//
// The degradation direction is always "leave it bare": a ref this module
// declines to touch renders exactly as the model wrote it.
//
// @see .minsky/hooks/linkify-message-display.ts — the imperative shell
// @see src/cockpit/web/lib/entity-codec.ts — the shared codec (no second one)
// @see mt#2565 — this task; mt#3459 — the decision this implements

import { entityToMinskyUri } from "../../src/cockpit/web/lib/entity-codec";

/** Cross-delta state: the only thing a delta cannot determine on its own. */
export interface FenceState {
  inFence: boolean;
}

export interface LinkifyResult {
  text: string;
  state: FenceState;
}

/** A line that opens or closes a fenced code block (``` or ~~~, up to 3 spaces of indent). */
const FENCE_LINE = /^[ \t]{0,3}(?:`{3,}|~{3,})/;

/** A blockquote line — quoted text the assistant is showing, not asserting. */
const BLOCKQUOTE_LINE = /^[ \t]{0,3}>/;

/**
 * Spans whose interior must never be rewritten, matched in one alternation so a
 * single left-to-right scan can skip them:
 *   1. inline code spans
 *   2. existing inline markdown links — covers both the label and the target, so
 *      an already-linked ref is never double-linked. An image (`![alt](url)`)
 *      matches this branch too: the `!` sits outside the span and carries no ref.
 *   3. reference-style links (`[label][ref]`) and their definitions
 *      (`[ref]: target`). Rewriting a label there would emit
 *      `[[mt#N](minsky://…)][ref]`, which renders as literal brackets — a
 *      corruption rather than a missed link, which is why the branch is worth
 *      carrying even though the form is rare in assistant output (PR #2763 R1).
 *   4. angle-bracket autolinks
 *   5. bare URLs, including `minsky://` ones written without markdown
 */
const PROTECTED_SPAN =
  /`+[^`\n]*`+|\[[^\]\n]*\]\([^)\n]*\)|\[[^\]\n]*\]\[[^\]\n]*\]|^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*|<[^>\s]+>|\b[a-z][a-z0-9+.-]*:\/\/\S+/gim;

const TASK_REF = /\bmt#(\d+)\b/g;
const PR_REF = /\bPR #(\d+)\b/g;

/** Rewrite every task/PR reference in a span already known to be unprotected. */
function replaceRefs(text: string): string {
  return text
    .replace(TASK_REF, (_match, num: string) => {
      const id = `mt#${num}`;
      return `[${id}](${entityToMinskyUri("task", id)})`;
    })
    .replace(
      PR_REF,
      (_match, num: string) => `[PR #${num}](${entityToMinskyUri("changeset", num)})`
    );
}

/**
 * Rewrite one line, skipping protected spans. Every occurrence is linked, not
 * just the first: the one-link-per-entity ration mt#3459 retired was an
 * authoring economy, and at the display surface a repeat costs the reader
 * nothing.
 */
export function linkifyLine(line: string): string {
  let out = "";
  let cursor = 0;
  PROTECTED_SPAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROTECTED_SPAN.exec(line)) !== null) {
    out += replaceRefs(line.slice(cursor, match.index));
    out += match[0];
    cursor = match.index + match[0].length;
  }
  return out + replaceRefs(line.slice(cursor));
}

/**
 * Rewrite one streaming delta.
 *
 * `state` carries the fence flag from the previous delta of the SAME message;
 * pass `{ inFence: false }` at the start of a message. The returned state is
 * what the next delta of that message must receive.
 *
 * `final` marks the message's last flush, which is the only delta whose trailing
 * segment is known to be a complete line.
 */
export function linkifyDelta(
  delta: string,
  state: FenceState,
  options: { final?: boolean } = {}
): LinkifyResult {
  const segments = delta.split("\n");
  // `split` always yields one more segment than there are newlines, so the last
  // segment is the text AFTER the final newline — empty when the delta ends on
  // one, which per the hook's contract ("batches of newly completed lines") is
  // the ordinary case.
  const trailing = segments.pop() ?? "";
  let inFence = state.inFence;
  const rewritten: string[] = [];

  for (const line of segments) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      rewritten.push(line);
      continue;
    }
    if (inFence || BLOCKQUOTE_LINE.test(line)) {
      rewritten.push(line);
      continue;
    }
    rewritten.push(linkifyLine(line));
  }

  let trailingOut = trailing;
  if (trailing.length > 0 && options.final === true) {
    if (FENCE_LINE.test(trailing)) {
      inFence = !inFence;
    } else if (!inFence && !BLOCKQUOTE_LINE.test(trailing)) {
      trailingOut = linkifyLine(trailing);
    }
  }

  rewritten.push(trailingOut);
  return { text: rewritten.join("\n"), state: { inFence } };
}
