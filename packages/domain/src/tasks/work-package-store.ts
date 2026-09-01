import { and, eq, inArray, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tasksTable } from "../storage/schemas/task-embeddings";
import {
  workPackageMembersTable,
  workPackageTransfersTable,
} from "../storage/schemas/work-package-schema";
import type { ParsedMember, WorkPackageCreateOrigin } from "./work-package-briefing";

/**
 * Work-package row writes + fan-in lookup for the create seam (ADR-046, mt#2911).
 *
 * Creation writes the FIRST transfer-log entry: the package entering the
 * claimable pool is itself a transfer, and its origin (groomed | succession)
 * is a per-transfer fact — the release path appends the later entries.
 */

/** Statuses under which a sibling package still owns its queue (non-terminal). */
const OPEN_PACKAGE_STATUSES = ["TODO", "READY", "IN-PROGRESS"] as const;

export interface FanInHit {
  memberTaskId: string;
  siblingPackageId: string;
  siblingStatus: string | null;
}

/**
 * Members of OTHER open packages among `memberIds` — the fan-in check.
 * Reference ≠ reservation: the caller ANNOTATES these ("coordinate, don't
 * race"), never refuses on them; the non-overlap invariant was rejected on the
 * RFC's 2026-08-25 amendment evidence, and collision prevention lives at task
 * entry (mt#4788), not here.
 */
export async function findOpenPackagesReferencing(
  db: PostgresJsDatabase,
  memberIds: string[],
  excludePackageId?: string
): Promise<FanInHit[]> {
  if (memberIds.length === 0) return [];
  const rows = await db
    .select({
      memberTaskId: workPackageMembersTable.memberTaskId,
      siblingPackageId: workPackageMembersTable.packageTaskId,
      siblingStatus: tasksTable.status,
    })
    .from(workPackageMembersTable)
    .innerJoin(tasksTable, eq(tasksTable.id, workPackageMembersTable.packageTaskId))
    .where(
      and(
        inArray(workPackageMembersTable.memberTaskId, memberIds),
        inArray(tasksTable.status, [...OPEN_PACKAGE_STATUSES]),
        excludePackageId ? ne(workPackageMembersTable.packageTaskId, excludePackageId) : undefined
      )
    );
  return rows;
}

/**
 * Persist a freshly created package's member set and its opening transfer
 * entry (seq 1) in one transaction. Runs AFTER the task row exists — the
 * member rows FK onto it.
 */
export async function writeWorkPackageCreateRows(
  db: PostgresJsDatabase,
  args: {
    packageTaskId: string;
    origin: WorkPackageCreateOrigin;
    members: ParsedMember[];
    /** Member statuses read at write time, keyed by member taskId (F7 baseline). */
    memberStatuses?: Map<string, string | null>;
    byConversation: string | null;
    notes?: string;
  },
  now: Date = new Date()
): Promise<void> {
  const { packageTaskId, origin, members, memberStatuses, byConversation, notes } = args;
  await db.transaction(async (tx) => {
    if (members.length > 0) {
      await tx.insert(workPackageMembersTable).values(
        members.map((m) => ({
          packageTaskId,
          memberTaskId: m.taskId,
          rank: m.rank,
          statusAtWrite: memberStatuses?.get(m.taskId) ?? null,
          rationale: m.rationale,
          createdAt: now,
        }))
      );
    }
    await tx.insert(workPackageTransfersTable).values({
      packageTaskId,
      seq: 1,
      origin,
      byConversation,
      notes: notes ?? null,
      createdAt: now,
    });
  });
}
