/**
 * Resolve satisfied credential requests (mt#4030).
 *
 * The imperative shell around `./request`'s pure selectors: reads the pending
 * requests and the credential listing, and closes the requests whose credential
 * has appeared. Safe to run on a sweep tick — terminal rows are filtered out by
 * the selector, and the close is optimistic-concurrency-guarded, so a request
 * the principal declines under us is skipped rather than clobbered.
 *
 * **Why a sweep and not a callback on the add route.** The request must resolve
 * however the credential arrives: through the cockpit form, through
 * `config credentials add` in a terminal, or because it was already configured
 * before the request was filed. Presence is the whole signal, so there is no
 * second place for the principal to confirm.
 *
 * @see packages/domain/src/credentials/request.ts — the decision logic
 */
import { log } from "@minsky/shared/logger";

import type { Ask, AskState } from "../ask/types";
import type { AskRepository } from "../ask/repository";
import { listCredentials } from "./lifecycle";
import {
  CREDENTIAL_REQUEST_RESPONDER,
  selectPendingCredentialRequests,
  selectSatisfiedCredentialRequests,
  type ProviderPresence,
} from "./request";

/** Re-exported for existing importers; defined in `./request` beside the classifier that reads it. */
export { CREDENTIAL_REQUEST_RESPONDER } from "./request";

/**
 * States a pending request can be sitting in when the sweep finds it.
 *
 * **`routed` is where these actually live.** `buildCredentialRequestAsk` sets no
 * `serviceStrategy`, so the router takes the `asap` path and returns a
 * `RoutedAsk` — `suspended` is produced only for `scheduled` / `deadline-bound`
 * asks held for a service window (`../ask/router.ts`). Dropping `routed` here
 * would mean the sweep never fires for any credential request at all.
 */
const CANDIDATE_STATES: readonly AskState[] = ["routed", "suspended"];

/** Injected IO. Every member is replaceable, so the orchestration tests hermetically. */
export interface CredentialRequestResolverDeps {
  /** All asks that could be pending requests. */
  listCandidateAsks(): Promise<Ask[]>;
  /** Presence per provider, read back from the credential listing. */
  listPresence(): Promise<ProviderPresence[]>;
  /** Close one satisfied request. Throws if it is no longer closeable. */
  satisfy(ask: Ask, detail: string): Promise<void>;
}

/** What one resolver pass did. Ids only — never a credential, never a payload. */
export interface CredentialRequestResolution {
  /** Pending requests seen this pass. */
  pending: number;
  /** Ask ids closed as satisfied. */
  satisfied: string[];
  /** Ask ids that moved under us (declined, cancelled, expired) — left alone. */
  raced: string[];
}

/**
 * Close every pending credential request whose credential is now present.
 *
 * Idempotent: a second pass finds the rows terminal and does nothing.
 */
export async function resolveSatisfiedCredentialRequests(
  deps: CredentialRequestResolverDeps
): Promise<CredentialRequestResolution> {
  const pending = selectPendingCredentialRequests(await deps.listCandidateAsks());
  if (pending.length === 0) return { pending: 0, satisfied: [], raced: [] };

  const satisfied = selectSatisfiedCredentialRequests(pending, await deps.listPresence());

  const closed: string[] = [];
  const raced: string[] = [];
  for (const entry of satisfied) {
    try {
      await deps.satisfy(entry.ask, entry.detail);
      closed.push(entry.ask.id);
    } catch (err: unknown) {
      // A concurrent decline/cancel/expire is the expected loser here, not an
      // error to escalate: the request is settled either way and the credential
      // is already stored. Anything else is still recorded rather than
      // swallowed, so a genuinely broken close is visible.
      raced.push(entry.ask.id);
      log.warn("credential-request resolver: could not close a satisfied request", {
        askId: entry.ask.id,
        provider: entry.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { pending: pending.length, satisfied: closed, raced };
}

/**
 * Wire the resolver to the real ask repository and credential listing.
 *
 * `detail` is the provider's own last-validation line, never a value — the
 * agent's observable is a boolean plus that status string.
 */
export function createCredentialRequestResolverDeps(
  repo: AskRepository
): CredentialRequestResolverDeps {
  return {
    async listCandidateAsks() {
      const pages = await Promise.all(CANDIDATE_STATES.map((state) => repo.listByState(state)));
      return pages.flat();
    },

    async listPresence() {
      const listing = await listCredentials();
      return listing.map((entry) => ({
        provider: entry.provider,
        configured: entry.configured,
        ...(entry.lastValidationDetail ? { detail: entry.lastValidationDetail } : {}),
      }));
    },

    async satisfy(ask: Ask, detail: string) {
      const response = {
        responder: CREDENTIAL_REQUEST_RESPONDER,
        payload: { satisfied: true, detail },
      };

      // Walk the state machine's real edges rather than jumping to `closed`
      // (PR #3264 R2). `../ask/state-machine.ts` permits
      // `routed -> suspended | cancelled | expired` and `suspended -> responded`,
      // with `closed` reachable only from `responded`. A bare `close()` on a
      // routed row therefore THROWS — and this resolver's own catch would file
      // that as a "raced" close and warn, leaving the row routed so the next tick
      // repeats it forever: a satisfiable request that never resolves while
      // emitting a warning on every sweep. Exactly the silent stall this feature
      // exists to prevent.
      if (ask.state === "routed") {
        await repo.transition(ask.id, "suspended");
      }

      // `respondAndClose` is the legal `suspended -> responded -> closed` walk,
      // and carries the optimistic-concurrency guard: if the row moved under us
      // between the read and this write it throws rather than overwriting
      // whatever the principal just did, and the caller records a real race.
      await repo.respondAndClose(ask.id, { response }, { response });
    },
  };
}
