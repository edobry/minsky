/**
 * Driven-session cost widget (mt#2753, Rung 2D).
 *
 * Reads the `driven_session_cost` table (one row per turn — see
 * packages/domain/src/storage/schemas/driven-session-cost-schema.ts) and
 * rolls it up into a per-session summary list plus a global aggregate,
 * including a daily/monthly spend projection at the observed cadence — the
 * mt#2753 spec's success criterion 2.
 *
 * Billing-premise note (see the schema module's docblock): the numbers here
 * are the API-RATE EQUIVALENT of usage currently drawn from the operator's
 * subscription at $0 marginal cost (the 2026-06-15 Agent SDK billing split
 * was paused — memory `2d6cdbaf`). This widget is consumption/rate
 * observability + re-application readiness, not a live dollar bill.
 *
 * v1 aggregation strategy: fetch all rows and reduce in JS (mirrors
 * `memories-stats.ts`'s approach). `driven_session_cost` is a brand-new,
 * low-volume table (Rung 2 just shipped, mt#2750-2752) — SQL-side
 * aggregation (the `reviewer-bot-status.ts` PERCENTILE_CONT/SUM pattern) is
 * the natural next step if/when row count grows large enough that a
 * full-table fetch becomes expensive; not needed at current volume.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getContextInspectorDb } from "../db-providers";
import {
  drivenSessionCostTable,
  type DrivenSessionCostRecord,
} from "@minsky/domain/storage/schemas/driven-session-cost-schema";

// ---------------------------------------------------------------------------
// Payload shape — mirrored by the frontend hook/page.
// ---------------------------------------------------------------------------

export interface DrivenSessionCostModelMixEntry {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number | null;
}

export interface DrivenSessionCostSessionSummary {
  localId: string;
  harnessSessionId: string | null;
  taskId: string | null;
  minskySessionId: string | null;
  turnCount: number;
  totalCostUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  durationMs: number;
  modelMix: Record<string, DrivenSessionCostModelMixEntry>;
  firstRecordedAt: string;
  lastRecordedAt: string;
}

export type DrivenSessionCostPayload =
  | { status: "no-data" }
  | {
      status: "ok";
      sessionCount: number;
      turnCount: number;
      totalCostUsd: number | null;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      /** Simple linear projection: totalCostUsd / days-spanned * {1, 30}. Null
       * when totalCostUsd is null (no priced rows observed yet). */
      projectedDailyCostUsd: number | null;
      projectedMonthlyCostUsd: number | null;
      windowStart: string;
      windowEnd: string;
      sessions: DrivenSessionCostSessionSummary[];
    };

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function numOrZero(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function numOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Minimal structural view of a driven_session_cost row this module needs —
 * the same shape drizzle's `select().from(drivenSessionCostTable)` infers. */
type CostRow = DrivenSessionCostRecord;

/** Merge one turn row's modelUsage jsonb into a running per-session model mix. */
function mergeModelMix(mix: Record<string, DrivenSessionCostModelMixEntry>, raw: unknown): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const existing = mix[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: null,
    };
    mix[model] = {
      inputTokens: existing.inputTokens + numOrZero(v["inputTokens"]),
      outputTokens: existing.outputTokens + numOrZero(v["outputTokens"]),
      cacheCreationInputTokens:
        existing.cacheCreationInputTokens + numOrZero(v["cacheCreationInputTokens"]),
      cacheReadInputTokens: existing.cacheReadInputTokens + numOrZero(v["cacheReadInputTokens"]),
      costUsd:
        v["costUsd"] == null && existing.costUsd == null
          ? null
          : (existing.costUsd ?? 0) + numOrZero(v["costUsd"]),
    };
  }
}

/** Roll up per-turn rows (already ordered oldest-first) into per-session summaries. */
export function aggregateDrivenSessionCost(rows: CostRow[]): DrivenSessionCostPayload {
  if (rows.length === 0) return { status: "no-data" };

  const bySession = new Map<string, DrivenSessionCostSessionSummary>();
  let totalCostUsd: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let windowStartMs = Infinity;
  let windowEndMs = -Infinity;

  for (const row of rows) {
    const recordedIso = toIso(row.recordedAt);
    const recordedMs = new Date(recordedIso).getTime();
    if (recordedMs < windowStartMs) windowStartMs = recordedMs;
    if (recordedMs > windowEndMs) windowEndMs = recordedMs;

    const rowCost = numOrNull(row.totalCostUsd);
    if (rowCost !== null) totalCostUsd = (totalCostUsd ?? 0) + rowCost;
    inputTokens += numOrZero(row.inputTokens);
    outputTokens += numOrZero(row.outputTokens);
    cacheCreationInputTokens += numOrZero(row.cacheCreationInputTokens);
    cacheReadInputTokens += numOrZero(row.cacheReadInputTokens);

    const existing = bySession.get(row.localId);
    const session: DrivenSessionCostSessionSummary = existing ?? {
      localId: row.localId,
      harnessSessionId: row.harnessSessionId,
      taskId: row.taskId,
      minskySessionId: row.minskySessionId,
      turnCount: 0,
      totalCostUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 0,
      modelMix: {},
      firstRecordedAt: recordedIso,
      lastRecordedAt: recordedIso,
    };
    session.turnCount += 1;
    if (rowCost !== null) session.totalCostUsd = (session.totalCostUsd ?? 0) + rowCost;
    session.inputTokens += numOrZero(row.inputTokens);
    session.outputTokens += numOrZero(row.outputTokens);
    session.cacheCreationInputTokens += numOrZero(row.cacheCreationInputTokens);
    session.cacheReadInputTokens += numOrZero(row.cacheReadInputTokens);
    session.durationMs += numOrZero(row.durationMs);
    session.harnessSessionId = session.harnessSessionId ?? row.harnessSessionId;
    session.taskId = session.taskId ?? row.taskId;
    session.minskySessionId = session.minskySessionId ?? row.minskySessionId;
    if (recordedIso < session.firstRecordedAt) session.firstRecordedAt = recordedIso;
    if (recordedIso > session.lastRecordedAt) session.lastRecordedAt = recordedIso;
    mergeModelMix(session.modelMix, row.modelUsage);
    bySession.set(row.localId, session);
  }

  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = new Date(windowEndMs).toISOString();
  // Days spanned by the observed window, floored at 1 day so a burst of
  // sessions within a single hour doesn't produce an inflated per-day
  // projection from dividing by a near-zero span.
  const daysSpanned = Math.max(1, (windowEndMs - windowStartMs) / (24 * 60 * 60 * 1000));
  const projectedDailyCostUsd = totalCostUsd === null ? null : totalCostUsd / daysSpanned;
  const projectedMonthlyCostUsd =
    projectedDailyCostUsd === null ? null : projectedDailyCostUsd * 30;

  const sessions = [...bySession.values()].sort((a, b) =>
    b.lastRecordedAt.localeCompare(a.lastRecordedAt)
  );

  return {
    status: "ok",
    sessionCount: sessions.length,
    turnCount: rows.length,
    totalCostUsd,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    projectedDailyCostUsd,
    projectedMonthlyCostUsd,
    windowStart,
    windowEnd,
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

export const drivenSessionCostWidget: WidgetModule = {
  id: "driven-session-cost",
  title: "Driven Sessions — Cost & Usage",
  updateMode: { type: "polling", intervalMs: 60_000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    try {
      const db = await getContextInspectorDb();
      if (!db) {
        return { state: "degraded", reason: "DB not connected" };
      }
      const rows = await db.select().from(drivenSessionCostTable);
      const payload = aggregateDrivenSessionCost(rows);
      return { state: "ok", payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "degraded", reason: `driven-session-cost error: ${message}` };
    }
  },
};
