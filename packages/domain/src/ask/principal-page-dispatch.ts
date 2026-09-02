/**
 * Production dispatch for the severity → principal page (mt#2719).
 *
 * ## Why this module exists
 *
 * `principal-page.ts` holds the pure DECISION (should this ask page?) and the
 * message construction, with delivery injected. Somebody still has to supply the
 * production delivery seam and call it. Until mt#2719 that "somebody" was a pair
 * of private functions inside `src/adapters/shared/commands/asks.ts`, reachable
 * only from `createAsk` — which made the page an artifact of ONE call path rather
 * than a property of a severity-marked ask.
 *
 * That was invisible from the type: `CreateAskInput` carries `severity`, so any
 * producer could set `severity: "incident"`, typecheck clean, and page nobody.
 * The reviewer service is exactly such a producer — its `DomainAskEmitter` calls
 * `repo.create` directly (see that file's header for why) and never reaches
 * `createAsk`. Setting the marker there would have persisted a row that no paging
 * code reads: the mt#2435 shape — typechecks, deploys, healthy, inert.
 *
 * So the seam moved here, to the domain, where both producers can reach it:
 *
 *   - `createAsk` (`src/adapters/shared/commands/asks.ts`) — unchanged behaviour;
 *     it calls {@link dispatchPrincipalPage} exactly where it used to call its
 *     own private copy.
 *   - `services/reviewer/src/ask-emitter.ts` — the operator-only reviewer
 *     failures that mt#2719 escalates to a paging tier.
 *
 * Nothing about the page DECISION changed in the move; `pagePrincipalForAsk`
 * still requires both `severity` and operator routing.
 *
 * ## Why the whole dependency set was already domain-side
 *
 * Every collaborator these two functions need — `notifyPrincipal`,
 * `createRealPrincipalChannelDeps`, `resolvePersistenceProvider`,
 * `emitSystemEventFromProvider`, `pagePrincipalForAsk` — already lives in
 * `@minsky/domain`. The move therefore adds no coupling and removes an
 * adapter-layer dependency from the reviewer's reach; it is a relocation, not a
 * redesign.
 *
 * @see principal-page.ts — the pure decision this wires delivery to
 * @see mem#843 — the design record: `severity` drives notification,
 *      `forceImmediate` drives windowing; they are independent
 */

import { log } from "@minsky/shared/logger";
import { resolvePersistenceProvider } from "../persistence/factory";
import { emitSystemEventFromProvider } from "../events/emit-best-effort";
import { notifyPrincipal, createRealPrincipalChannelDeps } from "../notify/principal-channel";
import {
  PAGE_RATE_LIMIT_MAX,
  PAGE_RATE_LIMIT_WINDOW_MS,
  pagePrincipalForAsk,
  type PrincipalPageDeps,
} from "./principal-page";
import type { AskRepository } from "./repository";
import type { Ask } from "./types";

/**
 * Build the production delivery seam for the severity page.
 *
 * A factory rather than a constant so each dispatch gets a fresh closure and
 * tests can substitute the whole object at the caller's seam.
 */
export function makeProductionPageDeps(): PrincipalPageDeps {
  return {
    async send(message) {
      // Never reach the live channel from a test run (mt#3557 / mt#3538 class).
      // `notifyPrincipal` resolves credentials from the Pulumi stack when env
      // vars are absent, so an un-injected call here would spawn `pulumi` and
      // message the principal for real. That hazard WIDENED with mt#2719: this
      // seam is now reachable from the reviewer's emit path as well as from
      // `createAsk`, so more test paths can reach it than before.
      //
      // Reported as a LOUD non-delivery rather than a silent success: the
      // caller records it, so a test that genuinely expects delivery fails
      // visibly instead of passing against a no-op. A test that wants the real
      // decision path injects deps at its caller's seam.
      if (process.env.NODE_ENV === "test") {
        return {
          delivered: false,
          error:
            "suppressed-in-test: production page deps were used without injection — " +
            "inject page deps at the caller's seam to exercise this path",
        };
      }
      try {
        const result = await notifyPrincipal({
          message: message.message,
          title: message.title,
          ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
          // Explicit production wiring (ADR-026, mt#3609).
          deps: createRealPrincipalChannelDeps(),
        });
        return result.delivered
          ? { delivered: true }
          : // notifyPrincipal reports a structured failure (`reason` +
            // `detail`) rather than an `error` string — flatten both so the
            // recorded failure says WHICH failure it was, not just that one
            // happened. "not-configured" and "send-failed" want very different
            // operator responses.
            { delivered: false, error: `${result.reason}: ${result.detail}` };
      } catch (err: unknown) {
        return { delivered: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async recordFailure(ask, error) {
      // Log FIRST and unconditionally. The event row is best-effort by nature
      // (it needs a live DB, which may be the very thing that is broken), so it
      // cannot be the only record — a page failure that leaves no trace at all
      // is indistinguishable from an incident nobody reported.
      log.error("ask.page_failed: could not page the principal about a severity ask", {
        askId: ask.id,
        shortId: ask.shortId,
        error,
      });
      try {
        const provider = await resolvePersistenceProvider();
        await emitSystemEventFromProvider(provider ?? undefined, {
          eventType: "ask.page_failed",
          payload: { askId: ask.id, shortId: ask.shortId, error },
          ...(ask.parentTaskId === undefined ? {} : { relatedTaskId: ask.parentTaskId }),
        });
      } catch (err: unknown) {
        log.warn("ask.page_failed: event emission also failed (already logged above)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    now: () => new Date(),
  };
}

/**
 * Run the severity-page dispatch for an Ask that is already persisted.
 *
 * Swallow-by-design at this boundary, and the ONE place in these flows where
 * that is correct: `pagePrincipalForAsk` already records its own failures
 * durably, so anything escaping here is a defect in the page path itself — and
 * failing ask creation because a notification broke would destroy the decision
 * record to protect the reminder about it.
 *
 * **Call it only with a PERSISTED ask whose routing is settled.** The decision
 * reads `ask.routingTarget`, so an ask that has not routed yet reads as
 * not-operator-bound and would never page. `createAsk` satisfies this by calling
 * after `persistRouteOutcome`; the reviewer satisfies it by setting
 * `routingTarget: "operator"` explicitly at `repo.create`.
 */
export async function dispatchPrincipalPage(
  repo: AskRepository,
  ask: Ask,
  deps?: PrincipalPageDeps
): Promise<void> {
  try {
    const outcome = await pagePrincipalForAsk(ask, repo, deps ?? makeProductionPageDeps());
    if (outcome.reason === "rate-limited") {
      // Never a silent cap (`work-completion.mdc`): a suppressed page must say
      // so, with the count, or the ceiling reads as "nothing needed sending".
      log.warn("ask page suppressed by rate limit", {
        askId: ask.id,
        recentPageCount: outcome.recentPageCount,
        windowHours: PAGE_RATE_LIMIT_WINDOW_MS / (60 * 60 * 1000),
        max: PAGE_RATE_LIMIT_MAX,
      });
    }
  } catch (err: unknown) {
    log.error("ask page dispatch threw; ask creation is unaffected", {
      askId: ask.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
