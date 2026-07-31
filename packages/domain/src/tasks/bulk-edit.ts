/**
 * Bulk task-edit primitives (mt#2819).
 *
 * Pure change-set computation plus a deterministic dry-run token for the
 * `tasks.bulk-edit` command. The token binds the exact approved change set:
 * the execute path recomputes per-record state and refuses on drift, so a
 * diverged change set structurally invalidates the approval (the mt#2785
 * dry-run scope-match rule, enforced in code rather than discipline).
 *
 * Token contract note (shared with mt#2823): the token is a deterministic
 * sha256 over the canonical change set — no nonce. Durability comes from the
 * append-only `task.bulk_edit.dry_run` audit event that carries the change
 * set; one-shot consumption is the presence of a matching
 * `task.bulk_edit.executed` event.
 */

import { createHash } from "crypto";
import {
  checkKindChangeStatusCompatibility,
  DEFAULT_KIND,
  type KindChangeStatusConflict,
} from "./workflows";

/** Edit operations bulk mode supports (v1): kind reclassification + tag add/remove. */
export interface BulkEditOps {
  kind?: string;
  addTag?: string;
  removeTag?: string;
}

/** Minimal task state the change-set computation reads. */
export interface BulkEditTaskState {
  id: string;
  kind?: string | null;
  tags?: string[] | null;
  /**
   * Current status — read only to reject a kind change that would strand the
   * task (mt#3137). Optional: a caller that cannot supply it gets the
   * pre-mt#3137 behavior for that record rather than a hard failure.
   */
  status?: string | null;
}

/**
 * One record of the change set: a single field transition on a single task.
 * `before`/`after` are the kind string for `field: "kind"` and the full tags
 * array for `field: "tags"`.
 */
export interface BulkChangeRecord {
  taskId: string;
  field: "kind" | "tags";
  before: string | string[];
  after: string | string[];
}

/** Per-record verdict when re-checking a change record against current state. */
export type DriftVerdict = "pending" | "applied" | "drift";

/**
 * Tasks with no stored kind are treated as the system default so that a bulk
 * `kind: "implementation"` op is a no-op for them rather than a phantom change.
 * `DEFAULT_KIND` is imported from `workflows.ts` — the single authority — rather
 * than re-declared here (PR #2389 R1).
 */

/**
 * Canonical string form of a record value, for hashing and drift comparison.
 * Arrays (tags) are canonicalized as a SET — sorted copy before serialization
 * — so a pure reordering of tags is never a change and never drift (PR #2009
 * R1: tags are semantically a set; order-sensitive comparison would falsely
 * trigger drift when another writer reorders without changing membership).
 * Application still uses the record's `after` array as stored.
 */
export function canonicalValue(value: string | string[]): string {
  return typeof value === "string" ? value : JSON.stringify([...value].sort());
}

/**
 * Compute the change set for applying `ops` to `tasks`. Records are emitted
 * only for actual transitions (before differs from after) and are sorted by
 * (taskId, field) so the set — and therefore the token — is order-independent
 * of the caller's id list.
 */
export function computeChangeSet(tasks: BulkEditTaskState[], ops: BulkEditOps): BulkChangeRecord[] {
  const records: BulkChangeRecord[] = [];

  for (const task of tasks) {
    if (ops.kind !== undefined) {
      const before = task.kind ?? DEFAULT_KIND;
      if (before !== ops.kind) {
        // mt#3137: a kind change whose target state machine does not recognize
        // this task's status would leave it with zero valid transitions. Such a
        // record is omitted from the change set entirely — so it is neither
        // previewed as a pending change nor carried into the token hash, and
        // `--execute` cannot apply it. `computeBlockedKindChanges` reports it.
        const stranded = checkKindChangeStatusCompatibility(task.status, before, ops.kind);
        if (!stranded) {
          records.push({ taskId: task.id, field: "kind", before, after: ops.kind });
        }
      }
    }

    if (ops.addTag !== undefined || ops.removeTag !== undefined) {
      const before = task.tags ?? [];
      let after = [...before];
      if (ops.addTag !== undefined && !after.includes(ops.addTag)) {
        after.push(ops.addTag);
      }
      if (ops.removeTag !== undefined) {
        after = after.filter((t) => t !== ops.removeTag);
      }
      if (canonicalValue(before) !== canonicalValue(after)) {
        records.push({ taskId: task.id, field: "tags", before, after });
      }
    }
  }

  records.sort((a, b) =>
    a.taskId === b.taskId ? a.field.localeCompare(b.field) : a.taskId.localeCompare(b.taskId)
  );
  return records;
}

/**
 * Deterministic token over the canonical change set. Key order is fixed
 * explicitly (not object-literal order) so the hash is stable across
 * serializers.
 */
export function computeDryRunToken(changeSet: BulkChangeRecord[]): string {
  const canonical = changeSet.map((r) =>
    JSON.stringify([r.taskId, r.field, canonicalValue(r.before), canonicalValue(r.after)])
  );
  return createHash("sha256").update(canonical.join("\n")).digest("hex");
}

/**
 * Re-check one approved change record against the task's CURRENT state:
 *   - current == before → "pending"  (safe to apply)
 *   - current == after  → "applied"  (already in desired state; skip)
 *   - anything else     → "drift"    (state changed since dry-run; abort)
 */
export function checkRecordDrift(
  record: BulkChangeRecord,
  current: BulkEditTaskState
): DriftVerdict {
  const currentValue: string | string[] =
    record.field === "kind" ? (current.kind ?? DEFAULT_KIND) : (current.tags ?? []);
  const canonical = canonicalValue(currentValue);
  if (canonical === canonicalValue(record.before)) return "pending";
  if (canonical === canonicalValue(record.after)) return "applied";
  return "drift";
}

/** A task excluded from a bulk kind change because it would be stranded (mt#3137). */
export interface BlockedKindChange {
  taskId: string;
  conflict: KindChangeStatusConflict;
}

/**
 * Tasks a bulk `kind` op would strand, and therefore must NOT convert (mt#3137).
 *
 * A heterogeneous bulk re-kind is exactly the amplified form of the
 * single-task bug: each record reports success while landing in a status its
 * new workflow does not recognize. These are reported as blocked instead.
 */
export function computeBlockedKindChanges(
  tasks: BulkEditTaskState[],
  ops: BulkEditOps
): BlockedKindChange[] {
  if (ops.kind === undefined) return [];

  const blocked: BlockedKindChange[] = [];
  for (const task of tasks) {
    const before = task.kind ?? DEFAULT_KIND;
    if (before === ops.kind) continue;
    const conflict = checkKindChangeStatusCompatibility(task.status, before, ops.kind);
    if (conflict) blocked.push({ taskId: task.id, conflict });
  }
  return blocked;
}
