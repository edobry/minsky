import { asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import { tasksTable, taskSpecsTable } from "../storage/schemas/task-embeddings";
import {
  WORK_PACKAGE_KIND,
  workPackageTransfersTable,
} from "../storage/schemas/work-package-schema";
import {
  renderTransferLog,
  TRANSFERS_HEADING,
  upsertBriefingSection,
  type TransferLogEntry,
} from "./work-package-briefing";

/**
 * The `## Transfers` projection (mt#5133, generalized mt#5143).
 *
 * `work_package_transfers` is the source of truth for a package's history; the
 * `## Transfers` section of its spec is that log RENDERED, because the spec is
 * the one surface a successor reads (`tasks_spec_get`, the cockpit task page)
 * and nothing renders the table. Every writer that appends a transfer —
 * create, release, complete, succession — re-renders the section afterwards
 * through this module, so the section equals the log after any transfer.
 *
 * The re-render is BEST-EFFORT relative to the transfer write: it runs after
 * the writer's transaction has committed, and a failed spec write is logged,
 * never re-thrown — a release or completion must not be undone by its own
 * projection. `runTransfersRefresh` is the one-shot that brings every package
 * whose section is missing or behind back in sync (dry-run by default).
 */

export const TRANSFERS_REFRESH_VIA_CLI = "cli";

type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];
export type ProjectionDb = PostgresJsDatabase | Tx;

const RENDERED_ITEM_RE = /^- #\d+ /gm;

export async function readTransferLog(
  db: ProjectionDb,
  taskId: string
): Promise<TransferLogEntry[]> {
  return db
    .select({
      seq: workPackageTransfersTable.seq,
      origin: workPackageTransfersTable.origin,
      byConversation: workPackageTransfersTable.byConversation,
      notes: workPackageTransfersTable.notes,
      createdAt: workPackageTransfersTable.createdAt,
    })
    .from(workPackageTransfersTable)
    .where(eq(workPackageTransfersTable.packageTaskId, taskId))
    .orderBy(asc(workPackageTransfersTable.seq));
}

export async function readSpec(db: ProjectionDb, taskId: string): Promise<string> {
  const rows = await db
    .select({ content: taskSpecsTable.content })
    .from(taskSpecsTable)
    .where(eq(taskSpecsTable.taskId, taskId))
    .limit(1);
  return rows[0]?.content ?? "";
}

export async function writeSpec(
  db: ProjectionDb,
  taskId: string,
  content: string,
  now: Date
): Promise<void> {
  await db
    .insert(taskSpecsTable)
    .values({ taskId, content, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: taskSpecsTable.taskId,
      set: { content, updatedAt: now },
    });
}

/**
 * Re-render `## Transfers` from the log into the current spec. Throws on a
 * failed read or write — callers inside a transaction want that; callers after
 * a committed write use `refreshTransfersSectionAfterWrite`.
 */
export async function refreshTransfersSection(
  db: ProjectionDb,
  taskId: string,
  now: Date = new Date()
): Promise<string> {
  const [spec, transfers] = await Promise.all([readSpec(db, taskId), readTransferLog(db, taskId)]);
  const next = upsertBriefingSection(spec, renderTransferLog(transfers));
  await writeSpec(db, taskId, next, now);
  return next;
}

/**
 * The best-effort form every transfer writer calls once its own transaction
 * has committed. Never throws: the transfer row and the status change are the
 * facts; the section is their projection, and a projection failure is logged
 * with the writer that hit it so the one-shot refresh can repair it later.
 */
export async function refreshTransfersSectionAfterWrite(
  db: PostgresJsDatabase,
  taskId: string,
  via: string,
  now: Date = new Date()
): Promise<{ ok: boolean; error?: string }> {
  try {
    await refreshTransfersSection(db, taskId, now);
    return { ok: true };
  } catch (err: unknown) {
    const error = getLoggableErrorSummary(err);
    log.warn("work-package transfers projection: refresh failed after a committed transfer", {
      taskId,
      via,
      error,
    });
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// One-shot refresh (SC3): bring every package's section in line with its log
// ---------------------------------------------------------------------------

export type TransfersSectionState = "missing" | "behind" | "in-sync" | "ahead";

/** How many transfer items a spec's `## Transfers` section renders, or null when it has none. */
export function countRenderedTransfers(spec: string): number | null {
  const at = spec.search(new RegExp(`^${TRANSFERS_HEADING}\\s*$`, "m"));
  if (at === -1) return null;
  const rest = spec.slice(at + TRANSFERS_HEADING.length);
  const nextHeading = rest.search(/^#{2,}\s/m);
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return (body.match(RENDERED_ITEM_RE) ?? []).length;
}

/** Pure: the section's state against the log it projects. */
export function classifyTransfersSection(spec: string, logCount: number): TransfersSectionState {
  const rendered = countRenderedTransfers(spec);
  if (rendered === null) return "missing";
  if (rendered < logCount) return "behind";
  if (rendered > logCount) return "ahead";
  return "in-sync";
}

export interface TransfersRefreshPlanEntry {
  taskId: string;
  status: string | null;
  state: TransfersSectionState;
  logCount: number;
  rendered: number | null;
}

export interface TransfersRefreshResult {
  dryRun: boolean;
  plan: {
    refresh: TransfersRefreshPlanEntry[];
    inSync: TransfersRefreshPlanEntry[];
  };
  applied: { refreshed: string[]; failed: Array<{ taskId: string; error: string }> };
}

/**
 * Plan (and with `execute`, apply) a re-render for every work package whose
 * `## Transfers` section is missing, behind or ahead of its log. Terminal
 * packages are included: a projection that exists on some packages and not
 * others cannot be read, because absence would mean either "no transfers" or
 * "not rendered".
 */
export async function runTransfersRefresh(
  db: PostgresJsDatabase,
  options: { execute?: boolean; now?: Date } = {}
): Promise<TransfersRefreshResult> {
  const execute = options.execute === true;
  const now = options.now ?? new Date();

  const rows = await db
    .select({
      taskId: tasksTable.id,
      status: tasksTable.status,
      spec: taskSpecsTable.content,
      logCount: sql<number>`(
        select count(*)::int from ${workPackageTransfersTable}
        where ${workPackageTransfersTable.packageTaskId} = ${tasksTable.id}
      )`,
    })
    .from(tasksTable)
    .leftJoin(taskSpecsTable, eq(taskSpecsTable.taskId, tasksTable.id))
    .where(eq(tasksTable.kind, WORK_PACKAGE_KIND))
    .orderBy(asc(tasksTable.id));

  const refresh: TransfersRefreshPlanEntry[] = [];
  const inSync: TransfersRefreshPlanEntry[] = [];
  for (const row of rows) {
    const logCount = Number(row.logCount ?? 0);
    if (logCount === 0) continue;
    const spec = row.spec ?? "";
    const entry: TransfersRefreshPlanEntry = {
      taskId: row.taskId,
      status: row.status ?? null,
      state: classifyTransfersSection(spec, logCount),
      logCount,
      rendered: countRenderedTransfers(spec),
    };
    (entry.state === "in-sync" ? inSync : refresh).push(entry);
  }

  const applied: TransfersRefreshResult["applied"] = { refreshed: [], failed: [] };
  if (execute) {
    for (const entry of refresh) {
      const result = await refreshTransfersSectionAfterWrite(
        db,
        entry.taskId,
        TRANSFERS_REFRESH_VIA_CLI,
        now
      );
      if (result.ok) applied.refreshed.push(entry.taskId);
      else applied.failed.push({ taskId: entry.taskId, error: result.error ?? "unknown" });
    }
  }

  return { dryRun: !execute, plan: { refresh, inSync }, applied };
}
