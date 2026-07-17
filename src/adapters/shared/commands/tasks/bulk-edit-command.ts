/**
 * Bulk Task Edit Command (mt#2819)
 *
 * Safe bulk-mutation primitive: the default call is a dry-run that computes a
 * full per-record change set and mints a deterministic token over it; execute
 * requires that token and refuses when any target's state drifted since the
 * dry-run. The append-only audit events (`task.bulk_edit.dry_run` /
 * `task.bulk_edit.executed`) are the durable token store — a dry-run whose
 * audit row cannot be persisted fails loudly at mint time (an unredeemable
 * token must not exist), and a matching executed event makes re-execution an
 * idempotent no-op.
 *
 * Structurally enforces the mt#2785 rule (bulk shared-state mutations require
 * dry-run scope-match): a diverged change set invalidates the token instead
 * of relying on the operator to notice the divergence.
 */
import { type InferParams } from "../../command-registry";
import { ValidationError, ResourceNotFoundError } from "@minsky/domain/errors/index";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { BaseTaskCommand } from "./base-task-command";
import { tasksBulkEditParams } from "./task-parameters";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import { isKnownKind, WORKFLOWS } from "@minsky/domain/tasks/workflows";
import {
  computeChangeSet,
  computeDryRunToken,
  checkRecordDrift,
  canonicalValue,
  type BulkChangeRecord,
  type BulkEditOps,
} from "@minsky/domain/tasks/bulk-edit";
import { DrizzleEventEmitter } from "@minsky/domain/events/emitter";
import { findEventByToken } from "@minsky/domain/events/query";

/** Loud cap (mt#2817 pattern): refuse oversized target lists explicitly. */
const MAX_BULK_TARGETS = 500;

/**
 * Seam over the audit-event store. Production binds to the system_events
 * table via Drizzle (`DrizzleBulkEditEventStore` below); tests inject a fake.
 */
export interface BulkEditEventStore {
  /** Persist the dry-run record. MUST report failure — the token is unredeemable without it. */
  recordDryRun(payload: Record<string, unknown>): Promise<boolean>;
  /** Persist the execution record (one-shot consumption marker). */
  recordExecuted(payload: Record<string, unknown>): Promise<boolean>;
  /** Load the dry-run payload for a token, or null when unknown. */
  findDryRunPayload(token: string): Promise<Record<string, unknown> | null>;
  /** Return the execution timestamp for a token, or null when never executed. */
  findExecutedAt(token: string): Promise<string | null>;
}

class DrizzleBulkEditEventStore implements BulkEditEventStore {
  constructor(private readonly getPersistenceProvider: () => PersistenceProvider) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async db(): Promise<any | null> {
    const provider = this.getPersistenceProvider() as SqlCapablePersistenceProvider;
    if (!provider.getDatabaseConnection) return null;
    return (await provider.getDatabaseConnection()) ?? null;
  }

  async recordDryRun(payload: Record<string, unknown>): Promise<boolean> {
    const db = await this.db();
    if (!db) return false;
    return new DrizzleEventEmitter(db).tryEmit({ eventType: "task.bulk_edit.dry_run", payload });
  }

  async recordExecuted(payload: Record<string, unknown>): Promise<boolean> {
    const db = await this.db();
    if (!db) return false;
    return new DrizzleEventEmitter(db).tryEmit({ eventType: "task.bulk_edit.executed", payload });
  }

  async findDryRunPayload(token: string): Promise<Record<string, unknown> | null> {
    const db = await this.db();
    if (!db) return null;
    const event = await findEventByToken(db, "task.bulk_edit.dry_run", token);
    return event ? event.payload : null;
  }

  async findExecutedAt(token: string): Promise<string | null> {
    const db = await this.db();
    if (!db) return null;
    const event = await findEventByToken(db, "task.bulk_edit.executed", token);
    return event ? event.createdAt : null;
  }
}

/** Per-record outcome of an execute call. */
interface BulkApplyOutcome {
  taskId: string;
  field: "kind" | "tags";
  outcome: "applied" | "skipped-already-applied" | "failed" | "not-attempted";
  error?: string;
}

type ServiceWithBackendAccess = TaskServiceInterface & {
  parsePrefixFromId(taskId: string): string | null;
  getBackendByPrefix(prefix: string | null): {
    name: string;
    updateTags?: (id: string, tags: string[]) => Promise<void>;
    setTaskKind?: (id: string, kind: string) => Promise<void>;
  } | null;
};

export class TasksBulkEditCommand extends BaseTaskCommand<typeof tasksBulkEditParams> {
  readonly id = "tasks.bulk-edit";
  readonly name = "bulk-edit";
  readonly description =
    "Bulk-edit tasks (kind, tag add/remove) with a mandatory dry-run: the dry-run returns the " +
    "full change set and a token; execute requires the token and aborts on any state drift " +
    "since the dry-run";
  readonly parameters = tasksBulkEditParams;

  constructor(
    private readonly getPersistenceProvider?: () => PersistenceProvider,
    private readonly getTaskService?: () => TaskServiceInterface,
    eventStore?: BulkEditEventStore
  ) {
    super();
    this.eventStore =
      eventStore ??
      new DrizzleBulkEditEventStore(() => {
        if (!this.getPersistenceProvider) {
          throw new Error("Persistence provider not available for bulk-edit event store");
        }
        return this.getPersistenceProvider();
      });
  }

  private readonly eventStore: BulkEditEventStore;

  async execute(params: InferParams<typeof tasksBulkEditParams>) {
    const ids = this.normalizeIds(params.ids);
    const ops = this.validateOps(params);

    if (ids.length === 0) {
      throw new ValidationError("At least one task id is required in `ids`.");
    }
    if (ids.length > MAX_BULK_TARGETS) {
      throw new ValidationError(
        `Bulk edit refused: ${ids.length} targets exceeds the ${MAX_BULK_TARGETS}-target cap. ` +
          "Split the operation into smaller batches (each with its own dry-run + token)."
      );
    }

    const service = this.requireService();

    if (params.execute) {
      return this.executeApproved(params, ids, ops, service);
    }
    return this.executeDryRun(params, ids, ops, service);
  }

  // -------------------------------------------------------------------------
  // Dry-run path
  // -------------------------------------------------------------------------

  private async executeDryRun(
    params: InferParams<typeof tasksBulkEditParams>,
    ids: string[],
    ops: BulkEditOps,
    service: TaskServiceInterface
  ) {
    const tasks = await this.fetchAll(ids, service);
    const changeSet = computeChangeSet(tasks, ops);

    if (changeSet.length === 0) {
      return this.formatResult(
        {
          success: true,
          dryRun: true,
          count: 0,
          targets: ids.length,
          changeSet: [],
          message: `No changes needed — all ${ids.length} target(s) already in the desired state.`,
        },
        params.json
      );
    }

    const token = computeDryRunToken(changeSet);
    const persisted = await this.eventStore.recordDryRun({
      token,
      count: changeSet.length,
      ids,
      edits: this.opsRecord(ops),
      changeSet,
    });
    if (!persisted) {
      throw new ValidationError(
        "Dry-run audit record could not be persisted; refusing to mint an unredeemable token. " +
          "Check DB connectivity and retry."
      );
    }

    const affected = new Set(changeSet.map((r) => r.taskId)).size;
    return this.formatResult(
      {
        success: true,
        dryRun: true,
        token,
        count: changeSet.length,
        targets: ids.length,
        changeSet,
        message:
          `Dry-run: ${changeSet.length} change(s) across ${affected} of ${ids.length} target(s). ` +
          `To apply exactly this change set, re-run with execute: true and token: ${token}`,
      },
      params.json
    );
  }

  // -------------------------------------------------------------------------
  // Execute path
  // -------------------------------------------------------------------------

  private async executeApproved(
    params: InferParams<typeof tasksBulkEditParams>,
    ids: string[],
    ops: BulkEditOps,
    service: TaskServiceInterface
  ) {
    const token = params.token;
    if (!token) {
      throw new ValidationError(
        "execute requires the dry-run token. Run the dry-run first (execute omitted or false), " +
          "review the change set, then re-run with execute: true and the returned token."
      );
    }

    // One-shot consumption: a matching executed event makes this a no-op.
    const executedAt = await this.eventStore.findExecutedAt(token);
    if (executedAt) {
      return this.formatResult(
        {
          success: true,
          executed: false,
          idempotent: true,
          token,
          message: `Token already executed at ${executedAt} — nothing to do (idempotent no-op).`,
        },
        params.json
      );
    }

    const dryRun = await this.eventStore.findDryRunPayload(token);
    if (!dryRun) {
      throw new ValidationError(
        `Unknown dry-run token "${token}". Run the dry-run first and use the token it returns.`
      );
    }

    // The token's approved payload is the authority; refuse a call whose
    // ids/ops disagree with what was approved, instead of silently applying
    // the approved set under mismatched parameters.
    this.assertParamsMatchApproved(dryRun, ids, ops, token);

    const approved = (dryRun.changeSet ?? []) as BulkChangeRecord[];
    const approvedIds = [...new Set(approved.map((r) => r.taskId))];
    const currentTasks = await service.getTasks(approvedIds);
    const currentById = new Map(currentTasks.map((t) => [t.id, t]));

    // Drift check across the full approved set BEFORE any write.
    const drifted: string[] = [];
    const pending: BulkChangeRecord[] = [];
    let applied = 0;
    for (const record of approved) {
      const current = currentById.get(record.taskId);
      if (!current) {
        drifted.push(`${record.taskId} ${record.field}: task no longer exists`);
        continue;
      }
      const verdict = checkRecordDrift(record, current);
      if (verdict === "drift") {
        const found =
          record.field === "kind"
            ? canonicalValue(current.kind ?? "implementation")
            : canonicalValue(current.tags ?? []);
        drifted.push(
          `${record.taskId} ${record.field}: expected ${canonicalValue(record.before)} ` +
            `(or already-applied ${canonicalValue(record.after)}), found ${found}`
        );
      } else if (verdict === "pending") {
        pending.push(record);
      } else {
        applied += 1;
      }
    }

    if (drifted.length > 0) {
      throw new ValidationError(
        `Execute aborted — ${drifted.length} record(s) drifted since the dry-run ` +
          `(no changes applied):\n  ${drifted.join("\n  ")}\n` +
          "Re-run the dry-run to mint a token over the current state."
      );
    }

    if (pending.length === 0) {
      return this.formatResult(
        {
          success: true,
          executed: false,
          idempotent: true,
          token,
          message: `All ${approved.length} approved change(s) already applied — idempotent no-op.`,
        },
        params.json
      );
    }

    const outcomes = await this.applyPending(pending, service);
    const failed = outcomes.filter((o) => o.outcome === "failed");
    const appliedNow = outcomes.filter((o) => o.outcome === "applied").length;

    await this.eventStore.recordExecuted({
      token,
      count: approved.length,
      outcomes: [
        ...outcomes,
        // Records that were already in the desired state at execute time.
        ...approved
          .filter((r) => !pending.includes(r))
          .map((r) => ({
            taskId: r.taskId,
            field: r.field,
            outcome: "skipped-already-applied" as const,
          })),
      ],
    });

    if (failed.length > 0) {
      throw new ValidationError(
        `Execute stopped after a failure: ${appliedNow} applied, ${failed.length} failed, ` +
          `${outcomes.filter((o) => o.outcome === "not-attempted").length} not attempted.\n` +
          `First failure: ${failed[0]?.taskId} ${failed[0]?.field}: ${failed[0]?.error}\n` +
          "Re-run the dry-run to assess current state before retrying."
      );
    }

    return this.formatResult(
      {
        success: true,
        executed: true,
        token,
        applied: appliedNow,
        skippedAlreadyApplied: applied,
        outcomes,
        message: `Applied ${appliedNow} change(s); ${applied} already in desired state.`,
      },
      params.json
    );
  }

  private async applyPending(
    pending: BulkChangeRecord[],
    service: TaskServiceInterface
  ): Promise<BulkApplyOutcome[]> {
    const serviceWithAccess = service as ServiceWithBackendAccess;
    const outcomes: BulkApplyOutcome[] = [];

    // Capability pre-check across ALL pending records before the first write,
    // so an unsupported backend cannot cause a partial application.
    for (const record of pending) {
      const backend = serviceWithAccess.getBackendByPrefix(
        serviceWithAccess.parsePrefixFromId(record.taskId)
      );
      if (!backend) {
        throw new ValidationError(`No backend found for task ID: ${record.taskId}`);
      }
      if (record.field === "kind" && !backend.setTaskKind) {
        throw new ValidationError(
          `Backend "${backend.name}" does not support kind editing (task ${record.taskId}).`
        );
      }
      if (record.field === "tags" && !backend.updateTags) {
        throw new ValidationError(
          `Backend "${backend.name}" does not support tag editing (task ${record.taskId}).`
        );
      }
    }

    let stopped = false;
    for (const record of pending) {
      if (stopped) {
        outcomes.push({ taskId: record.taskId, field: record.field, outcome: "not-attempted" });
        continue;
      }
      const backend = serviceWithAccess.getBackendByPrefix(
        serviceWithAccess.parsePrefixFromId(record.taskId)
      );
      try {
        if (record.field === "kind") {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          await backend!.setTaskKind!(record.taskId, record.after as string);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          await backend!.updateTags!(record.taskId, record.after as string[]);
        }
        outcomes.push({ taskId: record.taskId, field: record.field, outcome: "applied" });
      } catch (error) {
        outcomes.push({
          taskId: record.taskId,
          field: record.field,
          outcome: "failed",
          error: getErrorMessage(error),
        });
        stopped = true;
      }
    }
    return outcomes;
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private normalizeIds(ids: string | string[]): string[] {
    const raw = Array.isArray(ids) ? ids : ids.split(",");
    const normalized = raw
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
      .map((id) => this.validateAndNormalizeTaskId(id));
    return [...new Set(normalized)];
  }

  private validateOps(params: InferParams<typeof tasksBulkEditParams>): BulkEditOps {
    const ops: BulkEditOps = {};
    if (params.kind !== undefined) {
      if (!isKnownKind(params.kind)) {
        const known = Object.keys(WORKFLOWS).join(", ");
        throw new ValidationError(`Unknown task kind: "${params.kind}". Valid kinds: ${known}.`);
      }
      ops.kind = params.kind;
    }
    if (params.addTag !== undefined) {
      if (params.addTag.startsWith("minsky:")) {
        throw new ValidationError('Tags cannot use the reserved "minsky:" prefix.');
      }
      ops.addTag = params.addTag;
    }
    if (params.removeTag !== undefined) {
      ops.removeTag = params.removeTag;
    }
    if (ops.addTag !== undefined && ops.addTag === ops.removeTag) {
      throw new ValidationError("addTag and removeTag name the same tag — contradictory edit.");
    }
    if (ops.kind === undefined && ops.addTag === undefined && ops.removeTag === undefined) {
      throw new ValidationError(
        "At least one edit operation is required: kind, addTag, or removeTag."
      );
    }
    return ops;
  }

  private opsRecord(ops: BulkEditOps): Record<string, string> {
    const record: Record<string, string> = {};
    if (ops.kind !== undefined) record.kind = ops.kind;
    if (ops.addTag !== undefined) record.addTag = ops.addTag;
    if (ops.removeTag !== undefined) record.removeTag = ops.removeTag;
    return record;
  }

  private assertParamsMatchApproved(
    dryRun: Record<string, unknown>,
    ids: string[],
    ops: BulkEditOps,
    token: string
  ): void {
    const approvedIds = [...((dryRun.ids ?? []) as string[])].sort();
    const providedIds = [...ids].sort();
    const approvedEdits = JSON.stringify(dryRun.edits ?? {});
    const providedEdits = JSON.stringify(this.opsRecord(ops));
    if (
      JSON.stringify(approvedIds) !== JSON.stringify(providedIds) ||
      approvedEdits !== providedEdits
    ) {
      throw new ValidationError(
        `Token "${token}" was minted for a different ids/edits combination than this call. ` +
          "Pass the same ids and edit operations as the dry-run, or re-run the dry-run."
      );
    }
  }

  private async fetchAll(ids: string[], service: TaskServiceInterface) {
    const tasks = await service.getTasks(ids);
    const found = new Set(tasks.map((t) => t.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new ResourceNotFoundError(
        `${missing.length} task(s) not found: ${missing.join(", ")}`,
        "task",
        missing.join(", ")
      );
    }
    return tasks;
  }

  private requireService(): TaskServiceInterface {
    if (!this.getTaskService) {
      throw new Error(
        "TaskService not available. Ensure the DI container is initialized with a taskService factory."
      );
    }
    return this.getTaskService();
  }
}

/**
 * Factory function for creating the bulk-edit command
 */
export function createTasksBulkEditCommand(
  getPersistenceProvider?: () => PersistenceProvider,
  getTaskService?: () => TaskServiceInterface,
  eventStore?: BulkEditEventStore
): TasksBulkEditCommand {
  return new TasksBulkEditCommand(getPersistenceProvider, getTaskService, eventStore);
}
