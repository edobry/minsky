/**
 * Ask emitter for the reviewer service (mt#2363 / mt#1596 Phase 1).
 *
 * Routes reviewer non-retryable submission failures into the asks substrate so
 * they surface on the live cockpit `AsksPage` instead of landing only as a
 * Railway `log.error` line that nothing reads. This is the primary (Phase 1)
 * slice of mt#1596's family-level fix for the recurring "reviewer/service
 * failures surface only as logs/DB-rows nobody watches" pattern (R1 mt#1556,
 * R2 mt#1991, R3 the 2026-06-08 422-loop incident, mt#2350).
 *
 * ## Mechanism: direct domain imports, not MCP-over-HTTP
 *
 * The reviewer runs the asks domain code in-process. Following the mt#2121
 * pattern established by `asks-reconcile-scheduler.ts`, the emitter builds a
 * `DrizzleAskRepository` directly from the booted domain container's
 * persistence provider and calls `.create(...)`. The `MINSKY_MCP_*` env vars
 * are NOT used for this path.
 *
 * ## Why `repo.create` with an explicit `routingTarget: "operator"`
 *
 * The cockpit `GET /api/asks` handler surfaces only Asks where
 * `routingTarget === "operator" && !isTerminal(state)` (cockpit
 * `server.ts`). `DrizzleAskRepository.create` persists `routingTarget`
 * exactly as passed (`repository.ts` `toInsert`), so setting it to
 * `"operator"` here makes the Ask render on the operator surface. The
 * higher-level `createAsk` domain helper would instead run the kind through
 * the router, which maps `coordination.notify → "peer"/mesh` — that Ask would
 * never appear on `/api/asks`. So this path deliberately uses `repo.create`
 * directly, mirroring `asks-reconcile-scheduler.ts`.
 *
 * ## Severity
 *
 * Two different things are called "severity" here, and mt#2719 made the
 * distinction load-bearing:
 *
 *   - `metadata.severity: "error"` — the ORIGINAL, cosmetic one. The `AsksPage`
 *     badge derives from kind-priority, so this is display metadata and nothing
 *     reads it for routing. Both mt#2363 and mt#4881 emits carry it.
 *   - `severity: "incident"` — a FIRST-CLASS column since mt#3595
 *     (`CreateAskInput.severity`, `packages/domain/src/ask/repository.ts`). It
 *     means "a severity trigger fired AND remediation is operator-only", it
 *     forces operator routing in the router (mt#3851), and it is what makes an
 *     ask PAGE the principal rather than land in the inbox.
 *
 * The docblock here previously said `CreateAskInput` carries no native severity
 * field. That was true when this module was written and has been false since
 * mt#3595; it is corrected rather than deleted because the stale sentence is
 * exactly what would let a reader conclude the marker is unavailable.
 *
 * ## Why paging needs an explicit dispatch on THIS path
 *
 * Setting `severity: "incident"` is necessary and NOT sufficient here. The page
 * is fired by `pagePrincipalForAsk`, and until mt#2719 its only production
 * caller was `createAsk` in the command adapter — a function this module
 * deliberately does not use (see the section above). So a severity-marked ask
 * created through `repo.create` would have persisted the marker and paged
 * nobody: it typechecks, deploys, reports healthy, and is inert.
 *
 * mt#2719 moved that dispatch into the domain
 * (`@minsky/domain/ask/principal-page-dispatch`) so this module can call it
 * directly after `repo.create`. The ask carries `routingTarget: "operator"` at
 * insert, which is the other half the page decision requires.
 */

import { log } from "./logger";
import type { AskRepository, CreateAskInput } from "@minsky/domain/ask/repository";
import type { PrincipalPageDeps } from "@minsky/domain/ask/principal-page";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

/**
 * Provenance tags for the directly-emitted Ask. These are NOT produced by a
 * classifier — the reviewer service emits them directly — so the
 * `classifierVersion` is a sentinel identifying the emit path.
 */
export const ASK_CLASSIFIER_VERSION = "reviewer-circuit-breaker/v1";
/** Sentinel for the mt#4881 pre-submission failure path — a different emit point. */
export const REVIEW_FAILURE_CLASSIFIER_VERSION = "reviewer-pre-submit-failure/v1";
/** Sentinel for the mt#2719 operator-incident paging tier — a third emit point. */
export const OPERATOR_INCIDENT_CLASSIFIER_VERSION = "reviewer-operator-incident/v1";
export const ASK_REQUESTOR = "minsky-reviewer-service";

/**
 * Where the operator goes to clear a GitHub App auth failure (SC7).
 *
 * The App-settings index rather than a specific app URL: the reviewer's config
 * carries no app slug or id (`config.ts` has no `GITHUB_APP_*` key), so a
 * per-app deep link would have to be invented. This one is correct for whichever
 * app the installation actually uses.
 */
export const GITHUB_APP_SETTINGS_URL = "https://github.com/settings/apps";

/**
 * Billing pages per reviewer provider (SC7), for the credits-exhaustion class.
 *
 * Keyed by `REVIEWER_PROVIDER` (`config.ts` `REVIEWER_PROVIDERS`), because the
 * provider is configurable and paging the operator at the wrong vendor's billing
 * page is worse than paging with no link at all. The OpenAI entry matches the URL
 * the live 429 body itself carries (observed in the measured message recorded at
 * `failure-alert.test.ts`), so the two agree rather than merely coexisting.
 */
export const PROVIDER_BILLING_URLS: Readonly<Record<string, string>> = {
  openai: "https://platform.openai.com/settings/organization/billing",
  anthropic: "https://console.anthropic.com/settings/billing",
  google: "https://console.cloud.google.com/billing",
};

/**
 * Billing URL for a provider, or the generic guidance string when the provider is
 * unrecognized — never a wrong vendor's page, and never an empty link.
 */
export function providerBillingUrl(provider: string): string {
  return (
    PROVIDER_BILLING_URLS[provider] ??
    `(no billing URL on file for provider "${provider}" — check the provider's console)`
  );
}

/**
 * Outcome of an Ask-emit attempt. The caller uses this to decide whether to
 * mark the circuit `alerted` (the dedup flag):
 *   - "created" — the Ask was persisted; dedup it (don't re-emit).
 *   - "skipped" — no Ask substrate is wired (no container/DB); this is a
 *     PERMANENT condition for this deployment, so dedup it to avoid log spam.
 *   - "failed"  — the substrate is present but `repo.create` threw (likely
 *     TRANSIENT, e.g. a DB blip). Do NOT dedup — the next sweep cycle should
 *     retry so a recovered substrate still surfaces the alert.
 */
export type AskEmitOutcome = "created" | "skipped" | "failed";

/** Context for a tripped submission-failure circuit breaker (mt#2350). */
export interface CircuitBreakerAlertContext {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  errorClass: string;
  lastStatus: number | null;
  consecutiveCount: number;
  /** The open-circuit row id (for audit cross-reference). */
  circuitId: string;
}

/**
 * Context for a reviewer failure that never reached submission (mt#4881).
 *
 * Distinct from `CircuitBreakerAlertContext` above, which describes a failure
 * that DID reach `submitReview` and was recorded by the mt#2350 tracker. This one
 * describes the classes that die earlier — the model provider rejecting the
 * prompt, credit exhaustion, the GitHub diff 406, the tool-loop timeout — and so
 * carries a classified error plus the aggregation facts that separate a
 * repo-wide condition from a single deterministic PR failure.
 */
export interface ReviewFailureAlertContext {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  /** "reviewer" (server.ts) or "boot_recovery" (boot-recovery.ts). */
  stage: string;
  /** Machine-readable class from `failure-alert.ts`'s classifier. */
  errorClass: string;
  /** Operator-facing one-liner: what this class is and who can fix it. */
  errorSummary: string;
  /** The raw failure message, possibly empty (the mt#2465 class). */
  failureMessage: string;
  /** Occurrences of this class on THIS PR inside the window, including this one. */
  occurrencesOnPr: number;
  /** Distinct PRs hit by this class inside the window, including this one. */
  distinctPrsWithClass: number;
  /** True when the condition looks repo-wide rather than PR-specific. */
  systemic: boolean;
  /** Width of the aggregation window, in minutes. */
  windowMinutes: number;
}

/**
 * Emits operator-routed Asks for reviewer-service failures.
 *
 * Implementations MUST be fail-open: a failure to emit an Ask must never crash
 * the caller (the sweep cycle). The production `DomainAskEmitter` catches all
 * errors internally and resolves with an `AskEmitOutcome` — it never rejects.
 * The caller uses the returned outcome to decide whether to dedup the circuit
 * (mark it `alerted`); see `AskEmitOutcome`.
 */
/**
 * Context for a reviewer-wide condition that only the OPERATOR can clear (mt#2719).
 *
 * One context and one emit method for both sources, deliberately. mt#2719's own
 * 2026-07-31 extension makes the argument: sustained GitHub-auth failure and
 * sustained provider-credit exhaustion "are both 'the reviewer is structurally
 * unable to review, and only the operator can fix it'". They produce the same ask
 * shape, the same severity marker and the same page; only the prose and the
 * remediation URL differ. Two methods emitting identical shapes would be
 * duplication, so the source is a discriminant rather than a second method.
 *
 * Distinct from the two contexts above in the one way that matters: those describe
 * a failure of ONE review (they carry PR coordinates and route to the inbox), while
 * this describes a condition affecting EVERY review and carries no PR at all.
 */
export type OperatorIncidentContext =
  | {
      source: "github_auth";
      /** Consecutive auth-class failures observed when the tracker tripped. */
      consecutiveFailures: number;
      /** The tripping threshold, so the ask states its own basis. */
      threshold: number;
      /** Which sweeper observed the latest failure. */
      observedBy: string;
      /** The latest underlying error message. */
      lastError: string;
      /** Where the operator goes to fix it (SC7) — caller-supplied so it is testable. */
      remediationUrl: string;
    }
  | {
      source: "provider";
      /** Machine-readable class from `failure-alert.ts`'s classifier. */
      errorClass: string;
      /** Operator-facing one-liner: what this class is and who can fix it. */
      errorSummary: string;
      /** Occurrences of this class across all PRs in the window, including this one. */
      occurrencesInWindow: number;
      /** The escalation threshold this crossed. */
      threshold: number;
      /** Width of the aggregation window, in minutes. */
      windowMinutes: number;
      /** The latest underlying error message. */
      lastError: string;
      /** Where the operator goes to fix it (SC7) — caller-supplied so it is testable. */
      remediationUrl: string;
    };

export interface AskEmitter {
  emitCircuitBreakerAlert(ctx: CircuitBreakerAlertContext): Promise<AskEmitOutcome>;
  /**
   * mt#2719. Emits an `severity: "incident"` + `forceImmediate` ask for a
   * condition only the operator can clear, AND dispatches the principal page.
   *
   * Unlike the two methods above this one PAGES — see the module header for why
   * the marker alone would not have. Dedup is the CALLER's, as with
   * `emitReviewFailureAlert`: `auth-health.ts` pages once per trip via its
   * `tripped` flag, and `failure-alert.ts` pages once per threshold CROSSING.
   */
  emitOperatorIncidentAlert(ctx: OperatorIncidentContext): Promise<AskEmitOutcome>;
  /**
   * mt#4881. Dedup for this path is the CALLER's (`failure-alert.ts` suppresses
   * on a prior occurrence of the same class on the same PR inside its window) —
   * unlike `emitCircuitBreakerAlert`, whose `!open.alerted` guard lives in the
   * sweeper. mt#1596 flagged exactly this: these emit points "need their own
   * dedup design."
   */
  emitReviewFailureAlert(ctx: ReviewFailureAlertContext): Promise<AskEmitOutcome>;
}

/**
 * Build a lazy provider of `AskRepository` from the booted domain container.
 *
 * Mirrors the construction in `asks-reconcile-scheduler.ts` (mt#2121): pulls
 * the persistence provider out of the container, opens the DB connection, and
 * wraps it in a `DrizzleAskRepository`. Returns `null` when the container is
 * absent or the DB connection is unavailable, so callers can skip gracefully.
 */
export function makeContainerAskRepoProvider(
  container: AppContainerInterface | undefined
): () => Promise<AskRepository | null> {
  return async () => {
    if (!container) return null;
    const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
    const db = await persistenceProvider.getDatabaseConnection();
    if (!db) return null;
    const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");
    return new DrizzleAskRepository(db);
  };
}

/**
 * Production `AskEmitter` backed by an `AskRepository`.
 *
 * The repository is resolved lazily per emit via the injected `repoProvider`
 * (matching `asks-reconcile-scheduler.ts`, which builds the repo per tick) —
 * circuit-breaker trips are rare, so per-emit construction is cheap and avoids
 * holding a DB handle for the service lifetime.
 */
export class DomainAskEmitter implements AskEmitter {
  /**
   * @param repoProvider resolves the ask repository per emit (see class docblock).
   * @param pageDeps OPTIONAL injected delivery seam for the severity page
   *   (mt#2719). Omitted in production, where the domain dispatch builds the real
   *   one. Tests inject it for the same reason `createAsk` accepts one: the
   *   production deps resolve a persistence provider and would otherwise reach
   *   for infrastructure from a hermetic test (the mt#3557 class).
   */
  constructor(
    private readonly repoProvider: () => Promise<AskRepository | null>,
    private readonly pageDeps?: PrincipalPageDeps
  ) {}

  async emitCircuitBreakerAlert(ctx: CircuitBreakerAlertContext): Promise<AskEmitOutcome> {
    try {
      const repo = await this.repoProvider();
      if (!repo) {
        // No-container / DB-unavailable path: the sweeper still ran and logged
        // the structured `sweeper.circuit_breaker_tripped` event; we just can't
        // surface it as an Ask. Warn so the gap is operator-visible. Returning
        // "skipped" lets the caller dedup the circuit (this is a permanent
        // condition for a substrate-less deployment — retrying would only spam
        // the log every sweep cycle with no chance of success).
        log.warn("sweeper.circuit_breaker_ask_skipped_no_repo", {
          event: "sweeper.circuit_breaker_ask_skipped_no_repo",
          pr: ctx.prNumber,
          headSha: ctx.headSha,
          circuitId: ctx.circuitId,
          message:
            "Circuit-breaker tripped but the asks repository is unavailable " +
            "(domain container / DB not booted); skipped operator Ask creation.",
        });
        return "skipped";
      }

      const input: CreateAskInput = {
        kind: "coordination.notify",
        classifierVersion: ASK_CLASSIFIER_VERSION,
        requestor: ASK_REQUESTOR,
        routingTarget: "operator",
        title: `Reviewer submission circuit-breaker tripped — PR #${ctx.prNumber}`,
        question:
          `Reviewer review submission for ${ctx.owner}/${ctx.repo} PR #${ctx.prNumber} ` +
          `@ ${ctx.headSha} keeps failing with a non-retryable error (${ctx.errorClass}, ` +
          `status ${ctx.lastStatus ?? "unknown"}) after ${ctx.consecutiveCount} attempts; ` +
          `the sweeper has stopped retriggering it. Operator action required.`,
        metadata: {
          severity: "error",
          crossReference: "mt#2350",
          source: "reviewer-sweeper",
          pr: ctx.prNumber,
          headSha: ctx.headSha,
          errorClass: ctx.errorClass,
          lastStatus: ctx.lastStatus,
          consecutiveCount: ctx.consecutiveCount,
          circuitId: ctx.circuitId,
        },
      };

      const ask = await repo.create(input);
      log.info("sweeper.circuit_breaker_ask_created", {
        event: "sweeper.circuit_breaker_ask_created",
        askId: ask.id,
        pr: ctx.prNumber,
        headSha: ctx.headSha,
        circuitId: ctx.circuitId,
      });
      return "created";
    } catch (err: unknown) {
      // Fail-open: emitting the Ask is best-effort. A failure here must not
      // crash the sweep cycle (matches the existing circuit-lookup error
      // handling in sweeper.ts). Returning "failed" tells the caller NOT to
      // dedup the circuit, so the next sweep retries — a transient repo/DB
      // failure must not permanently suppress surfacing the alert (reviewer R1).
      log.error("sweeper.circuit_breaker_ask_failed", {
        event: "sweeper.circuit_breaker_ask_failed",
        pr: ctx.prNumber,
        headSha: ctx.headSha,
        circuitId: ctx.circuitId,
        error: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }
  }

  async emitReviewFailureAlert(ctx: ReviewFailureAlertContext): Promise<AskEmitOutcome> {
    try {
      const repo = await this.repoProvider();
      if (!repo) {
        log.warn("review_failure_ask_skipped_no_repo", {
          event: "review_failure_ask_skipped_no_repo",
          pr: ctx.prNumber,
          headSha: ctx.headSha,
          errorClass: ctx.errorClass,
          message:
            "Reviewer failure not surfaced as an Ask — the asks repository is unavailable " +
            "(domain container / DB not booted).",
        });
        return "skipped";
      }

      // The title carries the discriminator SC4 asks for, because the title is
      // what the operator reads in a list: a repo-wide condition and a single
      // deterministic PR failure need different urgency, and mt#1697 records
      // four unrelated causes collapsing into one identical non-signal.
      const title = ctx.systemic
        ? `Reviewer failing across ${ctx.distinctPrsWithClass} PRs — ${ctx.errorClass}`
        : `Reviewer failed before submitting — PR #${ctx.prNumber} (${ctx.errorClass})`;

      const scale = ctx.systemic
        ? `This class has hit ${ctx.distinctPrsWithClass} distinct PRs in the last ` +
          `${ctx.windowMinutes} minutes — it is a repo-wide condition, not one bad PR.`
        : `This class has hit ${ctx.occurrencesOnPr} time(s) on this PR and ` +
          `${ctx.distinctPrsWithClass} distinct PR(s) in the last ${ctx.windowMinutes} minutes.`;

      const input: CreateAskInput = {
        kind: "coordination.notify",
        classifierVersion: REVIEW_FAILURE_CLASSIFIER_VERSION,
        requestor: ASK_REQUESTOR,
        routingTarget: "operator",
        title,
        question:
          `The reviewer failed on ${ctx.owner}/${ctx.repo} PR #${ctx.prNumber} @ ${ctx.headSha} ` +
          `before it could submit a review, at stage "${ctx.stage}". ${ctx.errorSummary} ${scale} ` +
          `Underlying error: ${ctx.failureMessage || "(none recorded — see the row's stack)"}`,
        metadata: {
          severity: "error",
          crossReference: "mt#4881",
          source: "reviewer-failure-alert",
          pr: ctx.prNumber,
          owner: ctx.owner,
          repo: ctx.repo,
          headSha: ctx.headSha,
          stage: ctx.stage,
          errorClass: ctx.errorClass,
          occurrencesOnPr: ctx.occurrencesOnPr,
          distinctPrsWithClass: ctx.distinctPrsWithClass,
          systemic: ctx.systemic,
          windowMinutes: ctx.windowMinutes,
        },
      };

      const ask = await repo.create(input);
      log.info("review_failure_ask_created", {
        event: "review_failure_ask_created",
        askId: ask.id,
        pr: ctx.prNumber,
        headSha: ctx.headSha,
        errorClass: ctx.errorClass,
        systemic: ctx.systemic,
      });
      return "created";
    } catch (err: unknown) {
      // Fail-open, same contract as emitCircuitBreakerAlert above.
      log.error("review_failure_ask_failed", {
        event: "review_failure_ask_failed",
        pr: ctx.prNumber,
        headSha: ctx.headSha,
        errorClass: ctx.errorClass,
        error: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }
  }

  async emitOperatorIncidentAlert(ctx: OperatorIncidentContext): Promise<AskEmitOutcome> {
    try {
      const repo = await this.repoProvider();
      if (!repo) {
        log.warn("operator_incident_ask_skipped_no_repo", {
          event: "operator_incident_ask_skipped_no_repo",
          source: ctx.source,
          message:
            "Reviewer operator-incident not surfaced as an Ask — the asks repository is " +
            "unavailable (domain container / DB not booted). The caller's log line and the " +
            "alert sink remain the only record.",
        });
        return "skipped";
      }

      const input: CreateAskInput = {
        // `stuck.unblock`, NOT the `coordination.notify` the two emits above use.
        // Matched by semantics rather than by sibling proximity (mem#268): those
        // two REPORT a failure of one review, while this one says the service
        // cannot proceed at all until the operator acts. The kind does not affect
        // routing here — mt#3851 makes `severity: "incident"` force operator +
        // inbox for every kind — so this choice is purely about reading true on
        // the cockpit surface.
        kind: "stuck.unblock",
        classifierVersion: OPERATOR_INCIDENT_CLASSIFIER_VERSION,
        requestor: ASK_REQUESTOR,
        routingTarget: "operator",
        // The two fields are INDEPENDENT and neither gates the other (mem#843):
        // `severity` decides whether the principal is notified at all,
        // `forceImmediate` decides whether the ask waits for a service window.
        // Setting only the first yields a page pointing at a queued ask.
        severity: "incident",
        forceImmediate: true,
        title: buildOperatorIncidentTitle(ctx),
        question: buildOperatorIncidentQuestion(ctx),
        metadata: {
          severity: "error",
          crossReference: "mt#2719",
          source: "reviewer-operator-incident",
          incidentSource: ctx.source,
          remediationUrl: ctx.remediationUrl,
          ...(ctx.source === "github_auth"
            ? {
                consecutiveFailures: ctx.consecutiveFailures,
                threshold: ctx.threshold,
                observedBy: ctx.observedBy,
              }
            : {
                errorClass: ctx.errorClass,
                occurrencesInWindow: ctx.occurrencesInWindow,
                threshold: ctx.threshold,
                windowMinutes: ctx.windowMinutes,
              }),
        },
      };

      const ask = await repo.create(input);

      // The half that the severity marker alone does NOT buy on this path — see
      // the module header. Without it the row carries `severity: "incident"` and
      // nothing ever pages, which is indistinguishable from success at every
      // surface except the principal's phone.
      //
      // Fail-open by contract: `dispatchPrincipalPage` never throws and records
      // its own delivery failures durably (`ask.page_failed`), so a dead Telegram
      // channel costs the notification, never the ask.
      const { dispatchPrincipalPage } = await import("@minsky/domain/ask/principal-page-dispatch");
      await dispatchPrincipalPage(repo, ask, this.pageDeps);

      log.info("operator_incident_ask_created", {
        event: "operator_incident_ask_created",
        askId: ask.id,
        source: ctx.source,
        remediationUrl: ctx.remediationUrl,
      });
      return "created";
    } catch (err: unknown) {
      // Fail-open, same contract as the two emits above.
      log.error("operator_incident_ask_failed", {
        event: "operator_incident_ask_failed",
        source: ctx.source,
        error: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }
  }
}

// ---------------------------------------------------------------------------
// Operator-incident ask body (mt#2719)
// ---------------------------------------------------------------------------

/**
 * Title for an operator-incident ask.
 *
 * Pure and exported so the wording is assertable without a repository
 * (`testing-standards.mdc` §Testable Design — the decision is a function of its
 * inputs). It leads with the CONDITION rather than the service, because this is
 * what the principal reads on a phone notification.
 */
export function buildOperatorIncidentTitle(ctx: OperatorIncidentContext): string {
  return ctx.source === "github_auth"
    ? "Reviewer is down — GitHub App auth is failing"
    : `Reviewer is down — ${ctx.errorClass}`;
}

/** Body for an operator-incident ask. Pure, for the same reason as the title. */
export function buildOperatorIncidentQuestion(ctx: OperatorIncidentContext): string {
  const remediation =
    `Only you can clear this — the reviewer cannot recover on its own. ` +
    `Remediation: ${ctx.remediationUrl}`;

  if (ctx.source === "github_auth") {
    return (
      `The reviewer's GitHub App authentication has failed ` +
      `${ctx.consecutiveFailures} consecutive times (threshold ${ctx.threshold}), latest ` +
      `observed by ${ctx.observedBy}. Every session-level GitHub call is failing, so no PR ` +
      `is being reviewed. ${remediation} Latest error: ${ctx.lastError}`
    );
  }

  return (
    `The reviewer has failed ${ctx.occurrencesInWindow} times in the last ` +
    `${ctx.windowMinutes} minutes with "${ctx.errorClass}" (threshold ${ctx.threshold}), which ` +
    `means it is not a transient blip. ${ctx.errorSummary} No PR is being reviewed while this ` +
    `persists. ${remediation} Latest error: ${ctx.lastError}`
  );
}
