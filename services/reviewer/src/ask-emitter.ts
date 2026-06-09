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
 * `CreateAskInput`/`Ask` carry no native `severity` field and the `AsksPage`
 * badge derives from kind-priority, so "error" severity is carried in
 * `metadata` until/unless a first-class field is added.
 */

import { log } from "./logger";
import type { AskRepository, CreateAskInput } from "@minsky/domain/ask/repository";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

/**
 * Provenance tags for the directly-emitted Ask. These are NOT produced by a
 * classifier — the reviewer service emits them directly — so the
 * `classifierVersion` is a sentinel identifying the emit path.
 */
export const ASK_CLASSIFIER_VERSION = "reviewer-circuit-breaker/v1";
export const ASK_REQUESTOR = "minsky-reviewer-service";

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
 * Emits operator-routed Asks for reviewer-service failures.
 *
 * Implementations MUST be fail-open: a failure to emit an Ask must never crash
 * the caller (the sweep cycle). The production `DomainAskEmitter` catches all
 * errors internally and resolves with an `AskEmitOutcome` — it never rejects.
 * The caller uses the returned outcome to decide whether to dedup the circuit
 * (mark it `alerted`); see `AskEmitOutcome`.
 */
export interface AskEmitter {
  emitCircuitBreakerAlert(ctx: CircuitBreakerAlertContext): Promise<AskEmitOutcome>;
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
  constructor(private readonly repoProvider: () => Promise<AskRepository | null>) {}

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
}
