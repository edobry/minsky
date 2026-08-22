/**
 * Ask repository — interface + Drizzle/Postgres implementation.
 *
 * The `AskRepository` interface is the domain contract; all consumers depend
 * on the interface only. `DrizzleAskRepository` is the Postgres implementation
 * wired at composition time via tsyringe.
 *
 * Operations:
 *   create                 — insert a new Ask row
 *   getById                — fetch by primary key
 *   listByParentTask       — all Asks for a task
 *   listByParentSession    — all Asks for a session
 *   listByState            — all Asks in a given state
 *   listByClassifierVersion — all Asks produced by a classifier version
 *   transition             — state-machine-aware state update (throws on invalid move)
 *   close                  — convenience wrapper: transition to "closed" + attach response
 *   respondAndClose        — atomic suspended → closed walk (mt#1458)
 *
 * Reference: ADR per mt#1034 (pending merge); mt#1237 spec; mt#1458 (respondAndClose).
 */

import { injectable } from "tsyringe";
// Value import, and safe from a cycle: `edit.ts`'s only import from this module
// is `import type`, which is erased at runtime (PR #3162 R1).
import { stripReservedProvenanceKeys, sanitizeMetadata, CANCELLATION_METADATA_KEY } from "./edit";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { asksTable } from "../storage/schemas/ask-schema";
import { sanitizeForPostgresDeep } from "../storage/postgres-text-safety";
import type { AskRecord, AskInsert } from "../storage/schemas/ask-schema";
import type { Ask, AskState, AskKind, AgentId, AttentionCost } from "./types";
import {
  guardTransition,
  isTerminal,
  ALL_ASK_STATES,
  TERMINAL_ASK_STATES,
  OPEN_ASK_STATES,
  type OpenAskState,
} from "./state-machine";
import { isAllProjects, type ProjectScope } from "../project/scope";
import { nextShortId, formatShortId, parseShortId } from "../utils/short-id";

// ---------------------------------------------------------------------------
// Id-shape resolution (mt#3259)
// ---------------------------------------------------------------------------

/**
 * Canonical UUID shape. `asks.id` is a Postgres `uuid` column, so comparing it
 * against a non-uuid string is a CAST ERROR, not an empty result.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the WHERE clause selecting a single ask by id, accepting either id
 * form (ADR-029: the uuid is canonical, `ask#N` is an additional
 * display/lookup handle).
 *
 * Returns `null` — explicitly, not a clause matching nothing — when the input
 * is NEITHER form, so callers render a miss without issuing a query. Mirrors
 * `memoryIdWhere` in `../memory/memory-service.ts`; the two are deliberately
 * parallel because the underlying defect is identical on both surfaces.
 */
function askIdWhere(id: string) {
  const trimmed = (id ?? "").trim();
  const parsed = parseShortId(trimmed);
  if (parsed && parsed.prefix === "ask") {
    return eq(asksTable.shortId, formatShortId("ask", parsed.n));
  }
  if (UUID_RE.test(trimmed)) return eq(asksTable.id, trimmed);
  return null;
}

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw Drizzle row (`AskRecord`) to the typed domain `Ask` object.
 *
 * Timestamps stored as `Date | null` in Drizzle are converted to ISO-8601
 * strings (or `undefined`) to match the `Ask` interface.
 *
 * @internal Exported for unit testing only — do not import outside of tests.
 */
export function toAsk(row: AskRecord): Ask {
  return {
    id: row.id,
    // ask#N short id (mt#2965) — undefined for legacy rows pre-backfill.
    shortId: row.shortId ?? undefined,
    kind: row.kind as AskKind,
    classifierVersion: row.classifierVersion,
    state: row.state as AskState,
    requestor: row.requestor,
    routingTarget: row.routingTarget ?? undefined,
    parentTaskId: row.parentTaskId ?? undefined,
    parentSessionId: row.parentSessionId ?? undefined,
    projectId: row.projectId ?? undefined,
    title: row.title,
    question: row.question,
    options: row.options ?? undefined,
    contextRefs: row.contextRefs ?? undefined,
    response: (row.response as Ask["response"]) ?? undefined,
    deadline: row.deadline ? row.deadline.toISOString() : undefined,
    createdAt: row.createdAt.toISOString(),
    routedAt: row.routedAt ? row.routedAt.toISOString() : undefined,
    suspendedAt: row.suspendedAt ? row.suspendedAt.toISOString() : undefined,
    respondedAt: row.respondedAt ? row.respondedAt.toISOString() : undefined,
    closedAt: row.closedAt ? row.closedAt.toISOString() : undefined,
    // Service-window fields (mt#1411 spine — mt#1488)
    serviceStrategy: (row.serviceStrategy as Ask["serviceStrategy"]) ?? undefined,
    windowKey: row.windowKey ?? undefined,
    // Coalesce NULLs to documented defaults: types.ts states "Defaults to 0 when absent"
    // and "Defaults to false when absent". Legacy rows (pre-migration-0029) may have NULL
    // because PostgreSQL ADD COLUMN DEFAULT does not backfill existing rows.
    windowMissedCount: row.windowMissedCount ?? 0,
    forceImmediate: row.forceImmediate ?? false,
    // Severity transport binding (mt#3595). NULL stays undefined rather than
    // coalescing to a default: absence is the common case and means "no
    // severity", which is not the same as a value.
    severity: (row.severity as Ask["severity"]) ?? undefined,
    principalPagedAt: row.principalPagedAt ? row.principalPagedAt.toISOString() : undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Map a `CreateAskInput` to a Drizzle `AskInsert` row.
 *
 * `id` and `createdAt` are omitted — the DB defaults handle them.
 */
/**
 * Build the Drizzle insert row for a create.
 *
 * Exported for tests (mt#4331) so the create path's metadata filtering can be
 * asserted without a live DB, and compared key-for-key against
 * `FakeAskRepository.create`. Mirrors the existing `toAsk` export, which
 * `repository.test.ts` already imports for the same reason — a pure mapping
 * function is the right seam, so no double has to be patched (ADR-036).
 *
 * @internal Not part of this module's supported surface: it exists so the row
 * builder is directly assertable, and callers outside this file and its tests
 * should go through `DrizzleAskRepository.create`. Kept beside `toAsk` rather
 * than moved to a test-only module (PR #3197 R1 raised that option) so the two
 * row-mapping functions stay adjacent to the schema they map — splitting them
 * would put the insert mapper further from the code it has to track.
 */
export function toInsert(input: CreateAskInput): AskInsert {
  // ADR-021 / mt#2563: project_id write-stamping (completes the Phase-1.3b
  // deferral from mt#2416). The resolved project uuid is threaded in via
  // CreateAskInput.projectId (resolved at the asks.create execute callsite,
  // mirroring how asks.list resolves the read-side scope). NULL when the
  // project is unidentified (hosted server / cockpit daemon, no single-repo
  // cwd) — an unscoped Ask, consistent with read-side fail-open.
  return {
    kind: input.kind,
    classifierVersion: input.classifierVersion,
    state: "detected",
    requestor: input.requestor,
    routingTarget: input.routingTarget ?? null,
    parentTaskId: input.parentTaskId ?? null,
    parentSessionId: input.parentSessionId ?? null,
    projectId: input.projectId ?? null,
    title: input.title,
    question: input.question,
    options: input.options ?? null,
    contextRefs: input.contextRefs ?? null,
    response: null,
    deadline: input.deadline ? new Date(input.deadline) : null,
    // Service-window fields (mt#1411 spine — mt#1488)
    serviceStrategy: input.serviceStrategy ?? null,
    windowKey: input.windowKey ?? null,
    windowMissedCount: input.windowMissedCount ?? 0,
    forceImmediate: input.forceImmediate ?? false,
    severity: input.severity ?? null,
    // principalPagedAt is deliberately NOT settable on insert — it is the
    // substrate's record, written by `claimPrincipalPage` immediately BEFORE
    // delivery is attempted (see that method's docblock for why that direction
    // is the safer failure). Accepting it from a caller would let a producer
    // claim a page it never sent, which is exactly what the marker exists to
    // prevent (mt#3595).
    principalPagedAt: null,
    // editHistory / originalContent are the substrate's record, not a caller's
    // input — same rule as principalPagedAt above (PR #3162 R1). Stripping here
    // is what makes the reservation real: a planted "original" would otherwise
    // survive to the first edit and pre-empt the genuine capture.
    //
    // mt#4331: `sanitizeMetadata` runs here too, so a forbidden key is BLOCKED at
    // the create boundary rather than only scrubbed later on the way through an
    // edit.
    //
    // Ordered to match `editAskContent`'s merge, for comparability. The order is
    // NOT load-bearing — but only because `defineOwnKey` made the copy safe
    // (PR #3197 R1). Before that, `stripReservedProvenanceKeys` copied via
    // `out[key] = value`, which for `__proto__` invokes the prototype setter, so
    // strip-first built an object whose prototype WAS the payload. That was fixed
    // at the copy rather than pinned here, because a call-site ordering rule
    // cannot be enforced by any value-based test: both orders yield an identical
    // final key set, so a swap would regress silently.
    //
    // The two stay separate functions because their requirements at the edit merge
    // are opposite — provenance keys must SURVIVE it, forbidden keys must not.
    metadata: stripReservedProvenanceKeys(sanitizeMetadata(input.metadata ?? {})),
  };
}

// ---------------------------------------------------------------------------
// Input / option types
// ---------------------------------------------------------------------------

/** Input for creating a new Ask. `id` and `createdAt` are auto-assigned. All Asks start in "detected". */
export interface CreateAskInput {
  kind: AskKind;
  classifierVersion: string;
  requestor: AgentId;
  routingTarget?: Ask["routingTarget"];
  parentTaskId?: string;
  parentSessionId?: string;
  /**
   * Resolved project uuid to stamp on the new Ask (ADR-021, mt#2563). Omitted
   * when the project is unidentified — the Ask is then unscoped (NULL). Resolved
   * at the `asks.create` execute callsite via the same path `asks.list` uses for
   * read-side scoping.
   */
  projectId?: string;
  title: string;
  question: string;
  options?: Ask["options"];
  contextRefs?: Ask["contextRefs"];
  deadline?: string;
  metadata?: Record<string, unknown>;
  /** Service-window routing strategy (mt#1411 spine — mt#1488). */
  serviceStrategy?: Ask["serviceStrategy"];
  /** Named window to target when strategy is "scheduled". */
  windowKey?: string;
  /** Count of windows already missed (defaults to 0 on insert). */
  windowMissedCount?: number;
  /** Bypass window check and route immediately. */
  forceImmediate?: boolean;
  /**
   * Severity marker driving transport escalation (mt#3595). `"incident"` on an
   * operator-routed ask causes the substrate to page the principal once.
   *
   * `principalPagedAt` is intentionally absent from this input — it is written
   * by `claimPrincipalPage` at page time, never supplied by a producer.
   */
  severity?: Ask["severity"];
}

/** Input for closing an Ask (state → "closed"). */
export interface CloseAskInput {
  response: NonNullable<Ask["response"]>;
}

/** Input for recording a response on an Ask (state → "responded"). */
export interface RespondAskInput {
  response: NonNullable<Ask["response"]>;
}

/**
 * Editable content fields on an Ask (mt#2668).
 *
 * Only content-bearing fields are editable — lifecycle state, routing fields,
 * and service-window fields are owned by their respective mechanisms (state
 * machine, router, reaper) and are NOT reachable through `updateContent`.
 *
 * `metadata` here is the FINAL metadata object to persist — callers that want
 * merge semantics (e.g. `editAskContent` in edit.ts) compute the merged object
 * before calling the repository.
 */
export interface EditAskFields {
  title?: string;
  question?: string;
  options?: Ask["options"];
  contextRefs?: Ask["contextRefs"];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AskRepository interface
// ---------------------------------------------------------------------------

/**
 * Domain contract for Ask persistence.
 *
 * All business logic that touches Asks must depend on this interface, not on
 * the concrete Drizzle implementation, so tests can inject a fake.
 */
export interface AskRepository {
  /** Insert a new Ask row and return the persisted entity. */
  create(input: CreateAskInput): Promise<Ask>;

  /** Fetch an Ask by primary key. Returns `null` if not found. */
  getById(id: string): Promise<Ask | null>;

  /** List all Asks whose `parentTaskId` matches the given task ID. */
  listByParentTask(taskId: string): Promise<Ask[]>;

  /** List all Asks whose `parentSessionId` matches the given session ID. */
  listByParentSession(sessionId: string): Promise<Ask[]>;

  /**
   * List all Asks currently in the given state.
   * When `projectScope` is a uuid, filters to Asks belonging to that project.
   * When omitted or ALL_PROJECTS, returns cross-project rows (ADR-021, mt#2416).
   */
  listByState(state: AskState, projectScope?: ProjectScope): Promise<Ask[]>;

  /** List all Asks produced by the given classifier version. */
  listByClassifierVersion(version: string): Promise<Ask[]>;

  /**
   * One page of Asks across several states, for a single routing target,
   * most-recently-concluded first (mt#4092).
   *
   * The cockpit's resolved-asks view needs a bounded slice of a large set:
   * ~4,500 rows sit in the terminal states, ~1,500 of them operator-routed, and
   * the surface shows a page of them. Composing that from `listByState` means
   * pulling every row in every requested state across every routing target and
   * discarding ~97% of it in JS — measured at 2.7-6.4s per request against the
   * real store, versus 0.3s for the pending queue. This pushes the state
   * filter, the routing-target filter, the ordering, and the limit into one
   * query, and returns the true match count beside the page so a caller can say
   * how much it is not showing.
   *
   * Ordering is by conclusion time — `closedAt`, falling back to `respondedAt`
   * and then `createdAt`, so a row that never reached a terminal timestamp
   * still sorts deterministically rather than drifting on physical row order.
   *
   * @param params.states        States to include (empty ⇒ no rows, no query).
   * @param params.routingTarget Exact `routingTarget` to match.
   * @param params.limit         Maximum rows in `asks`; `total` is unbounded.
   */
  listByStatesForRoutingTarget(params: {
    states: AskState[];
    routingTarget: string;
    limit: number;
    projectScope?: ProjectScope;
  }): Promise<{ asks: Ask[]; total: number }>;

  /**
   * Every `(shortId, id)` pair for a routing target, in ANY state (mt#4095).
   *
   * Feeds the cockpit linkifier's id-set, which decides SYNCHRONOUSLY at render
   * whether an `ask#N` in prose becomes a link — so the set has to be complete
   * before the first render, and an async per-id lookup cannot serve it. That
   * is why this is a comprehensive, uncapped, two-column projection rather than
   * a page of full rows: the same shape, and the same reason, as the task
   * surface's `/api/tasks/ids`.
   *
   * State-agnostic on purpose. The defect this exists to fix is that a closed
   * ask's `ask#N` silently stopped resolving in every memory, spec and
   * transcript that mentioned it.
   *
   * Rows with no `shortId` (legacy, pre-backfill) are omitted — there is no
   * short id to alias.
   */
  listShortIdsForRoutingTarget(params: {
    routingTarget: string;
    projectScope?: ProjectScope;
  }): Promise<{ shortId: string; id: string }[]>;

  /**
   * Batch-list open Asks for any task in `taskIds`.
   *
   * "Open" means state is not one of the terminal states (closed / cancelled
   * / expired). Rows are returned ordered by `createdAt` descending so the
   * caller can group by `parentTaskId` and pick the first row per task.
   *
   * Replaces the N-query `Promise.all(taskIds.map(listByParentTask))` pattern
   * with a single query — see `getOpenAsksByTaskIds` in queries.ts. Returns
   * an empty array when `taskIds` is empty (no query is issued).
   *
   * @param taskIds Task IDs to filter by.
   * @returns       Open Asks across all matching tasks, sorted createdAt desc.
   */
  findOpenByTaskIds(taskIds: string[]): Promise<Ask[]>;

  /**
   * Transition an Ask to a new state.
   *
   * Enforces the state machine — throws `InvalidAskTransitionError` when the
   * requested `from → to` pair is not in the valid-transitions table.
   *
   * @param id  Primary key of the Ask to update.
   * @param to  Target state.
   * @returns   The updated Ask.
   * @throws    `InvalidAskTransitionError` — invalid transition.
   * @throws    `Error` — Ask not found.
   */
  transition(id: string, to: AskState): Promise<Ask>;

  /**
   * Merge a cancellation-provenance record into `metadata` ATOMICALLY (mt#3353).
   *
   * Exists because `transition(id, "cancelled")` writes `state` and `closedAt`
   * and nothing else, so a cancelled Ask otherwise carries no record of who
   * retired it or why — the reason ask#5681 sits terminal and unattributable.
   *
   * Deliberately NOT expressed as a read-merge-`updateContent` sequence, which
   * is what shipped first and what PR #3190's review caught as BLOCKING: that
   * shape reads `metadata`, merges in memory, and writes the whole object back,
   * so a concurrent edit landing inside the window is silently clobbered — a
   * lost update on the exact column whose job is provenance. This merges
   * server-side with jsonb `||`, so no window exists. `updateContent`'s
   * whole-object contract is unchanged and remains correct for its own callers,
   * which compute a merge from a freshly-read Ask under the caller's own
   * ordering.
   *
   * Only touches a NON-TERMINAL row, matching `updateContent`: the caller writes
   * this immediately before the transition.
   *
   * @param id      Primary key of the Ask.
   * @param record  The provenance object stored under the `cancellation` key.
   * @returns       true when a row was updated; false when none matched (already
   *                terminal, or gone) — never throws on a miss, because the
   *                caller's cancellation must not fail on an audit-write miss.
   */
  recordCancellation(id: string, record: Record<string, unknown>): Promise<boolean>;

  /**
   * Record a response on an Ask (state → "responded").
   *
   * Transitions state to "responded", attaches the response payload, and sets
   * `respondedAt`. Throws on invalid transitions (same as `transition`).
   *
   * @param id     Primary key of the Ask to update.
   * @param input  The response payload to attach.
   * @returns      The updated Ask.
   * @throws       `InvalidAskTransitionError` — invalid transition.
   * @throws       `Error` — Ask not found.
   */
  respond(id: string, input: RespondAskInput): Promise<Ask>;

  /**
   * Close an Ask (convenience wrapper around `transition`).
   *
   * Transitions state to "closed" and writes the response payload in a single
   * operation. Throws on invalid transitions (same as `transition`).
   */
  close(id: string, input: CloseAskInput): Promise<Ask>;

  /**
   * Atomically respond to and close a `"suspended"` Ask in one step.
   *
   * Logically walks the Ask through `suspended → responded → closed`, but
   * persists ONLY the close stage: the row goes from suspended to closed
   * in a single UPDATE with `respondedAt` and `closedAt` both set to now,
   * `state: "closed"`, and `response = closeInput.response`. The
   * `respondInput` parameter exists solely to document the two-stage
   * logical model (the same shape `repo.respond` would receive); the
   * intermediate "responded" payload is NOT persisted to a separate row
   * or column. Callers that need an audit trail of the intermediate
   * payload should design that separately.
   *
   * Atomicity guarantee:
   *   - **Drizzle backend**: optimistic-concurrency `WHERE id = ? AND
   *     state = 'suspended'` clause. If a concurrent actor transitions
   *     the Ask between this call and its execution (cancel, expire,
   *     etc.), the update matches zero rows and the method throws
   *     `ConcurrentTransitionError` describing the actual current state.
   *   - **Fake backend**: single-threaded — atomic by virtue of the
   *     synchronous in-memory implementation.
   *
   * Used by `respondToAsk` (mt#1458) to honor the `Ask.response` contract
   * (`attentionCost` is filled on close) AND the no-stuck-in-responded
   * invariant.
   *
   * @throws `Error` — Ask not found.
   * @throws `ConcurrentTransitionError` — Ask was not in `"suspended"` state
   *         when the atomic update ran.
   */
  respondAndClose(
    id: string,
    respondInput: RespondAskInput,
    closeInput: CloseAskInput
  ): Promise<Ask>;

  /**
   * Persist an updated `windowMissedCount` on an Ask row.
   *
   * Does NOT enforce the state machine — this is a field-level update, not a
   * state transition. Throws `Error` if the Ask is not found.
   *
   * Used by the Reaper (mt#1490) to persist miss-count increments so that
   * subsequent reads reflect the new count and escalation thresholds trip
   * correctly in production.
   *
   * @param id    Primary key of the Ask to update.
   * @param count New `windowMissedCount` value.
   * @returns     The updated Ask.
   */
  updateWindowMissedCount(id: string, count: number): Promise<Ask>;

  /**
   * Persist an updated `forceImmediate` flag on an Ask row.
   *
   * Does NOT enforce the state machine — this is a field-level update, not a
   * state transition. Throws `Error` if the Ask is not found.
   *
   * Used by the Reaper (mt#1490) to persist the escalation flag so that
   * subsequent reads reflect the true escalated state on the DB row.
   *
   * @param id    Primary key of the Ask to update.
   * @param value New `forceImmediate` value.
   * @returns     The updated Ask.
   */
  updateForceImmediate(id: string, value: boolean): Promise<Ask>;

  /**
   * Claim the right to page the principal about this Ask (mt#3595).
   *
   * Sets `principal_paged_at` ONLY when it is currently NULL, and reports
   * whether this call is the one that set it. The conditional write is the
   * idempotency mechanism: a read-then-write would let two concurrent
   * producers both observe NULL and both page, which is precisely the
   * double-notification this exists to prevent.
   *
   * Claim BEFORE delivering, not after. A page delivered but unrecorded (crash
   * between send and write) would re-page on the next attempt; a page claimed
   * but undelivered is recoverable and visible, and the caller records the
   * delivery failure rather than silently dropping it.
   *
   * @param id Primary key of the Ask to claim.
   * @param at Timestamp to record.
   * @returns  `claimed: true` when this call set the column; `false` when a
   *           page had already been recorded, in which case the caller must
   *           NOT send.
   */
  claimPrincipalPage(id: string, at: Date): Promise<{ claimed: boolean; ask: Ask }>;

  /**
   * Count Asks paged since `since` — the rate limiter's input (mt#3595).
   *
   * Counts across ALL asks, not per-task or per-project: the resource being
   * rationed is the principal's attention, which is global.
   */
  countPrincipalPagesSince(since: Date): Promise<number>;

  /**
   * Persist an updated `routingTarget` on an Ask row.
   *
   * Does NOT enforce the state machine — this is a field-level update, not a
   * state transition. Throws `Error` if the Ask is not found.
   *
   * Used by `createAsk` (mt#1490) to persist the router's `routingTarget`
   * decision on window-deferred Asks so that subsequent reads see the target
   * the router resolved (e.g. "operator" for inbox/elicitation Asks).
   *
   * @param id     Primary key of the Ask to update.
   * @param target New `routingTarget` value.
   * @returns      The updated Ask.
   */
  updateRoutingTarget(id: string, target: string): Promise<Ask>;

  /**
   * Persist edited content fields on a non-terminal Ask (mt#2668).
   *
   * Does NOT enforce the state machine and MUST NOT change `state` — this is
   * a field-level content update (same family as `updateWindowMissedCount` /
   * `updateRoutingTarget`), so a suspended Ask stays suspended and stays in
   * the operator queue.
   *
   * Atomicity guarantee (Drizzle): optimistic-concurrency
   * `WHERE id = ? AND state NOT IN (closed, cancelled, expired)`. If the Ask
   * reached a terminal state between the caller's read and this write, the
   * update matches zero rows and an `Error` naming the observed terminal
   * state is thrown — terminal asks are never edited.
   *
   * Note: the read-merge-write on `metadata` performed by callers (edit.ts)
   * is NOT protected against concurrent metadata writers — acceptable for
   * the rare-edit cadence this surface serves; revisit with a jsonb-append
   * UPDATE if concurrent editors become real.
   *
   * @param id     Primary key of the Ask to update.
   * @param fields Content fields to persist (at least one must be present).
   * @returns      The updated Ask.
   * @throws       `Error` — Ask not found, Ask in terminal state, or no
   *               fields provided.
   */
  updateContent(id: string, fields: EditAskFields): Promise<Ask>;

  /**
   * Atomically persist a router outcome on a pre-routing Ask (mt#2265).
   *
   * The router (`policyFirstRoute`) computes its result in memory; this
   * method is the single write that lands that result on the row. Follows
   * the `respondAndClose` precedent: the LOGICAL state-machine walk from
   * `detected` to `outcome.state` is validated hop-by-hop via
   * `guardTransition`, then ONE atomic UPDATE writes the terminal shape.
   *
   * Atomicity guarantee (Drizzle): optimistic-concurrency
   * `WHERE id = ? AND state = 'detected'`. If a concurrent actor advanced
   * the row first (a second sweeper pass, an operator cancel), the update
   * matches zero rows and `ConcurrentTransitionError` is thrown — no
   * double-advancement is possible.
   *
   * @param id      Primary key of the Ask to advance.
   * @param outcome Terminal shape to persist (state + routing fields).
   * @returns       The updated Ask (persisted truth, not the in-memory route).
   * @throws        `InvalidAskTransitionError` — `outcome.state` unreachable from `detected`.
   * @throws        `ConcurrentTransitionError` — row was no longer in `detected`.
   * @throws        `Error` — Ask not found.
   */
  persistRouteOutcome(id: string, outcome: RouteOutcomeWrite): Promise<Ask>;

  /**
   * Count Asks grouped by lifecycle state (mt#2265 observability).
   *
   * Returns a complete record — every `AskState` key is present, zero-filled
   * when no rows are in that state — so consumers (debug.systemInfo, cockpit
   * metrics) never need existence checks.
   */
  countByState(): Promise<Record<AskState, number>>;

  /**
   * Dwell-time statistics for OPEN asks, grouped by state (mt#4361).
   *
   * `countByState` above answers "how many are in each state" and is silent on
   * the only question that distinguishes a healthy `routed` from a stranded
   * one: how long they have been there. A snapshot count is byte-identical five
   * minutes and five weeks after an ask routes, which is why 3,195 `detected`
   * rows (mt#2257) and later five undelivered `routed` asks (mt#3353) were both
   * found by a manual probe rather than by the signal built to surface them.
   *
   * Age is measured from the moment the ask ENTERED its current state, not from
   * `createdAt` — the question is "how long undelivered", and an ask created
   * long before it routed would otherwise read as stranded on arrival. Where a
   * state has no dedicated timestamp column (`detected`, `classified`) the row's
   * `createdAt` is the entry time.
   *
   * Terminal states are excluded rather than zero-filled: a closed ask has no
   * meaningful dwell time, and a `Record` over all eight states would
   * manufacture a `0` indistinguishable from a real zero-age ask.
   *
   * @param opts.nowMs             Clock, injected so tests need not depend on wall time.
   * @param opts.stallThresholdMs  Dwell time past which an ask counts as stalled.
   * @returns Every `OpenAskState` key, present and zeroed when the state is empty.
   */
  openStateAgeStats(opts: {
    nowMs: number;
    stallThresholdMs: number;
  }): Promise<Record<OpenAskState, AskAgeStats>>;
}

/**
 * Dwell-time statistics for one open Ask state (mt#4361).
 */
export interface AskAgeStats {
  /**
   * Age in ms of the oldest ask in this state, measured from state entry.
   *
   * `null` — not `0` — when no ask is in the state. The two are different
   * findings and only one of them is data: `0` means an ask entered this state
   * just now.
   */
  oldestAgeMs: number | null;
  /** Asks in this state whose dwell time exceeds the stall threshold. */
  stalledCount: number;
}

/**
 * A complete, empty `openStateAgeStats` result — every `OpenAskState` key
 * present, `oldestAgeMs: null` (no ask, as distinct from a zero-age one).
 *
 * Shared by both repository implementations and by the state-counts provider's
 * unavailable path, so all three agree on what "nothing to report" looks like.
 */
export function emptyOpenStateAgeStats(): Record<OpenAskState, AskAgeStats> {
  return Object.fromEntries(
    OPEN_ASK_STATES.map((s) => [s, { oldestAgeMs: null, stalledCount: 0 }])
  ) as Record<OpenAskState, AskAgeStats>;
}

/**
 * When an Ask entered its CURRENT state (mt#4361).
 *
 * **This MUST stay equivalent to the `stateSince` COALESCE in
 * `DrizzleAskRepository.openStateAgeStats`** — the same semantics exist twice,
 * once in SQL for Postgres and once here for the fake, and a divergence would
 * make the hermetic tests agree with a production query that behaves
 * differently. `openStateAgeStats` is covered against both implementations for
 * that reason.
 *
 * `createdAt` is `notNull` in the schema, so the fallback always yields a value.
 */
function stateEntryIso(ask: Ask): string {
  switch (ask.state) {
    case "routed":
      return ask.routedAt ?? ask.createdAt;
    case "suspended":
      return ask.suspendedAt ?? ask.createdAt;
    case "responded":
      return ask.respondedAt ?? ask.createdAt;
    default:
      return ask.createdAt;
  }
}

// ---------------------------------------------------------------------------
// Route-outcome persistence (mt#2265)
// ---------------------------------------------------------------------------

/**
 * Terminal shape a router outcome persists onto a `detected` Ask row.
 *
 * - `"suspended"` — async operator-bound transports (inbox; elicitation
 *   fallback): the Ask is waiting for a response on the operator surface.
 * - `"routed"`    — async non-operator transports with no dispatcher yet
 *   (subagent / mesh / retriever): target persisted, awaiting a transport.
 * - `"closed"`    — policy-covered: the router resolved the Ask itself.
 * - `"expired"`   — staleness expiry (advancement sweep age guard).
 */
export interface RouteOutcomeWrite {
  state: "routed" | "suspended" | "closed" | "expired";
  routingTarget?: string;
  /** Response payload — required when `state` is `"closed"` (policy close). */
  response?: Ask["response"];
}

/**
 * Validate the logical `detected → outcome.state` walk against the state
 * machine, hop by hop. Shared by both repository implementations so the
 * transition table stays the single source of truth (same pattern as
 * `respondAndClose`'s two-guard preamble).
 */
export function guardRouteOutcomeWalk(outcomeState: RouteOutcomeWrite["state"]): void {
  switch (outcomeState) {
    case "routed":
      guardTransition("detected", "classified");
      guardTransition("classified", "routed");
      break;
    case "suspended":
      guardTransition("detected", "classified");
      guardTransition("classified", "suspended");
      break;
    case "closed":
      // Policy close: the router resolved the Ask without operator
      // involvement. Logical walk per the state machine:
      // detected → classified → routed → suspended → responded → closed.
      guardTransition("detected", "classified");
      guardTransition("classified", "routed");
      guardTransition("routed", "suspended");
      guardTransition("suspended", "responded");
      guardTransition("responded", "closed");
      break;
    case "expired":
      guardTransition("detected", "expired");
      break;
  }
}

/**
 * Thrown when `respondAndClose` finds the Ask is not in `"suspended"` state
 * at the moment of the atomic update — typically because a concurrent actor
 * cancelled / expired / closed the Ask between read and write.
 *
 * The deletion race (Ask removed between read and write) surfaces as a
 * plain `Error("Ask not found: ${id}")` instead, matching the rest of the
 * repository's not-found semantics.
 */
export class ConcurrentTransitionError extends Error {
  readonly id: string;
  readonly observedState: AskState;

  constructor(id: string, observedState: AskState, expectedState: AskState = "suspended") {
    super(
      `Concurrent transition on Ask ${id}: expected state="${expectedState}" at atomic update, found state="${observedState}". Another actor transitioned the Ask between read and write.`
    );
    this.name = "ConcurrentTransitionError";
    this.id = id;
    this.observedState = observedState;
  }
}

// ---------------------------------------------------------------------------
// respondAndCloseAsk — shared suspended -> closed walk (mt#2615)
// ---------------------------------------------------------------------------

/** Params accepted by {@link respondAndCloseAsk}. */
export interface RespondAndCloseAskParams {
  /** Primary key of the Ask to respond to and close. */
  id: string;
  /** AgentId or `"operator"` identifier; defaults to `"operator"` when absent/blank. */
  responder?: string;
  /**
   * Kind-specific response payload. Deliberately `unknown` — callers own
   * their own payload shape (a plain `{ message }` wrapper for the CLI/MCP
   * `respondToAsk` surface in `asks.ts`; a structured `{ option, chosen }` /
   * `{ approved }` shape for the cockpit UI's resolve endpoint). This
   * function does not interpret payload contents.
   */
  payload: unknown;
  /**
   * Attention cost recorded on close. Callers MUST compute this themselves
   * (server-side for HTTP surfaces) rather than trusting untrusted input —
   * this function does not validate or default it beyond passing it through.
   */
  attentionCost?: AttentionCost;
}

/**
 * Shared suspended -> closed walk used by both `respondToAsk`
 * (`src/adapters/shared/commands/asks.ts` — the plain-message CLI/MCP
 * surface) and the cockpit `POST /api/asks/:id/resolve` route (the
 * structured-payload UI surface). Extracted (mt#2615) so both callers share
 * ONE suspended-state precondition check, ONE responder-trim rule, and ONE
 * `ConcurrentTransitionError` handling path instead of two independently
 * maintained implementations.
 *
 * Precondition: the Ask must exist and be in `"suspended"` state — earlier
 * states (detected/classified/routed) mean no transport has dispatched yet;
 * terminal states (closed/cancelled/expired) cannot be responded to again.
 *
 * Endpoint-specific policy (e.g. the cockpit resolve route's `routingTarget
 * === "operator"` algedonic-selection gate, mt#1147 PR #1125 R1) is NOT part
 * of this shared contract — callers apply their own additional gates before
 * calling this function.
 *
 * @throws `Error` — Ask not found, or in a non-suspended state (including the
 *         race-normalized message for a concurrent transition that lands the
 *         Ask in a non-suspended state between the precondition check and
 *         the atomic update).
 */
export async function respondAndCloseAsk(
  repo: AskRepository,
  params: RespondAndCloseAskParams
): Promise<{ ask: Ask }> {
  if (!params.id || params.id.trim() === "") {
    throw new Error("respondAndCloseAsk: id is required and must not be empty");
  }

  const persisted = await repo.getById(params.id);
  if (!persisted) {
    throw new Error(`respondAndCloseAsk: Ask not found: ${params.id}`);
  }
  if (persisted.state !== "suspended") {
    throw new Error(
      `respondAndCloseAsk: Ask is in "${persisted.state}" state — only "suspended" Asks can be responded to. ` +
        `(detected/classified/routed: no transport has dispatched yet; ` +
        `closed/cancelled/expired: terminal.)`
    );
  }

  // Trim before constructing the payload so every caller (CLI/MCP/cockpit)
  // sees the same normalized responder identifier.
  const responder = params.responder?.trim() || "operator";

  // Two-stage response payload, matching the Ask.response contract in
  // types.ts: `attentionCost` is filled on close only.
  const respondPayload = {
    responder,
    payload: params.payload,
  };
  const closePayload = {
    responder,
    payload: params.payload,
    attentionCost: params.attentionCost,
  };

  // Atomic walk suspended -> closed via the repository's combined operation.
  // Catch ConcurrentTransitionError and re-throw with the same friendly
  // not-suspended message the pre-check above uses, so callers see ONE error
  // shape for "Ask is not in suspended state" regardless of cause.
  try {
    const closed = await repo.respondAndClose(
      params.id,
      { response: respondPayload },
      { response: closePayload }
    );
    return { ask: closed };
  } catch (err) {
    if (err instanceof ConcurrentTransitionError) {
      throw new Error(
        `respondAndCloseAsk: Ask is in "${err.observedState}" state — only "suspended" Asks can be responded to. ` +
          `(Concurrent actor transitioned the Ask between read and write.)`
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// DrizzleAskRepository — Postgres implementation
// ---------------------------------------------------------------------------

/**
 * Postgres implementation of `AskRepository` using the Drizzle ORM.
 *
 * Injected via tsyringe at composition time with a `PostgresJsDatabase`
 * instance. All queries use the typed `asksTable` schema — no raw SQL.
 */
@injectable()
export class DrizzleAskRepository implements AskRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  /**
   * Mint the next `ask#N` short id (mt#2965, generalizing mt#2205's
   * `computeNextTaskId` pattern via the shared `nextShortId` util).
   *
   * Targeted query (PR #2110 R1 perf finding): rather than loading every
   * non-null `short_id` row into memory to fold over client-side, fetch ONLY
   * the single highest-numbered row via `ORDER BY <numeric suffix> DESC
   * LIMIT 1` — a `WHERE short_id ~ '^ask#[0-9]+$'` filter (mirroring
   * `parseShortId`'s shape) excludes any malformed value before the numeric
   * cast, and the `ORDER BY` computes the numeric suffix server-side so a
   * lexicographic string sort (which would misorder "ask#10" before
   * "ask#2") is never used. `nextShortId` remains the single source of
   * truth for the "+1" computation — this only changes how the CANDIDATE
   * max is fetched, not how the next id is derived from it.
   *
   * Asks have no tombstone table analogous to tasks' `deleted_task_ids`
   * (mt#2205) — the max is computed over live short ids only, so a deleted
   * ask's short id MAY be reissued to a new ask. Acceptable for v1 per the
   * mt#2965 spec; a future task can add a `deleted_ask_short_ids` tombstone
   * table mirroring the tasks pattern if reuse proves undesirable.
   */
  private async nextAskShortId(): Promise<string> {
    const [top] = await this.db
      .select({ shortId: asksTable.shortId })
      .from(asksTable)
      .where(sql`${asksTable.shortId} ~ '^ask#[0-9]+$'`)
      .orderBy(sql`(substring(${asksTable.shortId} from 5))::bigint DESC`)
      .limit(1);
    const liveIds = top?.shortId ? [top.shortId] : [];
    return nextShortId("ask", liveIds, []);
  }

  async create(rawInput: CreateAskInput): Promise<Ask> {
    // mt#3278: sanitize at the boundary rather than at each write site — an ask
    // body, its options, and its contextRefs are all agent-authored prose that
    // can carry a codepoint Postgres cannot store, and a per-site fix is one
    // refactor away from missing a path.
    const input: CreateAskInput = sanitizeForPostgresDeep(rawInput).value;
    // Retry loop mirroring MinskyTaskBackend.tryInsertTask (mt#2205): the
    // short-id proposal (SELECT max) and the INSERT are not atomic, so a
    // concurrent writer may claim the proposed id between the two. The
    // unique index on `short_id` turns that race into a clean
    // onConflictDoNothing no-op we detect and retry against, rather than
    // silently clobbering or throwing a raw constraint-violation error.
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const shortId = await this.nextAskShortId();
      const rows = await this.db
        .insert(asksTable)
        .values({ ...toInsert(input), shortId })
        .onConflictDoNothing({ target: asksTable.shortId })
        .returning();
      const row = rows[0];
      if (row) {
        return toAsk(row);
      }
      // short_id collision — another writer took it; loop and re-propose.
    }
    throw new Error(
      `Failed to allocate a unique ask short id after ${MAX_RETRIES} attempts. ` +
        "This indicates extremely high concurrent ask creation — please retry."
    );
  }

  async getById(id: string): Promise<Ask | null> {
    const where = askIdWhere(id);
    // Neither a uuid nor an `ask#N` short id — a genuine miss, not a query.
    // `asks.id` is a Postgres `uuid` column, so passing a non-uuid string
    // through to `eq()` raises `invalid input syntax for type uuid` and
    // echoes the failing statement rather than returning empty (mt#3259 —
    // the same defect fixed on the memory surface, confirmed live there).
    if (!where) return null;

    const rows = await this.db.select().from(asksTable).where(where).limit(1);
    const row = rows[0];
    return row ? toAsk(row) : null;
  }

  async listByParentTask(taskId: string): Promise<Ask[]> {
    const rows = await this.db.select().from(asksTable).where(eq(asksTable.parentTaskId, taskId));
    return rows.map(toAsk);
  }

  async listByParentSession(sessionId: string): Promise<Ask[]> {
    const rows = await this.db
      .select()
      .from(asksTable)
      .where(eq(asksTable.parentSessionId, sessionId));
    return rows.map(toAsk);
  }

  async listByState(state: AskState, projectScope?: ProjectScope): Promise<Ask[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [eq(asksTable.state, state)];
    // Project scope filter (ADR-021, mt#2416)
    if (projectScope && !isAllProjects(projectScope)) {
      conditions.push(eq(asksTable.projectId, projectScope));
    }
    const rows = await this.db
      .select()
      .from(asksTable)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions));
    return rows.map(toAsk);
  }

  async listByClassifierVersion(version: string): Promise<Ask[]> {
    const rows = await this.db
      .select()
      .from(asksTable)
      .where(eq(asksTable.classifierVersion, version));
    return rows.map(toAsk);
  }

  async listByStatesForRoutingTarget(params: {
    states: AskState[];
    routingTarget: string;
    limit: number;
    projectScope?: ProjectScope;
  }): Promise<{ asks: Ask[]; total: number }> {
    const { states, routingTarget, limit, projectScope } = params;
    if (states.length === 0) return { asks: [], total: 0 };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [
      inArray(asksTable.state, states),
      eq(asksTable.routingTarget, routingTarget),
    ];
    if (projectScope && !isAllProjects(projectScope)) {
      conditions.push(eq(asksTable.projectId, projectScope));
    }
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    // COALESCE, not three ORDER BY terms: the fallback is per-ROW (use this
    // row's closedAt, else its respondedAt, else its createdAt), which is a
    // different ordering from "sort by closedAt, break ties on respondedAt".
    const concludedAt = sql`coalesce(${asksTable.closedAt}, ${asksTable.respondedAt}, ${asksTable.createdAt})`;

    const [rows, counted] = await Promise.all([
      this.db.select().from(asksTable).where(where).orderBy(desc(concludedAt)).limit(limit),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(asksTable)
        .where(where),
    ]);

    return { asks: rows.map(toAsk), total: Number(counted[0]?.n ?? 0) };
  }

  async listShortIdsForRoutingTarget(params: {
    routingTarget: string;
    projectScope?: ProjectScope;
  }): Promise<{ shortId: string; id: string }[]> {
    const { routingTarget, projectScope } = params;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [
      eq(asksTable.routingTarget, routingTarget),
      isNotNull(asksTable.shortId),
    ];
    if (projectScope && !isAllProjects(projectScope)) {
      conditions.push(eq(asksTable.projectId, projectScope));
    }

    const rows = await this.db
      .select({ shortId: asksTable.shortId, id: asksTable.id })
      .from(asksTable)
      .where(and(...conditions));

    // `isNotNull` already excludes them at the DB, but the column's type stays
    // nullable, so this narrows rather than re-filters.
    return rows.flatMap((r) => (r.shortId ? [{ shortId: r.shortId, id: r.id }] : []));
  }

  async findOpenByTaskIds(taskIds: string[]): Promise<Ask[]> {
    if (taskIds.length === 0) return [];
    // Explicit isNotNull on parentTaskId is redundant with `IN (...)` in
    // standard SQL (NULL evaluates to UNKNOWN and is filtered out), but
    // we keep it explicit for parity with FakeAskRepository and for
    // robustness against ORM/dialect surprises.
    const rows = await this.db
      .select()
      .from(asksTable)
      .where(
        and(
          isNotNull(asksTable.parentTaskId),
          inArray(asksTable.parentTaskId, taskIds),
          notInArray(asksTable.state, TERMINAL_ASK_STATES as AskState[])
        )
      )
      .orderBy(desc(asksTable.createdAt));
    return rows.map(toAsk);
  }

  async transition(id: string, to: AskState): Promise<Ask> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Throws InvalidAskTransitionError on invalid moves.
    guardTransition(existing.state, to);

    // Build timestamp updates for lifecycle tracking.
    const now = new Date();
    const updates: Partial<AskInsert> = { state: to };

    if (to === "routed") updates.routedAt = now;
    else if (to === "suspended") updates.suspendedAt = now;
    else if (to === "responded") updates.respondedAt = now;
    else if (to === "closed" || to === "cancelled" || to === "expired") updates.closedAt = now;

    const rows = await this.db
      .update(asksTable)
      .set(updates)
      .where(eq(asksTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`Ask update returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async recordCancellation(id: string, record: Record<string, unknown>): Promise<boolean> {
    // jsonb `||` merges right-into-left server-side, so the read and the write
    // are one statement and no concurrent edit can be lost. COALESCE covers a
    // NULL metadata column, where `||` would otherwise yield NULL and erase the
    // record we are trying to write.
    const merged = sanitizeForPostgresDeep({ [CANCELLATION_METADATA_KEY]: record }).value;
    const rows = await this.db
      .update(asksTable)
      .set({
        metadata: sql`COALESCE(${asksTable.metadata}, '{}'::jsonb) || ${JSON.stringify(merged)}::jsonb`,
      })
      .where(
        and(eq(asksTable.id, id), notInArray(asksTable.state, TERMINAL_ASK_STATES as AskState[]))
      )
      .returning();
    return rows.length > 0;
  }

  async respond(id: string, rawInput: RespondAskInput): Promise<Ask> {
    // mt#3278 — see `create` above.
    const input: RespondAskInput = sanitizeForPostgresDeep(rawInput).value;
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Throws InvalidAskTransitionError on invalid moves.
    guardTransition(existing.state, "responded");

    const now = new Date();
    const rows = await this.db
      .update(asksTable)
      .set({
        state: "responded",
        response: input.response as AskInsert["response"],
        respondedAt: now,
      })
      .where(eq(asksTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`Ask respond returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async close(id: string, input: CloseAskInput): Promise<Ask> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Throws InvalidAskTransitionError on invalid moves.
    guardTransition(existing.state, "closed");

    const now = new Date();
    const rows = await this.db
      .update(asksTable)
      .set({
        state: "closed",
        response: input.response as AskInsert["response"],
        closedAt: now,
        respondedAt: existing.respondedAt ? new Date(existing.respondedAt) : now,
      })
      .where(eq(asksTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`Ask close returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async respondAndClose(
    id: string,
    _respondInput: RespondAskInput,
    closeInput: CloseAskInput
  ): Promise<Ask> {
    // Invariant enforcement: the persistence-level atomic update writes
    // state="closed" directly, but the LOGICAL walk is suspended → responded
    // → closed. We invoke guardTransition twice here so the state-machine
    // table is consulted as the source of truth.
    guardTransition("suspended", "responded");
    guardTransition("responded", "closed");

    // Optimistic concurrency: only update if the row is still in "suspended".
    // If a concurrent actor transitioned the Ask between this call and its
    // execution, the WHERE clause matches zero rows and we surface
    // ConcurrentTransitionError. No stuck-in-responded state is possible.
    const now = new Date();
    const rows = await this.db
      .update(asksTable)
      .set({
        state: "closed",
        response: closeInput.response as AskInsert["response"],
        respondedAt: now,
        closedAt: now,
      })
      .where(and(eq(asksTable.id, id), eq(asksTable.state, "suspended")))
      .returning();

    if (rows.length === 0) {
      // Disambiguate: not-found vs. wrong-state.
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`Ask not found: ${id}`);
      }
      throw new ConcurrentTransitionError(id, existing.state);
    }
    const row = rows[0];
    if (!row) {
      throw new Error(`Ask respondAndClose returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async updateWindowMissedCount(id: string, count: number): Promise<Ask> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    const rows = await this.db
      .update(asksTable)
      .set({ windowMissedCount: count })
      .where(eq(asksTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`Ask updateWindowMissedCount returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async updateForceImmediate(id: string, value: boolean): Promise<Ask> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    const rows = await this.db
      .update(asksTable)
      .set({ forceImmediate: value })
      .where(eq(asksTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`Ask updateForceImmediate returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async claimPrincipalPage(id: string, at: Date): Promise<{ claimed: boolean; ask: Ask }> {
    // Conditional on principal_paged_at IS NULL so the claim is atomic — two
    // concurrent callers cannot both win, and the loser learns it lost from the
    // empty returning() rather than from a racy pre-read.
    const rows = await this.db
      .update(asksTable)
      .set({ principalPagedAt: at })
      .where(and(eq(asksTable.id, id), isNull(asksTable.principalPagedAt)))
      .returning();

    const row = rows[0];
    if (row) {
      return { claimed: true, ask: toAsk(row) };
    }

    // No row updated: either the Ask does not exist, or it was already paged.
    // Distinguish them — "already paged" is a normal suppression the caller
    // logs, while a missing Ask is a programming error worth throwing on.
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }
    return { claimed: false, ask: existing };
  }

  async countPrincipalPagesSince(since: Date): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(asksTable)
      .where(gte(asksTable.principalPagedAt, since));

    // Coerce explicitly. Postgres COUNT is bigint, and whether the driver hands
    // it back as a number or a string is a driver/version detail this method's
    // `Promise<number>` signature should not be quietly relying on. The
    // consumer compares it against a numeric ceiling; a string would compare
    // correctly today by JS coercion and break the moment anyone does
    // arithmetic on it. Number() makes the boundary honest either way.
    return Number(rows[0]?.value ?? 0);
  }

  async updateRoutingTarget(id: string, target: string): Promise<Ask> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    const rows = await this.db
      .update(asksTable)
      .set({ routingTarget: target })
      .where(eq(asksTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`Ask updateRoutingTarget returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async updateContent(id: string, fields: EditAskFields): Promise<Ask> {
    const updates: Partial<AskInsert> = {};
    if (fields.title !== undefined) updates.title = fields.title;
    if (fields.question !== undefined) updates.question = fields.question;
    if (fields.options !== undefined) updates.options = fields.options as AskInsert["options"];
    if (fields.contextRefs !== undefined) {
      updates.contextRefs = fields.contextRefs as AskInsert["contextRefs"];
    }
    if (fields.metadata !== undefined) updates.metadata = fields.metadata;
    if (Object.keys(updates).length === 0) {
      throw new Error(`Ask updateContent: no fields to update for ${id}`);
    }

    // Optimistic concurrency: only touch a row that is still non-terminal.
    // MUST NOT change `state` — see the interface contract (mt#2668).
    const rows = await this.db
      .update(asksTable)
      .set(updates)
      .where(
        and(eq(asksTable.id, id), notInArray(asksTable.state, TERMINAL_ASK_STATES as AskState[]))
      )
      .returning();

    if (rows.length === 0) {
      // Disambiguate: not-found vs. terminal-state.
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`Ask not found: ${id}`);
      }
      throw new Error(
        `Ask ${id} is in terminal state "${existing.state}" — content edits are not allowed on closed/cancelled/expired asks.`
      );
    }
    const row = rows[0];
    if (!row) {
      throw new Error(`Ask updateContent returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async persistRouteOutcome(id: string, outcome: RouteOutcomeWrite): Promise<Ask> {
    // Validate the logical walk against the state-machine table first.
    guardRouteOutcomeWalk(outcome.state);

    const now = new Date();
    const updates: Partial<AskInsert> = { state: outcome.state };
    if (outcome.routingTarget !== undefined) {
      updates.routingTarget = outcome.routingTarget;
    }
    if (outcome.state === "routed") {
      updates.routedAt = now;
    } else if (outcome.state === "suspended") {
      updates.routedAt = now;
      updates.suspendedAt = now;
    } else if (outcome.state === "closed") {
      updates.routedAt = now;
      updates.respondedAt = now;
      updates.closedAt = now;
      updates.response = outcome.response as AskInsert["response"];
    } else if (outcome.state === "expired") {
      updates.closedAt = now;
    }

    // Optimistic concurrency: only advance a row still in "detected".
    const rows = await this.db
      .update(asksTable)
      .set(updates)
      .where(and(eq(asksTable.id, id), eq(asksTable.state, "detected")))
      .returning();

    if (rows.length === 0) {
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`Ask not found: ${id}`);
      }
      throw new ConcurrentTransitionError(id, existing.state, "detected");
    }
    const row = rows[0];
    if (!row) {
      throw new Error(`Ask persistRouteOutcome returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async countByState(): Promise<Record<AskState, number>> {
    const rows = await this.db
      .select({ state: asksTable.state, count: sql<number>`count(*)::int` })
      .from(asksTable)
      .groupBy(asksTable.state);

    const counts = Object.fromEntries(ALL_ASK_STATES.map((s) => [s, 0])) as Record<
      AskState,
      number
    >;
    for (const row of rows) {
      if ((ALL_ASK_STATES as readonly string[]).includes(row.state)) {
        counts[row.state as AskState] = Number(row.count);
      }
    }
    return counts;
  }

  async openStateAgeStats(opts: {
    nowMs: number;
    stallThresholdMs: number;
  }): Promise<Record<OpenAskState, AskAgeStats>> {
    const nowIso = new Date(opts.nowMs).toISOString();

    // When the row entered its CURRENT state. `routed`/`suspended`/`responded`
    // each carry their own stamp; `detected` and `classified` have no column, so
    // creation IS state entry for them. The COALESCE also covers a row whose
    // stamp is NULL because it predates that column.
    const stateSince = sql`coalesce(
      case ${asksTable.state}
        when 'routed' then ${asksTable.routedAt}
        when 'suspended' then ${asksTable.suspendedAt}
        when 'responded' then ${asksTable.respondedAt}
      end,
      ${asksTable.createdAt}
    )`;
    const ageMs = sql`(extract(epoch from (${nowIso}::timestamptz - ${stateSince})) * 1000)`;

    // `max()` and `count()` come back as strings from postgres-js for the
    // numeric/bigint result types, hence the Number() coercions below.
    const rows = await this.db
      .select({
        state: asksTable.state,
        oldestAgeMs: sql<string | null>`max(${ageMs})`,
        stalledCount: sql<string>`count(*) filter (where ${ageMs} > ${opts.stallThresholdMs})`,
      })
      .from(asksTable)
      .where(inArray(asksTable.state, [...OPEN_ASK_STATES]))
      .groupBy(asksTable.state);

    const stats = emptyOpenStateAgeStats();
    for (const row of rows) {
      if (!(OPEN_ASK_STATES as readonly string[]).includes(row.state)) continue;
      stats[row.state as OpenAskState] = {
        // Deliberately NOT clamped at zero: a negative age means this process's
        // clock is behind the stamp Postgres wrote, and clamping would render
        // clock skew as a healthy zero.
        oldestAgeMs: row.oldestAgeMs === null ? null : Math.round(Number(row.oldestAgeMs)),
        stalledCount: Number(row.stalledCount),
      };
    }
    return stats;
  }
}

// ---------------------------------------------------------------------------
// FakeAskRepository — hermetic test double
// ---------------------------------------------------------------------------

/**
 * In-memory `AskRepository` for hermetic unit tests.
 *
 * Implements the full `AskRepository` interface using a `Map<string, Ask>`.
 * No I/O of any kind — safe to use in CI and on developer laptops without
 * any database configuration.
 *
 * State-machine enforcement is identical to the production implementation:
 * both call `guardTransition`, so invalid-transition tests are meaningful.
 *
 * @example
 *   const repo = new FakeAskRepository();
 *   const ask = await repo.create({ ... });
 *   await repo.transition(ask.id, "classified");
 */
export class FakeAskRepository implements AskRepository {
  private readonly store = new Map<string, Ask>();
  private idCounter = 0;

  /** Current snapshot of all stored Asks (for test assertions). */
  get all(): Ask[] {
    return Array.from(this.store.values());
  }

  /** Clear all stored Asks (useful in beforeEach). */
  clear(): void {
    this.store.clear();
    this.idCounter = 0;
  }

  /**
   * Insert a fully-formed Ask directly, bypassing `create` (test seam, mt#4361).
   *
   * `create` stamps `createdAt` from the wall clock and `transition` stamps the
   * per-state columns the same way, so a fixture of asks with DIFFERENT ages —
   * the entire subject of `openStateAgeStats` — cannot be built through the
   * normal path. Injecting a clock into the QUERY does not help: one `nowMs`
   * ages every row written in the same millisecond identically.
   *
   * A seam rather than a mutation through the `all` getter, which happens to
   * return live references today and would silently stop working the day it
   * returns copies.
   */
  seed(ask: Ask): void {
    this.store.set(ask.id, ask);
  }

  async create(input: CreateAskInput): Promise<Ask> {
    const id = `fake-ask-${++this.idCounter}`;
    // Mirrors DrizzleAskRepository's minting (mt#2965): sequential ask#N,
    // no tombstones (fake store never retains deleted rows anyway).
    const shortId = formatShortId("ask", this.idCounter);
    const now = new Date().toISOString();
    const ask: Ask = {
      id,
      shortId,
      kind: input.kind,
      classifierVersion: input.classifierVersion,
      state: "detected",
      requestor: input.requestor,
      routingTarget: input.routingTarget,
      parentTaskId: input.parentTaskId,
      parentSessionId: input.parentSessionId,
      projectId: input.projectId,
      title: input.title,
      question: input.question,
      options: input.options,
      contextRefs: input.contextRefs,
      response: undefined,
      deadline: input.deadline,
      createdAt: now,
      // Service-window fields (mt#1411 spine — mt#1488)
      serviceStrategy: input.serviceStrategy,
      windowKey: input.windowKey,
      windowMissedCount: input.windowMissedCount ?? 0,
      forceImmediate: input.forceImmediate ?? false,
      // Severity transport binding (mt#3595). principalPagedAt is deliberately
      // NOT initialized from input — same rule as the Drizzle backend: only
      // claimPrincipalPage writes it.
      severity: input.severity,
      // Mirrors the Drizzle backend's reservation (PR #3162 R1) — the fake must
      // not be more permissive than the real thing, or a test would pass against
      // behaviour production does not have. mt#4331 extends that same parity to
      // `sanitizeMetadata`: a fake that filtered fewer keys than the Drizzle
      // backend would let a pollution test pass against behaviour production
      // does not have — the double becoming the assertion target instead of the
      // behavior (ADR-036), which is the argument this comment already makes for
      // the provenance keys.
      metadata: stripReservedProvenanceKeys(sanitizeMetadata(input.metadata ?? {})),
    };
    this.store.set(id, ask);
    return { ...ask };
  }

  async getById(id: string): Promise<Ask | null> {
    const direct = this.store.get(id);
    if (direct) return { ...direct };
    // Parity with the Drizzle backend, which resolves an `ask#N` short id (and
    // a uuid prefix) through `askIdWhere` (mt#4095). A fake that only matched
    // the uuid would let a short-id lookup test pass against behavior the fake
    // never had, or fail one the real backend handles — the double becoming the
    // assertion target instead of the behavior (ADR-036).
    const byShortId = this.all.find((a) => a.shortId === id);
    if (byShortId) return { ...byShortId };
    if (id.length >= 8) {
      const byPrefix = this.all.filter((a) => a.id.startsWith(id));
      // A uuid prefix is only an id when it is UNAMBIGUOUS, matching the
      // real backend's single-row semantics.
      if (byPrefix.length === 1 && byPrefix[0]) return { ...byPrefix[0] };
    }
    return null;
  }

  async claimPrincipalPage(id: string, at: Date): Promise<{ claimed: boolean; ask: Ask }> {
    const ask = this.store.get(id);
    if (!ask) {
      throw new Error(`Ask not found: ${id}`);
    }
    // Mirror the Drizzle backend's conditional write: only the first caller
    // wins. A fake that always claimed would make the idempotency test pass
    // against a repository that cannot actually enforce it.
    if (ask.principalPagedAt) {
      return { claimed: false, ask: { ...ask } };
    }
    const updated: Ask = { ...ask, principalPagedAt: at.toISOString() };
    this.store.set(id, updated);
    return { claimed: true, ask: { ...updated } };
  }

  async countPrincipalPagesSince(since: Date): Promise<number> {
    return this.all.filter(
      (a) => a.principalPagedAt !== undefined && new Date(a.principalPagedAt) >= since
    ).length;
  }

  async listByParentTask(taskId: string): Promise<Ask[]> {
    return this.all.filter((a) => a.parentTaskId === taskId).map((a) => ({ ...a }));
  }

  async listByParentSession(sessionId: string): Promise<Ask[]> {
    return this.all.filter((a) => a.parentSessionId === sessionId).map((a) => ({ ...a }));
  }

  async listByState(state: AskState, projectScope?: ProjectScope): Promise<Ask[]> {
    // Project-scope filter (ADR-021, mt#2563) — faithful to the Drizzle backend:
    // when projectScope is a uuid (not ALL_PROJECTS / undefined), restrict to
    // Asks stamped with that project_id. Unscoped Asks (projectId undefined) are
    // excluded from a uuid-scoped read, matching the SQL `project_id = scope`.
    const scoped = projectScope !== undefined && !isAllProjects(projectScope);
    return this.all
      .filter((a) => a.state === state && (!scoped || a.projectId === projectScope))
      .map((a) => ({ ...a }));
  }

  async listByClassifierVersion(version: string): Promise<Ask[]> {
    return this.all.filter((a) => a.classifierVersion === version).map((a) => ({ ...a }));
  }

  async listByStatesForRoutingTarget(params: {
    states: AskState[];
    routingTarget: string;
    limit: number;
    projectScope?: ProjectScope;
  }): Promise<{ asks: Ask[]; total: number }> {
    const { states, routingTarget, limit, projectScope } = params;
    if (states.length === 0) return { asks: [], total: 0 };

    const scoped = projectScope !== undefined && !isAllProjects(projectScope);
    const matched = this.all.filter(
      (a) =>
        states.includes(a.state) &&
        a.routingTarget === routingTarget &&
        (!scoped || a.projectId === projectScope)
    );
    // Mirrors the Drizzle backend's COALESCE ordering — a fake that returned
    // insertion order would let an ordering regression pass its tests.
    const concludedAt = (a: Ask) => a.closedAt ?? a.respondedAt ?? a.createdAt;
    matched.sort((a, b) => concludedAt(b).localeCompare(concludedAt(a)));

    return { asks: matched.slice(0, limit).map((a) => ({ ...a })), total: matched.length };
  }

  async listShortIdsForRoutingTarget(params: {
    routingTarget: string;
    projectScope?: ProjectScope;
  }): Promise<{ shortId: string; id: string }[]> {
    const { routingTarget, projectScope } = params;
    const scoped = projectScope !== undefined && !isAllProjects(projectScope);
    return this.all
      .filter(
        (a) =>
          a.routingTarget === routingTarget &&
          Boolean(a.shortId) &&
          (!scoped || a.projectId === projectScope)
      )
      .map((a) => ({ shortId: a.shortId as string, id: a.id }));
  }

  async findOpenByTaskIds(taskIds: string[]): Promise<Ask[]> {
    if (taskIds.length === 0) return [];
    const taskIdSet = new Set(taskIds);
    return this.all
      .filter(
        (a) => a.parentTaskId !== undefined && taskIdSet.has(a.parentTaskId) && !isTerminal(a.state)
      )
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0))
      .map((a) => ({ ...a }));
  }

  async transition(id: string, to: AskState): Promise<Ask> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Enforce the state machine — same guard as Drizzle implementation.
    guardTransition(existing.state, to);

    const now = new Date().toISOString();
    const updated: Ask = { ...existing, state: to };

    if (to === "routed") updated.routedAt = now;
    else if (to === "suspended") updated.suspendedAt = now;
    else if (to === "responded") updated.respondedAt = now;
    else if (to === "closed" || to === "cancelled" || to === "expired") updated.closedAt = now;

    this.store.set(id, updated);
    return { ...updated };
  }

  async recordCancellation(id: string, record: Record<string, unknown>): Promise<boolean> {
    const existing = this.store.get(id);
    // Mirrors the Drizzle `where`: non-terminal rows only, and a miss is a
    // `false` return rather than a throw.
    if (!existing || isTerminal(existing.state)) return false;

    // Reads and writes in one synchronous step, which is this fake's equivalent
    // of the jsonb `||` the Drizzle implementation uses — the merge cannot
    // interleave with another caller.
    this.store.set(id, {
      ...existing,
      metadata: { ...(existing.metadata ?? {}), [CANCELLATION_METADATA_KEY]: record },
    });
    return true;
  }

  async respond(id: string, input: RespondAskInput): Promise<Ask> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Same guard as production.
    guardTransition(existing.state, "responded");

    const now = new Date().toISOString();
    const updated: Ask = {
      ...existing,
      state: "responded",
      response: input.response,
      respondedAt: now,
    };

    this.store.set(id, updated);
    return { ...updated };
  }

  async close(id: string, input: CloseAskInput): Promise<Ask> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Same guard as production.
    guardTransition(existing.state, "closed");

    const now = new Date().toISOString();
    const updated: Ask = {
      ...existing,
      state: "closed",
      response: input.response,
      closedAt: now,
      respondedAt: existing.respondedAt ?? now,
    };

    this.store.set(id, updated);
    return { ...updated };
  }

  async respondAndClose(
    id: string,
    _respondInput: RespondAskInput,
    closeInput: CloseAskInput
  ): Promise<Ask> {
    // Mirror the Drizzle backend's invariant enforcement: consult
    // guardTransition for both legs of the logical walk.
    guardTransition("suspended", "responded");
    guardTransition("responded", "closed");

    // Single-threaded fake — atomic by virtue of synchronous in-memory ops.
    // Mirrors the Drizzle backend's optimistic-concurrency check: refuses if
    // state is not "suspended" at the moment of the call.
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }
    if (existing.state !== "suspended") {
      throw new ConcurrentTransitionError(id, existing.state);
    }

    const now = new Date().toISOString();
    const updated: Ask = {
      ...existing,
      state: "closed",
      response: closeInput.response,
      respondedAt: now,
      closedAt: now,
    };

    this.store.set(id, updated);
    return { ...updated };
  }

  async updateWindowMissedCount(id: string, count: number): Promise<Ask> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    const updated: Ask = { ...existing, windowMissedCount: count };
    this.store.set(id, updated);
    return { ...updated };
  }

  async updateForceImmediate(id: string, value: boolean): Promise<Ask> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    const updated: Ask = { ...existing, forceImmediate: value };
    this.store.set(id, updated);
    return { ...updated };
  }

  async updateRoutingTarget(id: string, target: string): Promise<Ask> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    const updated: Ask = { ...existing, routingTarget: target };
    this.store.set(id, updated);
    return { ...updated };
  }

  async updateContent(id: string, fields: EditAskFields): Promise<Ask> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }
    // Mirror the Drizzle backend's non-terminal guard.
    if (isTerminal(existing.state)) {
      throw new Error(
        `Ask ${id} is in terminal state "${existing.state}" — content edits are not allowed on closed/cancelled/expired asks.`
      );
    }

    const updated: Ask = { ...existing };
    let touched = false;
    if (fields.title !== undefined) {
      updated.title = fields.title;
      touched = true;
    }
    if (fields.question !== undefined) {
      updated.question = fields.question;
      touched = true;
    }
    if (fields.options !== undefined) {
      updated.options = fields.options;
      touched = true;
    }
    if (fields.contextRefs !== undefined) {
      updated.contextRefs = fields.contextRefs;
      touched = true;
    }
    if (fields.metadata !== undefined) {
      updated.metadata = fields.metadata;
      touched = true;
    }
    if (!touched) {
      throw new Error(`Ask updateContent: no fields to update for ${id}`);
    }

    this.store.set(id, updated);
    return { ...updated };
  }

  async persistRouteOutcome(id: string, outcome: RouteOutcomeWrite): Promise<Ask> {
    // Same guard chain as production.
    guardRouteOutcomeWalk(outcome.state);

    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }
    // Same optimistic-concurrency semantics as the Drizzle WHERE clause.
    if (existing.state !== "detected") {
      throw new ConcurrentTransitionError(id, existing.state, "detected");
    }

    const now = new Date().toISOString();
    const updated: Ask = { ...existing, state: outcome.state };
    if (outcome.routingTarget !== undefined) {
      updated.routingTarget = outcome.routingTarget;
    }
    if (outcome.state === "routed") {
      updated.routedAt = now;
    } else if (outcome.state === "suspended") {
      updated.routedAt = now;
      updated.suspendedAt = now;
    } else if (outcome.state === "closed") {
      updated.routedAt = now;
      updated.respondedAt = now;
      updated.closedAt = now;
      updated.response = outcome.response;
    } else if (outcome.state === "expired") {
      updated.closedAt = now;
    }

    this.store.set(id, updated);
    return { ...updated };
  }

  async countByState(): Promise<Record<AskState, number>> {
    const counts = Object.fromEntries(ALL_ASK_STATES.map((s) => [s, 0])) as Record<
      AskState,
      number
    >;
    for (const ask of this.store.values()) {
      counts[ask.state] += 1;
    }
    return counts;
  }

  async openStateAgeStats(opts: {
    nowMs: number;
    stallThresholdMs: number;
  }): Promise<Record<OpenAskState, AskAgeStats>> {
    const stats = emptyOpenStateAgeStats();
    for (const ask of this.store.values()) {
      if (!(OPEN_ASK_STATES as readonly string[]).includes(ask.state)) continue;
      const ageMs = opts.nowMs - Date.parse(stateEntryIso(ask));
      // An unparseable stamp is malformed fixture data, not a zero-age ask.
      if (Number.isNaN(ageMs)) continue;
      const entry = stats[ask.state as OpenAskState];
      if (entry.oldestAgeMs === null || ageMs > entry.oldestAgeMs) entry.oldestAgeMs = ageMs;
      if (ageMs > opts.stallThresholdMs) entry.stalledCount += 1;
    }
    return stats;
  }

  /**
   * Test seam only — NOT on AskRepository interface or DrizzleAskRepository.
   *
   * Directly inserts an Ask at an arbitrary state, bypassing lifecycle guards.
   * Use only in tests that need to set up preconditions for invalid-transition
   * assertions where walking through valid transitions would be tedious.
   */
  _seedAtState(ask: Ask): void {
    this.store.set(ask.id, { ...ask });
  }
}
