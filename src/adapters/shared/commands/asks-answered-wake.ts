/**
 * Answered-ask wake emission (mt#4476).
 *
 * When an operator answers an ask, the conversation that FILED it should learn of the
 * answer on its next tool call rather than at its next turn boundary. mt#3564 shipped
 * the turn-boundary half at the `UserPromptSubmit` seam, which fires once per prompt —
 * so an agent running for hours inside a single turn got nothing. This module is the
 * producer for the tool-call seam.
 *
 * It lives in its own file rather than in `asks.ts` for two reasons: that file is at
 * its `max-lines` ceiling, and the dependency-injected shape below is testable without
 * patching a collaborator (`testing-standards.mdc §Testable Design`) — the sink arrives
 * as a factory argument instead of being reached for through the DI container.
 */

import { log } from "@minsky/shared/logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import type { Ask } from "@minsky/domain/ask/types";
import type { WakeSignalSink } from "@minsky/domain/ask/wake-on-respond";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * Cap on the answer text carried in a wake payload.
 *
 * Capped at the WRITE, not only at the render: `buildBlock` in the wake-enrichment
 * middleware drops a payload WHOLE when it would exceed the block's character budget
 * rather than truncating it, so an oversized answer would not arrive clipped — it
 * would not arrive at all, and silently. mt#3564 shipped the mirror image of this (a
 * consumer trusting a producer's truncation and rendering 664 chars against a declared
 * 590); the lesson taken is that the cap belongs wherever a value would otherwise
 * escape a stated bound.
 */
export const MAX_WAKE_ANSWER_CHARS = 600;

/**
 * Render an `Ask.response.payload` to bounded text for a wake payload.
 *
 * The payload is typed `unknown` and really is free-form — it is NOT a
 * `{ message, chosen }` record. Same shape-agnostic treatment the cockpit's
 * ask-state cache gives it (`renderChosen` in `src/cockpit/ask-state-cache.ts`),
 * duplicated rather than imported so a shared command does not reach into
 * `src/cockpit`.
 */
export function renderAnswerForWake(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (typeof text !== "string" || text.length === 0) return "";
  // safeTruncate with an explicit "head", not slice: an operator's answer is free-form
  // prose that routinely carries emoji, and a raw slice can split a surrogate pair and
  // emit a lone half. "head" is load-bearing — safeTruncate DEFAULTS to "tail", which
  // keeps the END of the string, the opposite of what a preview needs.
  return text.length > MAX_WAKE_ANSWER_CHARS
    ? `${safeTruncate(text, MAX_WAKE_ANSWER_CHARS, "head")}…`
    : text;
}

/**
 * Write an `"ask.answered"` wake row addressed to the conversation that filed `ask`.
 *
 * Best-effort in the strong sense — never throws, never blocks the caller's result.
 * That posture is required by mt#4476 SC4 and cannot come from the sink:
 * `PersistentWakeSignalSink.emit()` deliberately RE-THROWS ("This sink is not silent:
 * persistence-side outages should be visible") and three other producers depend on
 * that, so the swallow belongs at the one call site that wants it.
 *
 * A no-op when the ask carries no `filedByAgentId` — filed from the CLI, filed before
 * mt#4476's migration, or filed by a caller whose identity fell back to ADR-006 Layer 1
 * (a process hash, which is not conversation-scoped and is deliberately never stamped).
 * Those asks are not broken; they reach their agent at mt#3564's prompt seam instead,
 * which is why that seam is complementary rather than superseded.
 *
 * @param buildSink Factory for the composite wake sink. A factory rather than a sink
 *   so the (possibly failing) sink construction is inside this function's try — a
 *   persistence provider that cannot be resolved must not propagate to `asks.respond`.
 */
export async function emitAnsweredAskWakeBestEffort(
  buildSink: () => Promise<WakeSignalSink>,
  ask: Ask
): Promise<void> {
  if (!ask.filedByAgentId) return;
  try {
    const sink = await buildSink();
    await sink.emit({
      kind: "ask.answered",
      askId: ask.id,
      agentId: ask.filedByAgentId,
      parentTaskId: ask.parentTaskId,
      // `reviewBody`/`reviewState`/`reviewAuthor`/`prNumber` are the payload's
      // review-shaped legacy fields (mt#1481). Reused rather than widened: the block
      // the middleware renders is a JSON line an agent reads, so carrying the answer
      // in `reviewBody` needs no consumer change, where a new field shape would need
      // one in every reader.
      reviewBody: renderAnswerForWake(ask.response?.payload),
      reviewState: "responded",
      reviewAuthor: ask.response?.responder ?? null,
      prNumber: 0,
    });
  } catch (err: unknown) {
    log.warn("asks.respond: answered-ask wake write failed (non-blocking)", {
      askId: ask.id,
      error: getLoggableErrorSummary(err),
    });
  }
}
