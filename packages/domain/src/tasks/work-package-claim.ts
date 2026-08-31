import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tasksTable } from "../storage/schemas/task-embeddings";
import { workPackageTransfersTable } from "../storage/schemas/work-package-schema";

/**
 * Work-package claim/release (ADR-046, mt#2911).
 *
 * A claim is a single conditional UPDATE (CAS): `READY → IN-PROGRESS` plus the
 * engagement identity (`claimed_by`/`claimed_at`) in one statement, so two
 * concurrent claims on the same package resolve to exactly one winner at the
 * database — there is no read-then-write window. This path is the ONLY legal
 * `READY → IN-PROGRESS` transition for the kind: `validateStatusTransition`
 * reserves it (workflows.ts restrictedTransitions), and this module implements
 * the reservation's other half.
 *
 * A release clears the identity, returns the package to READY, and appends a
 * transfer-log entry with origin "release" — the package re-enters the pool as
 * a recorded transfer. Claiming appends nothing: the transfer log records
 * OFFERINGS of the package (groomed/succession at create, release afterwards),
 * while the task row records who currently holds it.
 */

export const WORK_PACKAGE_KIND = "work-package";

/** The subset of a task row the refusal diagnosis reads. */
export interface ClaimDiagnosticRow {
  kind: string;
  status: string | null;
  claimedBy: string | null;
}

export type WorkPackageClaimOutcome =
  | { ok: true; taskId: string; claimedBy: string; claimedAt: Date }
  | { ok: false; taskId: string; reason: "not-found"; message: string }
  | { ok: false; taskId: string; reason: "wrong-kind"; kind: string; message: string }
  | {
      ok: false;
      taskId: string;
      reason: "not-claimable";
      status: string | null;
      holder: string | null;
      message: string;
    };

export type WorkPackageReleaseOutcome =
  | {
      ok: true;
      taskId: string;
      previousHolder: string | null;
      transferSeq: number;
    }
  | { ok: false; taskId: string; reason: "not-found"; message: string }
  | { ok: false; taskId: string; reason: "wrong-kind"; kind: string; message: string }
  | {
      ok: false;
      taskId: string;
      reason: "not-claimed";
      status: string | null;
      message: string;
    };

/**
 * Why a claim's conditional UPDATE matched zero rows, from a follow-up read.
 *
 * Pure: the CAS already decided the outcome — this only names it for the
 * caller, which is why it is extracted rather than inlined (`testing-standards
 * §Testable Design`). A row that is claimable here but was not when the UPDATE
 * ran means the state changed between the two statements; report the row we
 * saw, which is the freshest fact available.
 */
export function explainClaimRefusal(
  taskId: string,
  row: ClaimDiagnosticRow | undefined
): WorkPackageClaimOutcome {
  if (!row) {
    return { ok: false, taskId, reason: "not-found", message: `Task ${taskId} does not exist.` };
  }
  if (row.kind !== WORK_PACKAGE_KIND) {
    return {
      ok: false,
      taskId,
      reason: "wrong-kind",
      kind: row.kind,
      message:
        `Task ${taskId} is kind "${row.kind}", not a work package. ` +
        `Claiming applies only to kind "${WORK_PACKAGE_KIND}"; use session_start / tasks_status_set for ordinary tasks.`,
    };
  }
  const holderClause = row.claimedBy
    ? ` It is held by ${row.claimedBy}.`
    : row.status === "IN-PROGRESS"
      ? " It is claimed, but the holder was not recorded."
      : "";
  return {
    ok: false,
    taskId,
    reason: "not-claimable",
    status: row.status,
    holder: row.claimedBy,
    message:
      `Work package ${taskId} is not claimable: status is ${row.status ?? "unset"}, ` +
      `and only READY packages can be claimed.${holderClause}`,
  };
}

/** Sibling of explainClaimRefusal for the release path. */
export function explainReleaseRefusal(
  taskId: string,
  row: ClaimDiagnosticRow | undefined
): WorkPackageReleaseOutcome {
  if (!row) {
    return { ok: false, taskId, reason: "not-found", message: `Task ${taskId} does not exist.` };
  }
  if (row.kind !== WORK_PACKAGE_KIND) {
    return {
      ok: false,
      taskId,
      reason: "wrong-kind",
      kind: row.kind,
      message: `Task ${taskId} is kind "${row.kind}", not a work package — nothing to release.`,
    };
  }
  return {
    ok: false,
    taskId,
    reason: "not-claimed",
    status: row.status,
    message:
      `Work package ${taskId} is not claimed: status is ${row.status ?? "unset"}, ` +
      `and only an IN-PROGRESS (claimed) package can be released.`,
  };
}

/**
 * Best-effort `task.status_changed` emission, INSIDE the domain path
 * deliberately (PR #3503 R1): the claim/release CAS bypasses
 * `tasks.status.set` by design, so if emission lived in any one adapter the
 * other callers (the cockpit routes, a future sweep) would silently blind the
 * event-ledger peer probes. Never throws — the ledger is informational and
 * must not affect the claim outcome.
 */
async function emitStatusChanged(
  db: PostgresJsDatabase,
  payload: { taskId: string; previousStatus: string; newStatus: string; via: string }
): Promise<void> {
  try {
    const { DrizzleEventEmitter } = await import("../events/emitter");
    await new DrizzleEventEmitter(db).emit({
      eventType: "task.status_changed",
      payload,
      relatedTaskId: payload.taskId,
    });
  } catch (err: unknown) {
    const { log } = await import("@minsky/shared/logger");
    log.warn("task.status_changed: event emission failed (best-effort, swallowed)", {
      taskId: payload.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function readDiagnosticRow(
  db: PostgresJsDatabase,
  taskId: string
): Promise<ClaimDiagnosticRow | undefined> {
  const rows = await db
    .select({
      kind: tasksTable.kind,
      status: tasksTable.status,
      claimedBy: tasksTable.claimedBy,
    })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return rows[0];
}

/**
 * Claim a READY work package for `claimedBy`.
 *
 * The WHERE carries id + kind + status so the write is the whole decision:
 * zero rows back means "not yours", and the diagnostic read afterwards only
 * explains which way it wasn't.
 */
export async function claimWorkPackage(
  db: PostgresJsDatabase,
  args: { taskId: string; claimedBy: string },
  now: Date = new Date()
): Promise<WorkPackageClaimOutcome> {
  const { taskId, claimedBy } = args;
  const updated = await db
    .update(tasksTable)
    .set({ status: "IN-PROGRESS", claimedBy, claimedAt: now, updatedAt: now })
    .where(
      and(
        eq(tasksTable.id, taskId),
        eq(tasksTable.kind, WORK_PACKAGE_KIND),
        eq(tasksTable.status, "READY")
      )
    )
    .returning({ id: tasksTable.id });

  if (updated.length === 1) {
    await emitStatusChanged(db, {
      taskId,
      previousStatus: "READY",
      newStatus: "IN-PROGRESS",
      via: "work-package.claim",
    });
    return { ok: true, taskId, claimedBy, claimedAt: now };
  }
  return explainClaimRefusal(taskId, await readDiagnosticRow(db, taskId));
}

/**
 * Release a claimed work package back to READY, appending the transfer-log
 * entry (origin "release") that re-offers it.
 *
 * The UPDATE is the same CAS shape as the claim, so a concurrent release (or a
 * completed/closed package) simply matches zero rows and is explained, never
 * clobbered. The transfer append runs in the same transaction: `seq` is
 * max+1 per package, and the (package, seq) primary key turns a same-instant
 * duplicate into a rollback of a release whose UPDATE could not have matched
 * anyway.
 */
export async function releaseWorkPackage(
  db: PostgresJsDatabase,
  args: { taskId: string; byConversation: string | null; notes?: string },
  now: Date = new Date()
): Promise<WorkPackageReleaseOutcome> {
  const { taskId, byConversation, notes } = args;
  const outcome: WorkPackageReleaseOutcome = await db.transaction(async (tx) => {
    const before = await tx
      .select({
        kind: tasksTable.kind,
        status: tasksTable.status,
        claimedBy: tasksTable.claimedBy,
      })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);

    const updated = await tx
      .update(tasksTable)
      .set({ status: "READY", claimedBy: null, claimedAt: null, updatedAt: now })
      .where(
        and(
          eq(tasksTable.id, taskId),
          eq(tasksTable.kind, WORK_PACKAGE_KIND),
          eq(tasksTable.status, "IN-PROGRESS")
        )
      )
      .returning({ id: tasksTable.id });

    if (updated.length !== 1) {
      return explainReleaseRefusal(taskId, before[0]);
    }

    const seqRows = await tx
      .select({
        next: sql<number>`coalesce(max(${workPackageTransfersTable.seq}), 0) + 1`,
      })
      .from(workPackageTransfersTable)
      .where(eq(workPackageTransfersTable.packageTaskId, taskId));
    const transferSeq = seqRows[0]?.next ?? 1;

    await tx.insert(workPackageTransfersTable).values({
      packageTaskId: taskId,
      seq: transferSeq,
      origin: "release",
      byConversation,
      notes: notes ?? null,
      createdAt: now,
    });

    return {
      ok: true,
      taskId,
      previousHolder: before[0]?.claimedBy ?? null,
      transferSeq,
    };
  });

  if (outcome.ok) {
    // After the transaction, so a rolled-back release never emits.
    await emitStatusChanged(db, {
      taskId,
      previousStatus: "IN-PROGRESS",
      newStatus: "READY",
      via: "work-package.release",
    });
  }
  return outcome;
}
