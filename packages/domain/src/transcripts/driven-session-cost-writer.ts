/**
 * driven-session-cost-writer — persists per-turn cost/usage rows to
 * `driven_session_cost` (mt#2753, Rung 2D of the harness-host ladder).
 *
 * Sibling of `driven-link-writer.ts` (mt#2752's `driven_spawn` link class) —
 * same daemon-domain-boundary shape (the daemon host
 * `src/cockpit/driven-session-host.ts` imports NOTHING from `@minsky/domain`;
 * this module is the domain-facing write half, invoked from
 * `src/cockpit/driven-session-launch.ts`'s `onResultSummary` observer). Unlike
 * `driven-link-writer.ts`, this write is NOT FK-ordered against
 * `agent_transcripts` — see the schema module's docblock for why.
 *
 * Never throws — a DB failure is logged and swallowed so cost-writing can
 * never disturb the running driven session it rides alongside (matches the
 * sibling writers' and the reviewer-service's `recordReviewTiming` error-
 * swallowing convention).
 *
 * @see mt#2753 — this file
 * @see packages/domain/src/storage/schemas/driven-session-cost-schema.ts — the table
 * @see src/cockpit/driven-session-launch.ts — the caller (onResultSummary observer)
 * @see src/cockpit/driven-session-host.ts — extractResultSummary/DrivenSessionCostSummary
 * @see services/reviewer/src/review-timing.ts — the reused write-shape precedent
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";
import { drivenSessionCostTable } from "../storage/schemas/driven-session-cost-schema";
import { getErrorMessage } from "../errors/index";

/** One model's usage entry, as extracted by driven-session-host.ts's `extractModelUsage`. */
export interface DrivenSessionCostModelUsageInput {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  costUsd: number | null;
}

export interface DrivenSessionCostWriteInput {
  localId: string;
  harnessSessionId: string | null;
  taskId: string | null;
  minskySessionId: string | null;
  turnIndex: number;
  subtype: string | null;
  isError: boolean;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  numTurns: number | null;
  modelUsage: Record<string, DrivenSessionCostModelUsageInput> | null;
}

export type WriteDrivenSessionCostOutcome = "written" | "error";

/**
 * Write one per-turn cost/usage row. `totalCostUsd` is converted to a fixed
 * 6dp string (the `numeric(12,6)` column's expected insert shape — mirrors
 * `review-timing.ts`'s `costUsd.toFixed(6)` convention, avoiding float
 * representation surprises).
 */
export async function writeDrivenSessionCost(
  db: PostgresJsDatabase,
  input: DrivenSessionCostWriteInput
): Promise<WriteDrivenSessionCostOutcome> {
  try {
    await db.insert(drivenSessionCostTable).values({
      localId: input.localId,
      harnessSessionId: input.harnessSessionId,
      taskId: input.taskId,
      minskySessionId: input.minskySessionId,
      turnIndex: input.turnIndex,
      subtype: input.subtype,
      isError: input.isError,
      totalCostUsd: input.totalCostUsd == null ? null : input.totalCostUsd.toFixed(6),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheCreationInputTokens: input.cacheCreationInputTokens,
      cacheReadInputTokens: input.cacheReadInputTokens,
      durationMs: input.durationMs,
      durationApiMs: input.durationApiMs,
      numTurns: input.numTurns,
      modelUsage: input.modelUsage,
    });
    return "written";
  } catch (err) {
    log.warn(`writeDrivenSessionCost: failed for session ${input.localId}`, {
      error: getErrorMessage(err),
      turnIndex: input.turnIndex,
    });
    return "error";
  }
}
