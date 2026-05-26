/**
 * Local reviewer-bot watcher — top-level orchestrator.
 *
 * One cycle:
 *   1. Detect missed reviews via `detectMissingReviews`.
 *   2. Apply threshold + dedup via `MissedReviewDedupState.decide`.
 *   3. On `"new-condition"`, fire `OperatorNotify.bell()` + `.notify(...)`.
 *
 * The cycle is pure-ish: all I/O goes through injected dependencies
 * (`MissedReviewClient`, `OperatorNotify`, `MissedReviewDedupState`). The
 * scheduler that wraps `runReviewerWatchCycle` in a setInterval lives in the
 * adapter layer (`src/adapters/shared/commands/reviewer-watch.ts`), keeping
 * this module deterministic and testable.
 *
 * Notification failures are caught and logged — they MUST NOT crash the
 * watcher, mirroring the pattern in `pr-watch/watcher.ts` and the Railway
 * sweeper.
 */

import { log } from "@minsky/shared/logger";
import type { OperatorNotify } from "../notify/operator-notify";
import { detectMissingReviews, type MissedReviewClient } from "./detector";
import { MissedReviewDedupState } from "./dedup";
import {
  REASON_NO_REVIEW_BY_BOT,
  type MissingReviewPR,
  type ReviewerWatchConfig,
  type ReviewerWatchCycleResult,
} from "./types";

/**
 * Build the notification body for an alert. Lists each missed PR with reason,
 * head SHA prefix, and click-through URL on its own line.
 */
export function formatAlertBody(missing: MissingReviewPR[]): string {
  const lines = missing.map((m) => {
    const reasonText =
      m.reason === REASON_NO_REVIEW_BY_BOT
        ? "no review by reviewer bot"
        : "review not at HEAD (commit_id mismatch)";
    return `PR #${m.number} — ${reasonText} (HEAD ${m.headSha.slice(0, 7)})\n  ${m.htmlUrl}`;
  });
  return lines.join("\n");
}

/** Build the notification title; pluralizes correctly for any count. */
export function formatAlertTitle(missing: MissingReviewPR[]): string {
  const n = missing.length;
  return n === 1
    ? "Minsky reviewer-bot: 1 missed review"
    : `Minsky reviewer-bot: ${n} missed reviews`;
}

/**
 * Run one watcher cycle.
 *
 * Note on failure semantics: detection failures (network error, GitHub
 * outage) propagate. The CLI / scheduler layer catches them. Notification
 * failures are caught here so a transient OperatorNotify error doesn't
 * crash a daemon process.
 */
export async function runReviewerWatchCycle(deps: {
  client: MissedReviewClient;
  operatorNotify: OperatorNotify;
  dedupState: MissedReviewDedupState;
  config: ReviewerWatchConfig;
}): Promise<ReviewerWatchCycleResult> {
  const { client, operatorNotify, dedupState, config } = deps;
  const startedAt = new Date().toISOString();

  const { scanned, missing } = await detectMissingReviews(
    client,
    config.owner,
    config.repo,
    config.botLogin
  );

  const { decision } = dedupState.decide(missing, config.threshold);

  let alerted = false;
  if (decision === "new-condition") {
    const title = formatAlertTitle(missing);
    const body = formatAlertBody(missing);

    try {
      operatorNotify.bell();
      operatorNotify.notify(title, body);
      alerted = true;
      log.info("reviewer-watch: alert fired", {
        owner: config.owner,
        repo: config.repo,
        missingCount: missing.length,
        prNumbers: missing.map((m) => m.number),
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn("reviewer-watch: notification failed (alert lost)", {
        owner: config.owner,
        repo: config.repo,
        missingCount: missing.length,
        error: errMsg,
      });
    }
  } else {
    log.debug("reviewer-watch: cycle complete, no alert", {
      owner: config.owner,
      repo: config.repo,
      decision,
      missingCount: missing.length,
      prsScanned: scanned,
    });
  }

  return {
    startedAt,
    prsScanned: scanned,
    missing,
    alerted,
    decision,
  };
}
