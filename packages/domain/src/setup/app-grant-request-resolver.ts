/**
 * Resolve satisfied App-grant requests (mt#4693).
 *
 * The imperative shell around `./app-grant-request`'s pure selectors and the
 * shared presence-backed orchestration: reads the pending requests, asks GitHub
 * which repositories each installation now covers, and closes the requests whose
 * grant has landed.
 *
 * **Why a sweep and not a callback.** There is nothing to call back from — the
 * grant happens on github.com, in a browser, with no webhook Minsky receives for
 * an installation-repository change it did not make. Coverage presence is the
 * whole signal, which also means an operator who granted access before the
 * request was filed, or who granted it by some other route, closes the request
 * with nothing to confirm.
 *
 * **The oracle is a live network call**, unlike the credential sibling's local
 * config read. Two properties of the shared resolver keep that affordable: it
 * short-circuits before calling the oracle at all when nothing is pending (which
 * is almost every tick), and it hands the oracle exactly the pending keys so
 * this module can issue ONE coverage fetch per distinct role rather than one per
 * request.
 *
 * @see packages/domain/src/ask/presence-backed-request.ts — the shared pattern
 * @see packages/domain/src/setup/app-grant-request.ts — the pure decision logic
 */
import { log } from "@minsky/shared/logger";
import type { AppGrantRequestPayload } from "@minsky/shared/app-grant-request";

import type { Ask, AskState } from "../ask/types";
import type { AskRepository } from "../ask/repository";
import {
  resolveSatisfiedPresenceRequests,
  type PresenceRequestResolution,
  type PresenceRequestResolverDeps,
  type PresenceSignal,
} from "../ask/presence-backed-request";
import type { GitHubAppTokenProvider } from "../auth/github-app-token-provider";
import type { TokenRole } from "../auth/token-provider";
import { APP_GRANT_REQUEST_RESPONDER, APP_GRANT_REQUEST_SHAPE } from "./app-grant-request";

/**
 * States a pending request can be sitting in when the sweep finds it.
 *
 * Both are reachable — see the identically-shaped comment in
 * `../credentials/request-resolver.ts` for the full citation chain. Do not
 * narrow this to whichever one you observe today.
 */
const CANDIDATE_STATES: readonly AskState[] = ["routed", "suspended"];

/** Injected IO for one resolver pass. */
export type AppGrantRequestResolverDeps = PresenceRequestResolverDeps<AppGrantRequestPayload>;

/** What one resolver pass did. Ids only. */
export type AppGrantRequestResolution = PresenceRequestResolution;

/**
 * Close every pending App-grant request whose repository is now covered.
 *
 * Idempotent: a second pass finds the rows terminal and does nothing.
 */
export async function resolveSatisfiedAppGrantRequests(
  deps: AppGrantRequestResolverDeps
): Promise<AppGrantRequestResolution> {
  return resolveSatisfiedPresenceRequests(deps, APP_GRANT_REQUEST_SHAPE);
}

/**
 * Build the coverage oracle: which of these (repo, role) pairs are covered NOW?
 *
 * **One fetch per distinct ROLE, not per request.** Coverage is a property of the
 * installation, so a single `getInstallationCoverage(role)` answers every pending
 * repo for that role.
 *
 * **A failed probe reports nothing rather than reporting absence.** Returning
 * `present: false` would be indistinguishable from a genuine "still not granted",
 * which is harmless here (the request simply stays open) — but returning nothing
 * keeps the failure visible in the log instead of silently looking like a normal
 * un-granted tick. Same distinction `checkAppCoverage` draws between `unknown`
 * and `not-covered`, for the same reason.
 */
export function createAppCoverageOracle(provider: GitHubAppTokenProvider) {
  return async function listCoveragePresence(
    pending: readonly AppGrantRequestPayload[]
  ): Promise<PresenceSignal<AppGrantRequestPayload>[]> {
    const roles = [...new Set(pending.map((p) => p.role))];
    const signals: PresenceSignal<AppGrantRequestPayload>[] = [];

    for (const role of roles) {
      const typedRole = role as TokenRole;
      if (!provider.isRoleConfigured(typedRole)) continue;

      let covered: { repositories: string[]; selection: "all" | "selected" };
      try {
        covered = await provider.getInstallationCoverage(typedRole);
      } catch (err) {
        // Probe failure, NOT absence. Logged so a persistently failing oracle is
        // visible rather than reading as a request nobody has answered.
        log.warn("app-grant resolver: coverage probe failed", {
          role,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      for (const entry of pending) {
        if (entry.role !== role) continue;
        const isCovered =
          covered.selection === "all" || covered.repositories.includes(entry.repo.toLowerCase());
        if (!isCovered) continue;
        signals.push({
          key: entry,
          present: true,
          detail:
            covered.selection === "all"
              ? "installation covers all repositories"
              : `installation now covers ${entry.repo}`,
        });
      }
    }

    return signals;
  };
}

/**
 * Wire the resolver to the real ask repository and a live App token provider.
 *
 * `detail` is a coverage status line, never a credential — this request kind has
 * no value to leak in the first place.
 */
export function createAppGrantRequestResolverDeps(
  repo: AskRepository,
  provider: GitHubAppTokenProvider
): AppGrantRequestResolverDeps {
  return {
    async listCandidateAsks(): Promise<Ask[]> {
      const pages = await Promise.all(CANDIDATE_STATES.map((state) => repo.listByState(state)));
      return pages.flat();
    },

    listPresence: createAppCoverageOracle(provider),

    async satisfy(ask: Ask, detail: string): Promise<void> {
      const response = {
        responder: APP_GRANT_REQUEST_RESPONDER,
        payload: { satisfied: true, detail },
      };

      // Walk the state machine's real edges rather than jumping to `closed`.
      // `../ask/state-machine.ts` permits `routed -> suspended | cancelled |
      // expired` and `suspended -> responded`, with `closed` reachable only from
      // `responded`. A bare close on a routed row THROWS — and the shared
      // resolver's catch would file that as a "raced" close and warn, leaving
      // the row routed so the next tick repeats it forever: a satisfiable
      // request that never resolves while warning on every sweep. Identical to
      // the credential resolver's walk, and for the identical reason (PR #3264 R2).
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
