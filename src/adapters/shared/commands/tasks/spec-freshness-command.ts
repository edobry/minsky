/**
 * Task Spec Freshness Command (mt#2826)
 *
 * Checks whether the task/PR refs cited in a task's spec have drifted (changed
 * state) since the spec was last edited — catching the "consume-time" gap
 * between spec authoring and implementation entry in a fast-moving
 * parallel-agent graph. See packages/domain/src/tasks/spec-freshness.ts for
 * the detection core; this command wires it to the same read-only
 * `getTaskFromParams` / `changesetService.get` primitives every other
 * tasks/changeset command already uses.
 */
import { type CommandExecutionContext, type InferParams } from "../../command-registry";
import { getTaskSpecContentFromParams } from "@minsky/domain/tasks";
import { BaseTaskCommand } from "./base-task-command";
import { tasksSpecFreshnessParams } from "./task-parameters";
import { resolveChangesetRepoUrl } from "../changeset/changeset-commands";
import { ResourceNotFoundError } from "@minsky/domain/errors/index";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";

/**
 * Task spec freshness command implementation
 */
export class TasksSpecFreshnessCommand extends BaseTaskCommand<typeof tasksSpecFreshnessParams> {
  readonly id = "tasks.spec.freshness";
  readonly name = "freshness";
  readonly description =
    "Check whether task/PR refs cited in a task's spec changed state after the spec was last edited";
  readonly parameters = tasksSpecFreshnessParams;

  constructor(
    private readonly getPersistenceProvider?: () => PersistenceProvider,
    private readonly getTaskService?: () => TaskServiceInterface
  ) {
    super();
  }

  async execute(
    params: InferParams<typeof tasksSpecFreshnessParams>,
    ctx: CommandExecutionContext
  ) {
    this.debug("Starting tasks.spec.freshness execution");

    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    const deps = {
      persistenceProvider: this.getPersistenceProvider?.(),
      taskService: this.getTaskService?.(),
    };

    // Fetch the citing spec's content + its tracked updatedAt.
    const specResult = await getTaskSpecContentFromParams(
      { ...this.createTaskParams(params), taskId: validatedTaskId },
      deps
    );

    // Lazy imports keep registration-time load cost low, matching the rest
    // of this command family.
    const { getTaskFromParams } = await import("@minsky/domain/tasks");
    const { checkSpecFreshness } = await import("@minsky/domain/tasks/spec-freshness");
    const { createChangesetService } = await import("@minsky/domain/changeset/index");

    const repoUrl = await resolveChangesetRepoUrl(params.repo);
    const changesetService = await createChangesetService(repoUrl);

    const result = await checkSpecFreshness(
      validatedTaskId,
      specResult.content,
      specResult.task?.updatedAt,
      {
        getTaskInfo: async (refTaskId: string) => {
          try {
            const refTask = await getTaskFromParams({ taskId: refTaskId }, deps);
            return refTask ? { status: refTask.status, updatedAt: refTask.updatedAt } : null;
          } catch (err) {
            // Only a genuine "no such task" is a legitimate null (recorded by
            // checkSpecFreshness as skipped: "task not found"). Any OTHER error
            // (DB connection loss, backend outage, malformed ID) must propagate
            // so checkSpecFreshness's own catch records the REAL reason in
            // `skipped` — swallowing it here would mask a backend outage as an
            // indistinguishable "ref doesn't exist" (mt#2826 PR #1996 R1).
            if (err instanceof ResourceNotFoundError) {
              return null;
            }
            throw err;
          }
        },
        getChangesetInfo: async (prNumber: string) => {
          // changesetService.get() returns null/undefined for "not found" —
          // no try/catch needed for that case. A genuine error (network,
          // rate-limit, auth) propagates naturally so checkSpecFreshness
          // records the real reason instead of a misleading "not found".
          const changeset = await changesetService.get(prNumber);
          return changeset ? { status: changeset.status, updatedAt: changeset.updatedAt } : null;
        },
      }
    );

    this.debug("Spec freshness check complete", {
      hasDrift: result.hasDrift,
      driftCount: result.drift.length,
    });

    const message = result.hasDrift
      ? `${result.drift.length} ref(s) cited in ${validatedTaskId}'s spec changed state after the spec was last edited (${specResult.task?.updatedAt?.toISOString() ?? "unknown"})`
      : `No drift — cited refs unchanged since ${validatedTaskId}'s spec was last edited`;

    return this.formatResult(
      this.createSuccessResult(validatedTaskId, message, {
        specUpdatedAt: result.specUpdatedAt,
        hasDrift: result.hasDrift,
        drift: result.drift,
        skipped: result.skipped,
      }),
      params.json
    );
  }
}

/**
 * Factory function for creating command instance
 */
export const createTasksSpecFreshnessCommand = (
  getPersistenceProvider?: () => PersistenceProvider,
  getTaskService?: () => TaskServiceInterface
): TasksSpecFreshnessCommand =>
  new TasksSpecFreshnessCommand(getPersistenceProvider, getTaskService);
