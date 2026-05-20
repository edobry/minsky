/**
 * Epic-decomposition audit command — mt#1710.
 *
 * Surfaces Shape C of the attention-allocation noticer family: TODO/PLANNING
 * children of an epic that are likely superseded by a recently-DONE sibling.
 *
 * Single command: `epic-decomposition.audit --epic mt#X` walks the children of
 * the supplied epic, fetches each child's status / timestamps / spec from the
 * task database, runs the pure detector, and returns the candidate list. The
 * operator reviews and closes superseded tasks via the existing `tasks.*`
 * commands — this command does NOT auto-close anything (false-positive
 * tolerance is the operator's decision).
 *
 * Surface choice: CLI command is the v0.1 surface. Hook-on-`tasks_status_get`
 * and skill-step in `/orchestrate` are deferred to follow-ups; both would
 * invoke this same domain function. A periodic-sweep mode can also call this
 * via `epic-decomposition.audit` per epic in a scheduled job.
 *
 * Reference: src/domain/detectors/epic-decomposition-staleness.ts (pure detector)
 * Reference: src/adapters/shared/commands/attention.ts (sibling pattern)
 * Reference: src/adapters/shared/commands/unasked-direction.ts (sibling pattern)
 */

import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { log } from "../../../utils/logger";
import { getErrorMessage } from "../../../errors/index";
import type { AppContainerInterface } from "../../../composition/types";
import type { SqlCapablePersistenceProvider } from "../../../domain/persistence/types";
import {
  taskRelationshipsTable,
  PARENT_RELATIONSHIP_TYPE,
} from "../../../domain/storage/schemas/task-relationships";
import { tasksTable, taskSpecsTable } from "../../../domain/storage/schemas/task-embeddings";
import {
  detectEpicDecompositionStaleness,
  DEFAULT_RECENCY_WINDOW_DAYS,
  DETECTOR_ID,
  DETECTOR_VERSION,
  type EpicChildSnapshot,
  type EpicStalenessCandidate,
} from "../../../domain/detectors/epic-decomposition-staleness";

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** Audit summary returned by the command. */
export interface EpicAuditResult {
  detectorId: string;
  detectorVersion: string;
  epicId: string;
  totalChildren: number;
  candidatesByTodoChild: Record<
    string,
    {
      todoChildId: string;
      todoChildTitle: string;
      todoChildStatus: string;
      todoChildCreatedAt: string | undefined;
      deliveringSiblings: Array<{
        id: string;
        title: string;
        deliveredAt: string | undefined;
        overlapSummary: {
          signalTypeCount: number;
          filePaths: string[];
          identifiers: string[];
          keywords: string[];
        };
      }>;
    }
  >;
}

// ---------------------------------------------------------------------------
// Database query helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Narrow Drizzle-executor type — the subset of methods this module uses on the
 * db connection returned by the persistence provider. Defining it here avoids
 * an import cycle with the heavyweight `PostgresJsDatabase` type and lets test
 * fakes satisfy the contract directly.
 */
export interface AuditDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
}

/** Walk the parent edge for an epic, returning child IDs. */
export async function listEpicChildIds(db: AuditDb, epicId: string): Promise<string[]> {
  const rows = (await db
    .select({ from: taskRelationshipsTable.fromTaskId })
    .from(taskRelationshipsTable)
    .where(
      and(
        eq(taskRelationshipsTable.toTaskId, epicId),
        eq(taskRelationshipsTable.type, PARENT_RELATIONSHIP_TYPE)
      )
    )) as Array<{ from: string }>;

  return rows.map((r) => r.from);
}

/**
 * Fetch task rows + spec content for a set of child IDs.
 *
 * Performs two queries (tasks + specs) and joins them in-memory by id. Both
 * queries are indexed; the spec query is unavoidable because spec content
 * lives in a separate table.
 */
export async function fetchChildSnapshots(
  db: AuditDb,
  childIds: string[]
): Promise<EpicChildSnapshot[]> {
  if (childIds.length === 0) return [];

  // Fetch task rows
  const taskRows = (await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
      createdAt: tasksTable.createdAt,
      updatedAt: tasksTable.updatedAt,
    })
    .from(tasksTable)
    .where(inArray(tasksTable.id, childIds))) as Array<{
    id: string;
    title: string | null;
    status: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
  }>;

  // Fetch spec rows
  const specRows = (await db
    .select({ taskId: taskSpecsTable.taskId, content: taskSpecsTable.content })
    .from(taskSpecsTable)
    .where(inArray(taskSpecsTable.taskId, childIds))) as Array<{
    taskId: string;
    content: string;
  }>;

  const specById = new Map<string, string>();
  for (const row of specRows) specById.set(row.taskId, row.content);

  return taskRows.map((row) => ({
    id: row.id,
    title: row.title ?? "",
    status: row.status ?? "TODO",
    spec: specById.get(row.id) ?? "",
    createdAt: row.createdAt ?? undefined,
    updatedAt: row.updatedAt ?? undefined,
  }));
}

/**
 * Group raw candidates by todo-child id and serialize for the audit result.
 *
 * Exported for test independence — pure transformation, no I/O.
 */
export function buildAuditResult(
  epicId: string,
  totalChildren: number,
  candidates: EpicStalenessCandidate[]
): EpicAuditResult {
  const byTodo: EpicAuditResult["candidatesByTodoChild"] = {};

  for (const c of candidates) {
    const entry = byTodo[c.todoChildId] ?? {
      todoChildId: c.todoChildId,
      todoChildTitle: c.todoChildTitle,
      todoChildStatus: c.todoChildStatus,
      todoChildCreatedAt: c.todoChildCreatedAt?.toISOString(),
      deliveringSiblings: [],
    };
    entry.deliveringSiblings.push({
      id: c.deliveringSiblingId,
      title: c.deliveringSiblingTitle,
      deliveredAt: c.deliveringSiblingDeliveredAt?.toISOString(),
      overlapSummary: {
        signalTypeCount: c.overlap.signalTypeCount,
        filePaths: c.overlap.filePaths,
        identifiers: c.overlap.identifiers,
        keywords: c.overlap.keywords,
      },
    });
    byTodo[c.todoChildId] = entry;
  }

  return {
    detectorId: DETECTOR_ID,
    detectorVersion: DETECTOR_VERSION,
    epicId,
    totalChildren,
    candidatesByTodoChild: byTodo,
  };
}

// ---------------------------------------------------------------------------
// Persistence resolution
// ---------------------------------------------------------------------------

async function resolveDb(container: AppContainerInterface | undefined): Promise<AuditDb | null> {
  if (!container?.has("persistence")) return null;
  try {
    const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
    if (!persistenceProvider.getDatabaseConnection) return null;
    const db = await persistenceProvider.getDatabaseConnection();
    if (!db) return null;
    return db as AuditDb;
  } catch (err: unknown) {
    log.warn("epic-decomposition: could not initialize db connection", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

const auditParams = {
  epic: {
    schema: z.string().min(1),
    description:
      "Epic task ID (e.g., mt#1552) whose children to audit for Sprint-A-superseded TODOs",
    required: true,
  },
  recencyDays: {
    schema: z.number().int().positive().optional(),
    description: `Delivery-recency window in days (default: ${DEFAULT_RECENCY_WINDOW_DAYS}). DONE siblings updated within this window are considered.`,
    required: false,
  },
  minOverlapSignals: {
    schema: z.number().int().min(1).max(3).optional(),
    description:
      "Minimum signal types that must overlap (1-3, default 1: any of file/identifier/keyword)",
    required: false,
  },
} as const;

/**
 * Register the `epic-decomposition.audit` command.
 *
 * @param container Optional DI container; commands resolve the persistence
 *   provider from it to query the task DB.
 */
export function registerEpicDecompositionCommands(container?: AppContainerInterface): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "epic-decomposition.audit",
      category: CommandCategory.DETECTORS,
      name: "audit",
      description:
        "Audit an epic's children for Sprint-A-superseded staleness. Surfaces TODO/PLANNING children whose scope overlaps a recently-DONE sibling — likely candidates for closure as CLOSED-superseded after operator review (mt#1710).",
      requiresSetup: true,
      parameters: auditParams,
      execute: async (params): Promise<EpicAuditResult> => {
        const epicId = params.epic;
        const recencyWindowDays = params.recencyDays ?? DEFAULT_RECENCY_WINDOW_DAYS;
        const minOverlapSignals = params.minOverlapSignals ?? 1;

        const db = await resolveDb(container);
        if (!db) {
          throw new Error(
            "epic-decomposition.audit: persistence provider unavailable — cannot reach the task database"
          );
        }

        try {
          const childIds = await listEpicChildIds(db, epicId);
          if (childIds.length === 0) {
            return buildAuditResult(epicId, 0, []);
          }

          const snapshots = await fetchChildSnapshots(db, childIds);
          const candidates = detectEpicDecompositionStaleness(snapshots, {
            recencyWindowDays,
            minOverlapSignals,
          });

          return buildAuditResult(epicId, snapshots.length, candidates);
        } catch (error) {
          log.error("epic-decomposition.audit failed", {
            error: getErrorMessage(error),
            epicId,
          });
          throw error;
        }
      },
    })
  );
}
