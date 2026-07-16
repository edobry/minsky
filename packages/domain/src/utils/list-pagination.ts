/**
 * Shared truncation-metadata helpers for list-returning tools (mt#2817).
 *
 * Problem: several list-returning MCP tools (`tasks_list`, `memory_list`, and
 * others) either applied a silent cap (results quietly dropped past some
 * limit with no signal in the payload) or had no cap at all (results grew
 * unbounded, which is its own hazard — see mt#2783/mt#2817 context: a
 * `tasks_list` call in a large store returned a truncated set with nothing in
 * the payload to say so, and the caller almost made a wrong bulk decision on
 * the incomplete set).
 *
 * The fix is "loud caps": every list tool applies a bounded default (so
 * results never grow unbounded) AND always reports whether the result was
 * capped, via a `{returned, total, truncated}` triple. `total` is the true
 * count of matching rows BEFORE any cap is applied; `returned` is the number
 * actually sent back; `truncated` is `returned < total`.
 *
 * Adopters: `tasks.list` (packages/domain/src/tasks.ts), `memory.list`
 * (src/adapters/shared/commands/memory/index.ts). Other list tools
 * (`asks.list`, `events.list`) already compute an equivalent `total` and only
 * needed the `truncated` flag added — see mt#2817 PR body for the audit
 * sweep of tools that were NOT touched (and why).
 */

/** Default cap applied when no explicit limit is requested. */
export const DEFAULT_LIST_CAP = 500;

export interface ListTruncationMetadata {
  /** Number of items actually returned in this payload. */
  returned: number;
  /** True count of matching items before any cap was applied. */
  total: number;
  /** `returned < total` — true when the payload does NOT contain every match. */
  truncated: boolean;
}

/**
 * Compute the `{returned, total, truncated}` triple for a list response.
 */
export function computeListTruncation(total: number, returned: number): ListTruncationMetadata {
  return { returned, total, truncated: returned < total };
}

/**
 * Apply a cap to an already-fetched array, defaulting to `DEFAULT_LIST_CAP`
 * when the caller did not request an explicit limit. `total` in the returned
 * metadata reflects `items.length` BEFORE slicing (i.e., the true count of
 * everything the caller's filters matched).
 */
export function applyListCap<T>(
  items: T[],
  requestedLimit?: number
): { items: T[]; meta: ListTruncationMetadata } {
  const total = items.length;
  const effectiveLimit =
    typeof requestedLimit === "number" && requestedLimit > 0 ? requestedLimit : DEFAULT_LIST_CAP;
  const truncated = total > effectiveLimit;
  const sliced = truncated ? items.slice(0, effectiveLimit) : items;
  return { items: sliced, meta: computeListTruncation(total, sliced.length) };
}
