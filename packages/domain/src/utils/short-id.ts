/**
 * Generic numeric short-id minting (`<prefix>#<n>`) — mt#2963.
 *
 * Generalizes the `mt#NNNN` monotonic-counter-over-tombstones pattern
 * (`computeNextTaskId`, `packages/domain/src/tasks/minskyTaskBackend.ts:73`,
 * mt#2205) to any entity prefix (`ask#`, `mem#`, `ws#`, ...). Consumed by the
 * per-entity foundation tasks (mt#2965 ask, mt#2966 memory, mt#2967 session)
 * to mint a human-readable short id ADDED ALONGSIDE each entity's canonical
 * UUID primary key — never replacing it. See ADR-029 for the full decision
 * record and `docs/architecture/adr-029-numeric-short-ids-foundation.md`'s
 * rejected alternatives (replace-PK, random base58/62).
 *
 * ## Scoping — global, not per-project (single choice-point)
 *
 * The counter is a GLOBAL sequence per entity-type prefix — mirroring the
 * existing global `mt#N` task counter — NOT scoped per project. This is the
 * settled working decision from mt#2391 (Phase 1 project scoping keeps
 * global `mt#N`, using `project_id` for filtering only) and mt#2390
 * (deliberately defers the global-vs-per-project numbering question; global
 * is the no-regret, no-migration default).
 *
 * `nextShortId` takes `liveIds` / `tombstoneIds` as flat arrays with NO
 * project dimension — the caller is responsible for querying ALL rows for
 * the given prefix, across every project, when building those arrays. This
 * function's signature IS the single localized choice-point for scoping: if
 * a future per-project switch is ever adopted (mt#2390), only the caller's
 * query (which rows get passed in) changes — this function's contract does
 * not need to change, and every per-entity minting callsite that goes
 * through it inherits the switch for free.
 *
 * ## Tombstone-awareness
 *
 * The next id is `<prefix>#<max + 1>`, where `max` is taken over BOTH live
 * ids AND a per-entity tombstone set (ids of deleted rows). Including
 * tombstones is what makes allocation monotonic: deleting the
 * highest-numbered row never lowers the max, so a freed id is never
 * reissued to a new row. This mirrors `computeNextTaskId`'s
 * `deleted_task_ids` tombstone table (mt#2205); each per-entity task is
 * expected to add an analogous tombstone mechanism before wiring
 * minting-on-create for its entity.
 *
 * ## Concurrency
 *
 * `nextShortId` is a pure function (no I/O) — it does not itself guarantee
 * uniqueness under concurrent callers proposing an id from the same stale
 * snapshot. The established Minsky pattern (mirrored from
 * `MinskyTaskBackend.createTaskFromTitleAndSpec` / `tryInsertTask`) is:
 * propose an id via this function, attempt the INSERT with
 * `onConflictDoNothing()` against a UNIQUE INDEX on the `short_id` column
 * (see `short-id-column.ts`), and retry (re-propose + re-insert) on
 * collision, bounded to a small number of attempts (5, matching the task
 * backend). A TOCTOU race between the max-id read and the INSERT is
 * possible but self-heals via retry — exactly as it does for `mt#NNNN`
 * today. A DB advisory lock was considered and rejected: it would be new
 * infrastructure duplicating a pattern already proven correct for a
 * low-contention path (entity creation is not a hot loop).
 */

/** A `<prefix>#<n>` short-id token, e.g. "ask#7" -> { prefix: "ask", n: 7 }. */
const SHORT_ID_RE = /^([a-zA-Z][a-zA-Z0-9]*)#(\d+)$/;

/**
 * Normalize a short-id PREFIX (trim + lowercase) — the SINGLE choke point
 * every short-id format/parse/mint/resolve site must route a prefix
 * through (PR #2099 R1). Prefix casing must never be able to diverge
 * between mint time and resolve time: without this, `ask#7` minted via
 * `nextShortId("ask", ...)` and a caller later supplying `"Ask#7"` (or
 * minting via `nextShortId("Ask", ...)`) could silently allocate/resolve
 * to DIFFERENT tokens. Every function below that touches a prefix —
 * `formatShortId`, `parseShortId`, `nextShortId` — calls this, and so does
 * `id-prefix-resolver.ts`'s short-id classification/comparison path, so
 * there is exactly one place casing rules live.
 */
export function normalizeShortIdPrefix(prefix: string): string {
  return prefix.trim().toLowerCase();
}

/** Format a prefix + number as a short-id token, e.g. `formatShortId("ask", 7)` -> `"ask#7"`.
 * The prefix is normalized (see `normalizeShortIdPrefix`) — `formatShortId("Ask", 7)` and
 * `formatShortId("ASK", 7)` both produce `"ask#7"`. */
export function formatShortId(prefix: string, n: number): string {
  return `${normalizeShortIdPrefix(prefix)}#${n}`;
}

export interface ParsedShortId {
  /** The prefix segment, normalized via `normalizeShortIdPrefix` (trimmed + lowercased). */
  prefix: string;
  /** The numeric segment, parsed as a positive integer. */
  n: number;
}

/**
 * Parse a `<prefix>#<n>` short-id token.
 *
 * Returns `null` for anything that doesn't match the shape exactly —
 * empty/whitespace input, a missing `#`, a non-numeric or non-positive
 * suffix, or trailing garbage after the digits (e.g. "mt#5abc"). Callers
 * that need a thrown error on invalid input should check for `null` and
 * raise their own — this function never throws.
 *
 * The returned `prefix` is normalized via `normalizeShortIdPrefix`, so
 * `parseShortId("Ask#7")`, `parseShortId("ASK#7")`, and
 * `parseShortId("ask#7")` all return `{ prefix: "ask", n: 7 }`.
 */
export function parseShortId(input: string): ParsedShortId | null {
  const trimmed = (input ?? "").trim();
  const match = SHORT_ID_RE.exec(trimmed);
  if (!match) return null;
  const prefix = match[1];
  const numStr = match[2];
  if (!prefix || !numStr) return null;
  const n = parseInt(numStr, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { prefix: normalizeShortIdPrefix(prefix), n };
}

/**
 * Compute the next monotonic `<prefix>#<n>` short id for an entity type.
 *
 * The next id is `<prefix>#<max + 1>`, where `max` is the highest `n` found
 * across BOTH `liveIds` and `tombstoneIds` for ids matching `<prefix>#<n>`.
 * The `prefix` argument and every candidate id's parsed prefix are compared
 * via `normalizeShortIdPrefix` (trim + lowercase) — so `nextShortId("Ask",
 * ["ask#1"], [])` and `nextShortId("ask", ["Ask#1"], [])` both allocate
 * `"ask#2"`, never diverging by call-site casing. Ids with a different
 * prefix, or that don't parse as `<prefix>#<n>`, are ignored when computing
 * the max — mirroring `computeNextTaskId`'s "non-mt# ids are ignored"
 * behavior. With no matching ids on either side, the result is
 * `<normalized-prefix>#1`.
 *
 * See the module doc above for scoping (global, not per-project),
 * tombstone semantics, and the concurrency contract this function does NOT
 * itself provide.
 */
export function nextShortId(prefix: string, liveIds: string[], tombstoneIds: string[]): string {
  const normalizedPrefix = normalizeShortIdPrefix(prefix);
  const maxN = [...liveIds, ...tombstoneIds].reduce((acc: number, id: string) => {
    if (typeof id !== "string") return acc;
    const parsed = parseShortId(id);
    if (!parsed || parsed.prefix !== normalizedPrefix) return acc;
    return parsed.n > acc ? parsed.n : acc;
  }, 0);

  return formatShortId(normalizedPrefix, maxN + 1);
}
