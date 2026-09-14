import { asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tasksTable } from "../storage/schemas/task-embeddings";
import {
  workPackageMembersTable,
  workPackageTransfersTable,
} from "../storage/schemas/work-package-schema";
import {
  releaseWorkPackage,
  WORK_PACKAGE_KIND,
  type ClaimDiagnosticRow,
  type WorkPackageReleaseOutcome,
} from "./work-package-claim";
import {
  renderMembersSection,
  renderTransferLog,
  upsertBriefingSection,
} from "./work-package-briefing";
import { readSpec, readTransferLog, writeSpec } from "./work-package-transfers-projection";

/**
 * Work-package succession (ADR-046 decision 3, mt#5133).
 *
 * The lifecycle is mutate-plus-log: a handoff is the ACT by which the package a
 * conversation holds re-enters the pool carrying state, so it rewrites THAT
 * row — members, briefing — and appends a `succession` transfer, rather than
 * minting a new package and leaving the predecessor open (the measured
 * 7-link chain mt#5030 → … → mt#5119 is what mint-per-succession produced).
 *
 * The write is one transaction: the task row is locked (`FOR UPDATE`), so it
 * serializes against the release/complete CAS writes in the sibling modules;
 * a package that is not IN-PROGRESS is refused before anything is written —
 * succession is the act of the conversation that holds the package. The
 * release that follows (when asked for) is `releaseWorkPackage` unchanged: a
 * second transfer, origin `release`, exactly as a plain release records it.
 *
 * The spec carries a rendered `## Transfers` section after every succession
 * (and again after the release), because the spec is the one surface a
 * successor reads; the transfer table stays the source of truth.
 */

/** A replacement member, in rank order, with the status the caller resolved. */
export interface SuccessionMember {
  taskId: string;
  rationale: string | null;
  /** The member's task status at write time (the F7 staleness baseline). */
  statusAtWrite: string | null;
}

export interface SucceedWorkPackageArgs {
  taskId: string;
  /**
   * The full replacement briefing (already validated by the create seam), or
   * null to keep the current spec text apart from the sections rewritten here.
   */
  spec: string | null;
  /**
   * The replacement member set, or null to keep the current members. When
   * `spec` is given the caller passes the briefing's parsed `## Members`; when
   * only a member list is given the `## Members` section is rewritten from it.
   */
  members: SuccessionMember[] | null;
  byConversation: string | null;
  /** The outcome: what shipped, what remains, judgment that must survive the fold. */
  notes: string;
  /** Return the package to READY afterwards (the default in the command). */
  releaseClaim: boolean;
}

export type WorkPackageSuccessionOutcome =
  | {
      ok: true;
      taskId: string;
      /** Member ids in rank order after the write. */
      members: string[];
      /** The `succession` transfer's seq. */
      transferSeq: number;
      /** The release outcome when `releaseClaim` was set; null when it was not. */
      release: WorkPackageReleaseOutcome | null;
      status: "READY" | "IN-PROGRESS";
    }
  | { ok: false; taskId: string; reason: "not-found"; message: string }
  | { ok: false; taskId: string; reason: "wrong-kind"; kind: string; message: string }
  | {
      ok: false;
      taskId: string;
      reason: "not-claimed";
      status: string | null;
      message: string;
    }
  | { ok: false; taskId: string; reason: "empty-members"; message: string };

/**
 * Why a succession was refused, from the locked row. Pure, like its siblings
 * in work-package-claim.ts.
 */
export function explainSuccessionRefusal(
  taskId: string,
  row: ClaimDiagnosticRow | undefined
): WorkPackageSuccessionOutcome {
  if (!row) {
    return { ok: false, taskId, reason: "not-found", message: `Task ${taskId} does not exist.` };
  }
  if (row.kind !== WORK_PACKAGE_KIND) {
    return {
      ok: false,
      taskId,
      reason: "wrong-kind",
      kind: row.kind,
      message: `Task ${taskId} is kind "${row.kind}", not a work package — nothing to succeed.`,
    };
  }
  if (row.status === "IN-PROGRESS" && !row.claimedBy) {
    // The status says held but no holder was recorded: there is no conversation
    // whose act this could be, so it is refused rather than attributed to the caller.
    return {
      ok: false,
      taskId,
      reason: "not-claimed",
      status: row.status,
      message:
        `Work package ${taskId} is IN-PROGRESS but records no holder, so there is no claim to ` +
        `succeed. Release it (tasks release) and claim it, then succeed it.`,
    };
  }
  return {
    ok: false,
    taskId,
    reason: "not-claimed",
    status: row.status,
    message:
      `Work package ${taskId} is not claimed: status is ${row.status ?? "unset"}, and succession ` +
      `is the act of the conversation that holds it (claim it first, or release/complete an ` +
      `unheld package through its own path).`,
  };
}

/**
 * Whether the locked row is a package a conversation currently holds — the
 * only state succession applies to. Pure; the transaction consults it and
 * `explainSuccessionRefusal` names the way it failed.
 */
export function isSucceedableRow(row: ClaimDiagnosticRow | undefined): boolean {
  return (
    row !== undefined &&
    row.kind === WORK_PACKAGE_KIND &&
    row.status === "IN-PROGRESS" &&
    Boolean(row.claimedBy)
  );
}

/**
 * First occurrence wins: the member table's key is (package, member), so a
 * ref listed twice would fail the insert after the refusal checks passed.
 * The parser and the command already dedupe; this is the write's own guard.
 */
export function dedupeMembers<T extends { taskId: string }>(members: T[]): T[] {
  const seen = new Set<string>();
  return members.filter((m) => {
    if (seen.has(m.taskId)) return false;
    seen.add(m.taskId);
    return true;
  });
}

export function emptyMembersRefusal(taskId: string): WorkPackageSuccessionOutcome {
  return {
    ok: false,
    taskId,
    reason: "empty-members",
    message:
      `Work package ${taskId} would have no members after this succession — a package with ` +
      `nothing left to pick up is closed, not re-offered: leave the members as they are and ` +
      `the lifecycle sweep (tasks packages sweep, mt#5132) completes it once every member ` +
      `is terminal, or set it DONE/CLOSED directly.`,
  };
}

// readTransferLog, readSpec, writeSpec and refreshTransfersSection moved to
// work-package-transfers-projection.ts (mt#5143), where every transfer writer
// shares them; this module keeps the in-transaction render it always did.

/**
 * Succeed a claimed work package: rewrite its member set and briefing, append
 * the `succession` transfer, render the transfer log into the spec, then
 * release the claim when asked. Refusals write nothing.
 */
export async function succeedWorkPackage(
  db: PostgresJsDatabase,
  args: SucceedWorkPackageArgs,
  now: Date = new Date()
): Promise<WorkPackageSuccessionOutcome> {
  const { taskId, spec, members, byConversation, notes, releaseClaim } = args;

  const outcome: WorkPackageSuccessionOutcome = await db.transaction(async (tx) => {
    // Lock the row for the transaction: a concurrent release/complete CAS on
    // the same package waits here, and one that already ran is seen below.
    const rows = await tx
      .select({
        kind: tasksTable.kind,
        status: tasksTable.status,
        claimedBy: tasksTable.claimedBy,
      })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!isSucceedableRow(row)) {
      return explainSuccessionRefusal(taskId, row);
    }

    const currentMembers = await tx
      .select({
        taskId: workPackageMembersTable.memberTaskId,
        rationale: workPackageMembersTable.rationale,
      })
      .from(workPackageMembersTable)
      .where(eq(workPackageMembersTable.packageTaskId, taskId))
      .orderBy(asc(workPackageMembersTable.rank));
    // A bare member list carries no rationale, so a member the package already
    // queued keeps the one its briefing gave it; a full briefing is authoritative.
    const priorRationale = new Map(currentMembers.map((m) => [m.taskId, m.rationale]));
    const nextMembers = (members ? dedupeMembers(members) : null)?.map((m) => ({
      ...m,
      rationale: m.rationale ?? (spec === null ? (priorRationale.get(m.taskId) ?? null) : null),
    }));
    const resultingMembers = nextMembers ?? currentMembers;
    if (resultingMembers.length === 0) {
      return emptyMembersRefusal(taskId);
    }

    if (nextMembers) {
      await tx
        .delete(workPackageMembersTable)
        .where(eq(workPackageMembersTable.packageTaskId, taskId));
      await tx.insert(workPackageMembersTable).values(
        nextMembers.map((m, index) => ({
          packageTaskId: taskId,
          memberTaskId: m.taskId,
          rank: index + 1,
          statusAtWrite: m.statusAtWrite,
          rationale: m.rationale,
          createdAt: now,
        }))
      );
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
      origin: "succession",
      byConversation,
      notes,
      createdAt: now,
    });

    // The briefing: a full replacement when given; otherwise the current text,
    // with `## Members` rewritten when only a member list was given.
    let briefing = spec ?? (await readSpec(tx, taskId));
    if (spec === null && nextMembers) {
      briefing = upsertBriefingSection(briefing, renderMembersSection(nextMembers));
    }
    const transfers = await readTransferLog(tx, taskId);
    await writeSpec(tx, taskId, upsertBriefingSection(briefing, renderTransferLog(transfers)), now);

    await tx.update(tasksTable).set({ updatedAt: now }).where(eq(tasksTable.id, taskId));

    return {
      ok: true,
      taskId,
      members: resultingMembers.map((m) => m.taskId),
      transferSeq,
      release: null,
      status: "IN-PROGRESS",
    };
  });

  if (!outcome.ok || !releaseClaim) return outcome;

  // releaseWorkPackage re-renders `## Transfers` itself after its commit (mt#5143).
  const release = await releaseWorkPackage(
    db,
    {
      taskId,
      byConversation,
      notes: `Released after succession transfer #${outcome.transferSeq}.`,
    },
    now
  );
  return { ...outcome, release, status: release.ok ? "READY" : "IN-PROGRESS" };
}
