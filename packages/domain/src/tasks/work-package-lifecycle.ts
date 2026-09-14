import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tasksTable } from "../storage/schemas/task-embeddings";
import { workPackageTransfersTable } from "../storage/schemas/work-package-schema";
import { emitStatusChanged, releaseWorkPackage, WORK_PACKAGE_KIND } from "./work-package-claim";
import type { WorkPackageReleaseOutcome } from "./work-package-claim";
import { refreshTransfersSectionAfterWrite } from "./work-package-transfers-projection";

/**
 * Work-package lifecycle writes beyond claim/release (mt#5132): completion,
 * and the conversation-scoped release the SessionEnd hook calls.
 *
 * Both are the same CAS-plus-transfer transaction shape as `releaseWorkPackage`
 * (`work-package-claim.ts`): the UPDATE carries id + kind + the status set it
 * may move from, so a concurrent writer matches zero rows and is explained
 * rather than clobbered, and the transfer append shares the transaction. They
 * live here rather than beside the claim because that module sits at the
 * 400-line lint ceiling; the emitter is imported from it so every status
 * change on a package still reaches the event ledger from ONE place.
 */

/** Statuses a package can be completed FROM: open (READY) or claimed (IN-PROGRESS). */
export const COMPLETABLE_STATUSES = ["READY", "IN-PROGRESS"] as const;

export type WorkPackageCompleteOutcome =
  | { ok: true; taskId: string; previousStatus: string; transferSeq: number }
  | { ok: false; taskId: string; reason: "not-found" | "wrong-kind" | "not-open"; message: string };

/**
 * Complete a work package: READY or IN-PROGRESS → DONE, claim cleared, one
 * `completed` transfer. The caller has already established that every member
 * is terminal (`decidePackageSweep`); this function is the write, not the
 * decision, and it will complete an empty package if asked — the decision
 * layer is what refuses that.
 */
export async function completeWorkPackage(
  db: PostgresJsDatabase,
  args: { taskId: string; notes: string },
  now: Date = new Date()
): Promise<WorkPackageCompleteOutcome> {
  const { taskId, notes } = args;
  const outcome: WorkPackageCompleteOutcome = await db.transaction(async (tx) => {
    const before = await tx
      .select({ kind: tasksTable.kind, status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    const row = before[0];

    const updated = await tx
      .update(tasksTable)
      .set({ status: "DONE", claimedBy: null, claimedAt: null, updatedAt: now })
      .where(
        and(
          eq(tasksTable.id, taskId),
          eq(tasksTable.kind, WORK_PACKAGE_KIND),
          inArray(tasksTable.status, [...COMPLETABLE_STATUSES])
        )
      )
      .returning({ id: tasksTable.id });

    if (updated.length !== 1) {
      if (!row) {
        return {
          ok: false,
          taskId,
          reason: "not-found",
          message: `Task ${taskId} does not exist.`,
        };
      }
      if (row.kind !== WORK_PACKAGE_KIND) {
        return {
          ok: false,
          taskId,
          reason: "wrong-kind",
          message: `Task ${taskId} is kind "${row.kind}", not a work package — nothing to complete.`,
        };
      }
      return {
        ok: false,
        taskId,
        reason: "not-open",
        message:
          `Work package ${taskId} is ${row.status ?? "unset"}; only a READY or IN-PROGRESS ` +
          "package can be completed.",
      };
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
      origin: "completed",
      byConversation: null,
      notes,
      createdAt: now,
    });

    return { ok: true, taskId, previousStatus: String(row?.status ?? ""), transferSeq };
  });

  if (outcome.ok) {
    await emitStatusChanged(db, {
      taskId,
      previousStatus: outcome.previousStatus,
      newStatus: "DONE",
      via: "work-package.complete",
    });
    // Best-effort projection of the log into the spec (mt#5143); after the commit.
    await refreshTransfersSectionAfterWrite(db, taskId, "work-package.complete", now);
  }
  return outcome;
}

/**
 * The claim-identity suffix a conversation's claims carry. An ADR-006 agent id
 * is `{kind}:conv:{conversationId}`, optionally nested under `@` for a
 * subagent (`minsky.native-subagent:task:mt#1@com.anthropic.claude-code:conv:<id>`);
 * matching on the `:conv:<id>` suffix covers both without naming the harness
 * kind, and cannot match a `proc:` or free-text claim — which is the point:
 * those identities are shared or unattributable, and the SessionEnd hook must
 * not release them (mt#5132 criterion 3).
 */
export function conversationClaimSuffix(conversationId: string): string {
  return `:conv:${conversationId}`;
}

export interface ConversationReleaseResult {
  conversationId: string;
  /** Packages the release matched by suffix, released or refused. */
  matched: string[];
  released: string[];
  /** CAS refusals — a package that moved between the read and the write. */
  refused: Array<{ taskId: string; reason: string }>;
}

/**
 * Release every IN-PROGRESS work package claimed by `conversationId` — the
 * SessionEnd hook's write, via `tasks.release-conversation`. Read-then-write:
 * the read selects by suffix, and each write is `releaseWorkPackage`'s own CAS,
 * so a package the read saw that someone else released first is a refusal in
 * the result, not a double transfer.
 */
export async function releaseClaimsForConversation(
  db: PostgresJsDatabase,
  args: { conversationId: string; notes: string },
  now: Date = new Date()
): Promise<ConversationReleaseResult> {
  const { conversationId, notes } = args;
  const suffix = conversationClaimSuffix(conversationId);
  const rows = await db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.kind, WORK_PACKAGE_KIND),
        eq(tasksTable.status, "IN-PROGRESS"),
        like(tasksTable.claimedBy, `%${escapeLike(suffix)}`)
      )
    );

  const result: ConversationReleaseResult = {
    conversationId,
    matched: rows.map((r) => r.id),
    released: [],
    refused: [],
  };
  for (const { id } of rows) {
    const outcome: WorkPackageReleaseOutcome = await releaseWorkPackage(
      db,
      { taskId: id, byConversation: null, notes },
      now
    );
    if (outcome.ok) result.released.push(id);
    else result.refused.push({ taskId: id, reason: outcome.reason });
  }
  return result;
}

/** A conversation id is a uuid, but the LIKE pattern is built from input — escape its metacharacters. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
