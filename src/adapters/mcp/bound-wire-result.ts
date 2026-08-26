/**
 * Bound what an MCP tool result puts on the wire (mt#4418).
 *
 * An MCP result is not read only by the caller that asked for it. When the
 * harness backgrounds a slow call it pastes the ENTIRE result into a
 * `<task-notification>` turn, so the payload lands in the operator's
 * conversation view and in the agent's context whether or not a single field of
 * it is read.
 *
 * **Measured, not assumed** (`agent_transcript_turns`, `user_origin =
 * 'task_notification'`, 2026-08-26 — every backgrounded call in the corpus):
 *
 * | tool | samples | max chars | avg |
 * | --- | --- | --- | --- |
 * | `session_pr_wait-for-review` | 437 | 34,668 | 2,232 |
 * | `session_commit` | 315 | 22,162 | 2,406 |
 * | `session_pr_create` | 35 | 12,063 | 6,297 |
 * | `session_pr_checks` | 429 | 4,860 | 3,157 |
 *
 * Everything outside the top handful is under 1.4 KB and needs nothing.
 *
 * **These are one defect, not four.** Each of those commands ends its JSON
 * branch with `return { success: true, ...result }` while its TEXT branch
 * builds a compact summary — `pr-wait-for-review-command.ts:189` against
 * `:197`, `pr-checks-command.ts:108` against `:111-131`,
 * `pr-create-command.ts:432`. A repo-wide grep finds 13 occurrences of that
 * idiom. mt#4417 fixed one instance by hand inside one command; this module is
 * the reason the next twelve do not need the same patch, and it sits at
 * `shared-command-integration.ts`'s single return — the one place EVERY MCP
 * result passes through.
 *
 * @see packages/domain/src/utils/list-pagination.ts — mt#2817's convention, reused rather than reinvented
 */

import { computeListTruncation } from "@minsky/domain/utils/list-pagination";

/**
 * Below this, an echoed string is not worth eliding.
 *
 * Grounded in the corpus rather than rounded: the values worth removing are
 * bodies — a commit message (~2,000 chars) or a PR body (~6,000) — while the
 * scalars a caller sends and usefully reads back are ids and branch names under
 * ~40 chars. This repo's commit SUBJECT alone runs ~80, so a body only begins
 * somewhere past it. 200 sits in the empty space between the two populations.
 */
export const ECHO_ELISION_MIN_CHARS = 200;

/**
 * Serialized size above which arrays start getting capped.
 *
 * Echo elision runs unconditionally because it cannot lose anything (see
 * {@link boundWireResult}); capping an array CAN, so it is gated on the result
 * actually being large. 8 KB clears `session_pr_checks`'s measured maximum
 * (4,860) so ordinary CI polling is never touched, and sits below
 * `session_pr_create`'s (12,063) and `session_pr_wait-for-review`'s (34,668),
 * which are the payloads this exists for.
 */
export const ARRAY_BOUNDING_BUDGET_BYTES = 8 * 1024;

/** Elements kept when an array is capped. Matches mt#4417's `MAX_WIRE_FILES`. */
export const MAX_WIRE_ARRAY = 50;

/** How deep to walk. `review.findings` is at depth 2; nothing observed is deeper. */
const MAX_DEPTH = 4;

export type EchoOmissionReason = "echoed-caller-input";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every string the caller sent that is long enough to be worth eliding.
 *
 * A Set of VALUES rather than a field-name map on purpose: a result routinely
 * names a field differently from the param it echoes (`session_pr_create` takes
 * `body` and returns it inside the PR object), so matching on the value is what
 * catches the class. Byte-identity is the whole test — anything the command
 * transformed, truncated or re-wrapped is no longer the caller's string and is
 * kept.
 */
function elidableCallerStrings(params: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const value of Object.values(params)) {
    if (typeof value === "string" && value.length >= ECHO_ELISION_MIN_CHARS) {
      out.add(value);
    }
  }
  return out;
}

/**
 * Shape one MCP result for the wire.
 *
 * Two passes, deliberately asymmetric in when they run:
 *
 * 1. **Echo elision — always.** A field byte-identical to a string the caller
 *    just sent is dropped and replaced by a `<field>Omitted` marker. This can
 *    never cost the caller information: it supplied those exact bytes. It is
 *    mt#4417's rule, generalised from one hand-coded field to every tool.
 * 2. **Array capping — only over budget.** Truncating an array DOES lose
 *    information, so it runs only once the result is genuinely large, and it
 *    reports the loss through mt#2817's `{returned, total, truncated}` triple
 *    rather than silently. Loud caps, per that task's own principle.
 *
 * Returns `result` unchanged — same reference — when neither pass has anything
 * to do, which is the overwhelmingly common case.
 */
export function boundWireResult(result: unknown, params: Record<string, unknown>): unknown {
  if (!isPlainObject(result)) return result;

  const elidable = elidableCallerStrings(params);
  const afterEcho = elideEchoes(result, elidable, 0);

  // Size is measured AFTER elision: removing an echoed 6 KB body can drop a
  // result under budget on its own, and then no array needs capping at all.
  if (serializedSize(afterEcho) <= ARRAY_BOUNDING_BUDGET_BYTES) return afterEcho;

  return capArrays(afterEcho, 0);
}

function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // A circular or non-serializable result cannot reach an MCP client anyway;
    // treat it as over budget so the array pass still bounds what it can.
    return Number.POSITIVE_INFINITY;
  }
}

function elideEchoes(
  node: Record<string, unknown>,
  elidable: Set<string>,
  depth: number
): Record<string, unknown> {
  if (depth >= MAX_DEPTH || elidable.size === 0) return node;

  let changed = false;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" && elidable.has(value)) {
      out[`${key}Omitted`] = "echoed-caller-input" satisfies EchoOmissionReason;
      changed = true;
      continue;
    }
    if (isPlainObject(value)) {
      const nested = elideEchoes(value, elidable, depth + 1);
      if (nested !== value) changed = true;
      out[key] = nested;
      continue;
    }
    out[key] = value;
  }

  return changed ? out : node;
}

/**
 * Has this object already bounded itself?
 *
 * mt#2817's list tools apply their OWN cap (`DEFAULT_LIST_CAP`, 500) and report
 * it with a `truncated` flag, because for them the array IS the answer the
 * caller asked for. Capping such a result to {@link MAX_WIRE_ARRAY} here would
 * defeat the tool — a `tasks_list` of 500 rows is over budget by size and is
 * exactly what the caller requested. The convention's own marker is the
 * discriminator: a node carrying `truncated` has already made this decision,
 * and is left alone.
 */
function isSelfBounded(node: Record<string, unknown>): boolean {
  return "truncated" in node;
}

function capArrays(node: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth >= MAX_DEPTH || isSelfBounded(node)) return node;

  let changed = false;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value) && value.length > MAX_WIRE_ARRAY) {
      const kept = value.slice(0, MAX_WIRE_ARRAY);
      out[key] = kept;
      out[`${key}Truncation`] = computeListTruncation(value.length, kept.length);
      changed = true;
      continue;
    }
    if (isPlainObject(value)) {
      const nested = capArrays(value, depth + 1);
      if (nested !== value) changed = true;
      out[key] = nested;
      continue;
    }
    out[key] = value;
  }

  return changed ? out : node;
}
