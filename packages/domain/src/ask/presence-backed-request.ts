/**
 * The presence-backed request pattern (mt#4693 D4).
 *
 * An agent asks the principal to provision something it cannot provision itself,
 * and the request closes when the thing turns up — detected by POLLING a
 * presence oracle, never by the principal answering the ask. This module is that
 * pattern with the oracle and the payload left open.
 *
 * **Why this is extracted rather than copied.** It was written once for
 * credential requests (mt#4030) and is now needed a second time for GitHub App
 * grants (mt#4693). The `mt#4030 ↔ mt#4447` seam decision set the revisit
 * trigger at the THIRD payload consumer, and mt#4693 is it — but only the
 * RESOLVER generalizes. Declaration and render stay per-payload, because the
 * three controls (a masked entry form, an upload control, a status card and a
 * link) have nothing in common. See mt#4693 D4 for the costing.
 *
 * **What does NOT belong here.** mt#4447's file-upload request resolves on the
 * upload EVENT, because no presence oracle exists for an arbitrary file. It is
 * deliberately not a consumer of this module, and generalizing further to
 * accommodate it would rebuild the typed-payload framework mt#4030 ruled out.
 *
 * **Why presence and not the principal's click** — the property that makes the
 * whole pattern work, inherited from mt#4030: out-of-band satisfaction is free.
 * An operator who provisions the thing by another route, or who had already
 * provisioned it before the request was filed, closes the request with nothing
 * to click and no second place to confirm.
 */
import { log } from "@minsky/shared/logger";

import type { Ask, AskState } from "./types";

/**
 * Ask states in which a presence-backed request is still awaiting the principal.
 *
 * Terminal rows are excluded so a re-run cannot re-close an already-closed
 * request — that is what makes the resolver safe to call on every sweep tick.
 *
 * Both `routed` and `suspended` are reachable and neither may be dropped: an
 * ask's `serviceStrategy` decides which, and `deadline-bound` kinds land in
 * `suspended`. `packages/domain/src/credentials/request-resolver.ts` carries the
 * full citation chain for why.
 */
export const PENDING_REQUEST_STATES: readonly AskState[] = [
  "detected",
  "classified",
  "routed",
  "suspended",
];

/** Lookup set, kept private — `custom/no-domain-singleton` forbids exporting a constructed instance. */
const PENDING_REQUEST_STATE_SET: ReadonlySet<AskState> = new Set(PENDING_REQUEST_STATES);

/** Is this ask still awaiting the principal? */
export function isPendingRequestState(state: AskState): boolean {
  return PENDING_REQUEST_STATE_SET.has(state);
}

/** A pending request paired with the key it is waiting on. */
export interface PendingPresenceRequest<K> {
  readonly ask: Ask;
  readonly key: K;
}

/** One subject's presence signal, as read back from the oracle. */
export interface PresenceSignal<K> {
  readonly key: K;
  readonly present: boolean;
  /** The oracle's own status line — e.g. "3 buckets visible". NEVER a value. */
  readonly detail?: string;
}

/** A request whose subject is now present, and the detail to close it with. */
export interface SatisfiedPresenceRequest<K> {
  readonly ask: Ask;
  readonly key: K;
  readonly detail: string;
}

/** What one resolver pass did. Ids only — never a payload, never a value. */
export interface PresenceRequestResolution {
  /** Pending requests seen this pass. */
  readonly pending: number;
  /** Ask ids closed as satisfied. */
  readonly satisfied: string[];
  /** Ask ids that moved under us (declined, cancelled, expired) — left alone. */
  readonly raced: string[];
}

/** Injected IO. Every member is replaceable, so the orchestration tests hermetically. */
export interface PresenceRequestResolverDeps<K> {
  /** All asks that could be pending requests of this kind. */
  listCandidateAsks(): Promise<Ask[]>;
  /** Presence per subject, read back from the oracle. */
  listPresence(): Promise<PresenceSignal<K>[]>;
  /** Close one satisfied request. Throws if it is no longer closeable. */
  satisfy(ask: Ask, detail: string): Promise<void>;
  /**
   * Return the request's parent task to a walkable status.
   *
   * Only SATISFIED requests reach this. A declined, unanswered or policy-closed
   * request leaves its parent BLOCKED on purpose: a blocked task sits in the
   * operator's queue, which is where an unmet request belongs.
   */
  releaseParent?(ask: Ask): Promise<void>;
}

/** How a caller's payload maps onto this module's key-shaped world. */
export interface PresenceRequestShape<K> {
  /** Log label, e.g. `credential-request`. Appears in the raced-close warning. */
  readonly label: string;
  /** Read this request kind's key off an ask, or null when it is not one. */
  readKey(ask: Ask): K | null;
  /** Stable string identity for a key, so pending and presence can be matched. */
  identity(key: K): string;
  /** Detail recorded when the oracle reports presence without a status line. */
  readonly defaultDetail: string;
}

/**
 * Select the still-open requests of one kind from a set of asks.
 */
export function selectPendingPresenceRequests<K>(
  asks: readonly Ask[],
  shape: Pick<PresenceRequestShape<K>, "readKey">
): PendingPresenceRequest<K>[] {
  const pending: PendingPresenceRequest<K>[] = [];
  for (const ask of asks) {
    if (!isPendingRequestState(ask.state)) continue;
    const key = shape.readKey(ask);
    if (key !== null) pending.push({ ask, key });
  }
  return pending;
}

/**
 * Decide which pending requests are now satisfied.
 *
 * A signal with `present: false` is NOT a match — absence is the default state
 * of an unsatisfied request, not a reason to close it.
 */
export function selectSatisfiedPresenceRequests<K>(
  pending: readonly PendingPresenceRequest<K>[],
  presence: readonly PresenceSignal<K>[],
  shape: Pick<PresenceRequestShape<K>, "identity" | "defaultDetail">
): SatisfiedPresenceRequest<K>[] {
  const present = new Map<string, PresenceSignal<K>>();
  for (const entry of presence) {
    if (entry.present) present.set(shape.identity(entry.key), entry);
  }

  const satisfied: SatisfiedPresenceRequest<K>[] = [];
  for (const { ask, key } of pending) {
    const hit = present.get(shape.identity(key));
    if (!hit) continue;
    satisfied.push({ ask, key, detail: hit.detail ?? shape.defaultDetail });
  }
  return satisfied;
}

/**
 * Close every pending request whose subject is now present.
 *
 * Idempotent: a second pass finds the rows terminal and does nothing.
 */
export async function resolveSatisfiedPresenceRequests<K>(
  deps: PresenceRequestResolverDeps<K>,
  shape: PresenceRequestShape<K>
): Promise<PresenceRequestResolution> {
  const pending = selectPendingPresenceRequests(await deps.listCandidateAsks(), shape);
  if (pending.length === 0) return { pending: 0, satisfied: [], raced: [] };

  const satisfied = selectSatisfiedPresenceRequests(pending, await deps.listPresence(), shape);

  const closed: string[] = [];
  const raced: string[] = [];
  for (const entry of satisfied) {
    try {
      await deps.satisfy(entry.ask, entry.detail);
      closed.push(entry.ask.id);

      // AFTER the close, and deliberately so: a release failure must not
      // un-close the request. The subject is provisioned and the ask is settled,
      // so the task status is the last and least consequential step — and
      // running it BEFORE the close would leave a raced close with a task
      // released against a request that is still open.
      await deps.releaseParent?.(entry.ask);
    } catch (err: unknown) {
      // A concurrent decline/cancel/expire is the expected loser here, not an
      // error to escalate: the request is settled either way. Anything else is
      // still recorded rather than swallowed, so a genuinely broken close is
      // visible.
      raced.push(entry.ask.id);
      log.warn(`${shape.label} resolver: could not close a satisfied request`, {
        askId: entry.ask.id,
        key: shape.identity(entry.key),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { pending: pending.length, satisfied: closed, raced };
}
