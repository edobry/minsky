/**
 * Recurring stale-suspended-ask close sweep (mt#3001).
 *
 * Every earlier closure mechanism for `authorization.approve` /
 * `quality.review` asks is either same-call (mt#2593 commit-success and
 * PR-merge emit-site closes) or point-in-time (mt#2747 / mt#2760 backfills),
 * so asks that leak past those — failed-commit orphans, gh#-parented asks,
 * debris created between sweeps — sit in `suspended` forever and pollute the
 * operator inbox. This module is the recurring reconciliation layer that
 * retires them.
 *
 * ## Covers
 *   - Suspended asks whose parent task has since reached a terminal status
 *     (`authorization.approve` AND `quality.review`) — the mt#2760 backfill
 *     semantics made recurring. Coverage of gh#-parented asks depends on the
 *     caller-supplied status map (multi-backend task service); asks whose
 *     parent never resolves fall through to the commit-auth TTL below.
 *   - Failed-commit orphan asks: a commit-auth ask whose session later landed
 *     a NEWER commit (a later commit-auth ask from the same session reached
 *     `closed`) — the session moved past the failed attempt.
 *   - Abandoned commit-auth asks older than the TTL — the `suspended`-stage
 *     extension of the mt#2265 advancement-sweep expiry ("ephemeral
 *     authorization/review requests whose moment has passed").
 *
 * ## Does NOT cover
 *   - `direction.decide` and every other kind — never touched.
 *   - Non-commit `authorization.approve` asks (no `metadata.commitMessage`,
 *     e.g. credential-rotation approvals): parent-terminal is their ONLY
 *     close signal — supersession and TTL never apply to them.
 *   - Emission-side behavior (what gets emitted at all) — owned by mt#1241.
 *
 * ## Invocation path
 * `startStaleAskCloseSweeper` (src/cockpit/sweepers.ts) runs this in the
 * cockpit daemon on a 15-minute cadence, building the task-status map from
 * the server task service. All operations are best-effort: a failure on one
 * ask never stops the sweep, and a missing/empty status map degrades safely
 * (parent-terminal closes nothing; supersession and TTL still apply).
 */

import { log } from "@minsky/shared/logger";
import type { Ask } from "./types";
import type { AskRepository } from "./repository";
import { closeAskAsResolved } from "./close-as-resolved";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * TTL for abandoned commit-auth asks, mirroring the advancement sweep's
 * `DEFAULT_MAX_DETECTED_AGE_MS` (mt#2265): a commit-authorization request a
 * week old is unambiguously abandoned (CLAUDE.md §Thresholds).
 */
export const DEFAULT_STALE_COMMIT_AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-sweep batch cap — bounds a single sweep's DB work. */
export const DEFAULT_STALE_CLOSE_BATCH_LIMIT = 200;

/** Responder recorded when a parent task's terminal status resolves the ask. */
export const RESPONDER_PARENT_TERMINAL = "system:parent-task-terminal";

/** Responder recorded when a later landed commit supersedes a failed attempt. */
export const RESPONDER_SUPERSEDED = "system:superseded-by-later-commit";

/**
 * Task statuses that mean the ask's triggering work has resolved. Matches
 * scripts/backfill-close-stale-asks.ts (mt#2760). Membership is checked
 * case-insensitively (PR #2146 R1): non-minsky backends report lowercase
 * states (e.g. a GitHub issue's "closed"), and a case miss here silently
 * exempts exactly the gh#-parented asks this sweep exists to cover.
 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["DONE", "CLOSED", "COMPLETED"]);

const KIND_AUTH_APPROVE = "authorization.approve";
const KIND_QUALITY_REVIEW = "quality.review";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Options for one sweep pass. */
export interface StaleSuspendedCloseOptions {
  /**
   * Task id → status map for parent-terminal classification. An empty map is
   * safe: no parent-terminal close fires (missing entries are treated as
   * not-terminal, never as terminal).
   */
  taskStatusById: ReadonlyMap<string, string>;
  /** Clock override for tests; defaults to `Date.now()`. */
  nowMs?: number;
  /** TTL override for tests; defaults to {@link DEFAULT_STALE_COMMIT_AUTH_TTL_MS}. */
  ttlMs?: number;
  /** Batch cap override; defaults to {@link DEFAULT_STALE_CLOSE_BATCH_LIMIT}. */
  batchLimit?: number;
}

/** Outcome counts for one sweep pass. */
export interface StaleSuspendedCloseOutcome {
  /** Suspended asks examined this pass (after the batch cap). */
  scanned: number;
  /** Closed because the parent task is terminal. */
  closedParentTerminal: number;
  /** Closed because a later commit-auth ask from the same session landed. */
  closedSuperseded: number;
  /** Expired because the commit-auth ask outlived the TTL. */
  expiredTtl: number;
  /** Examined and deliberately left open. */
  untouched: number;
  /** Per-ask failures (logged, never thrown). */
  errors: number;
  /** Suspended asks beyond the batch cap, deferred to the next pass. */
  deferred: number;
}

/** Disposition of a single suspended ask. */
type StaleDisposition = "close-parent-terminal" | "close-superseded" | "expire-ttl" | "keep";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * A commit-auth ask is an `authorization.approve` ask carrying the
 * `metadata.commitMessage` the `sessionCommit` emit site stamps
 * (packages/domain/src/session/session-commands.ts) — a designed-for-purpose
 * marker, not a title heuristic.
 */
export function isCommitAuthAsk(ask: Ask): boolean {
  return ask.kind === KIND_AUTH_APPROVE && typeof ask.metadata?.["commitMessage"] === "string";
}

function isParentTerminal(ask: Ask, taskStatusById: ReadonlyMap<string, string>): boolean {
  if (!ask.parentTaskId) return false;
  const status = taskStatusById.get(ask.parentTaskId);
  return status !== undefined && TERMINAL_TASK_STATUSES.has(status.toUpperCase());
}

/**
 * True when a LATER commit-auth ask from the same session reached `closed` —
 * the session landed a newer commit, so this ask's moment has passed. This is
 * exactly the failed-commit orphan pattern (mt#2935's own PR left two of
 * these): the retry got a NEW ask that closed on success; the orphan stayed.
 *
 * `sessionSiblingsCache` memoizes the per-session sibling listing for the
 * duration of one sweep pass, so N orphans from one session cost one query.
 */
async function isSupersededByLaterLandedCommit(
  repo: AskRepository,
  ask: Ask,
  sessionSiblingsCache: Map<string, Ask[]>
): Promise<boolean> {
  if (!ask.parentSessionId) return false;
  let siblings = sessionSiblingsCache.get(ask.parentSessionId);
  if (siblings === undefined) {
    try {
      siblings = await repo.listByParentSession(ask.parentSessionId);
    } catch {
      return false; // best-effort: an unreadable sibling set never closes anything
    }
    sessionSiblingsCache.set(ask.parentSessionId, siblings);
  }
  const askCreatedMs = Date.parse(ask.createdAt);
  return siblings.some(
    (sibling) =>
      sibling.id !== ask.id &&
      sibling.state === "closed" &&
      isCommitAuthAsk(sibling) &&
      Date.parse(sibling.createdAt) > askCreatedMs
  );
}

async function classify(
  repo: AskRepository,
  ask: Ask,
  taskStatusById: ReadonlyMap<string, string>,
  nowMs: number,
  ttlMs: number,
  sessionSiblingsCache: Map<string, Ask[]>
): Promise<StaleDisposition> {
  if (ask.kind === KIND_QUALITY_REVIEW) {
    return isParentTerminal(ask, taskStatusById) ? "close-parent-terminal" : "keep";
  }
  if (ask.kind !== KIND_AUTH_APPROVE) return "keep";
  if (isParentTerminal(ask, taskStatusById)) return "close-parent-terminal";
  // Non-commit authorization asks (credential rotations, canary approvals)
  // close on parent-terminal ONLY — never by supersession or TTL.
  if (!isCommitAuthAsk(ask)) return "keep";
  if (await isSupersededByLaterLandedCommit(repo, ask, sessionSiblingsCache)) {
    return "close-superseded";
  }
  const ageMs = nowMs - Date.parse(ask.createdAt);
  if (Number.isFinite(ageMs) && ageMs > ttlMs) return "expire-ttl";
  return "keep";
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * Run one stale-suspended-ask close pass. Never throws; every failure is
 * counted and logged. Idempotent — an ask another actor already closed is a
 * no-op (`closeAskAsResolved` handles the advancer race; the TTL transition
 * failure lands in `errors` and retries next pass).
 */
export async function runStaleSuspendedAskCloseSweep(
  repo: AskRepository,
  options: StaleSuspendedCloseOptions
): Promise<StaleSuspendedCloseOutcome> {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_STALE_COMMIT_AUTH_TTL_MS;
  const batchLimit = options.batchLimit ?? DEFAULT_STALE_CLOSE_BATCH_LIMIT;
  const outcome: StaleSuspendedCloseOutcome = {
    scanned: 0,
    closedParentTerminal: 0,
    closedSuperseded: 0,
    expiredTtl: 0,
    untouched: 0,
    errors: 0,
    deferred: 0,
  };

  let suspended: Ask[];
  try {
    suspended = await repo.listByState("suspended");
  } catch (err) {
    log.warn("stale-ask close sweep: could not list suspended asks", {
      message: err instanceof Error ? err.message : String(err),
    });
    return outcome;
  }

  // Oldest first (PR #2146 R1): the batch cap must defer the NEWEST debris,
  // never starve the oldest — accumulated inbox debt retires first.
  const batch = [...suspended]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, batchLimit);
  outcome.deferred = suspended.length - batch.length;
  if (outcome.deferred > 0) {
    // No silent caps: surface what this pass did not examine.
    log.info("stale-ask close sweep: batch cap reached; remainder deferred to next pass", {
      batchLimit,
      deferred: outcome.deferred,
    });
  }

  const sessionSiblingsCache = new Map<string, Ask[]>();
  for (const ask of batch) {
    outcome.scanned += 1;
    try {
      const disposition = await classify(
        repo,
        ask,
        options.taskStatusById,
        nowMs,
        ttlMs,
        sessionSiblingsCache
      );
      if (disposition === "keep") {
        outcome.untouched += 1;
        continue;
      }
      if (disposition === "expire-ttl") {
        await repo.transition(ask.id, "expired");
        outcome.expiredTtl += 1;
        continue;
      }
      const responder =
        disposition === "close-parent-terminal" ? RESPONDER_PARENT_TERMINAL : RESPONDER_SUPERSEDED;
      const closed = await closeAskAsResolved(repo, ask.id, {
        responder,
        payload: {
          sweep: "stale-suspended-close",
          task: "mt#3001",
          parentTaskId: ask.parentTaskId,
        },
      });
      if (closed.kind === "closed" || closed.kind === "cancelled") {
        if (disposition === "close-parent-terminal") outcome.closedParentTerminal += 1;
        else outcome.closedSuperseded += 1;
      } else if (closed.kind === "already-terminal" || closed.kind === "not-found") {
        outcome.untouched += 1;
      } else {
        outcome.errors += 1;
      }
    } catch (err) {
      outcome.errors += 1;
      log.debug("stale-ask close sweep: could not retire ask (best-effort)", {
        askId: ask.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const retired = outcome.closedParentTerminal + outcome.closedSuperseded + outcome.expiredTtl;
  if (retired > 0) {
    log.info("stale-ask close sweep: retired stale suspended asks", { ...outcome });
  }
  return outcome;
}
