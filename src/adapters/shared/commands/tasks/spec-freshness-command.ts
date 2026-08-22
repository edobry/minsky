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
// Type-only: erased at build time, so it does not affect the lazy-import
// load-cost rationale below.
import type { SpecFreshnessDeps } from "@minsky/domain/tasks/spec-freshness";

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
    private readonly getTaskService?: () => TaskServiceInterface,
    /**
     * Resolves a cited PR ref. Left unset in production, where the command
     * builds one from the repo's changeset service.
     *
     * Injected rather than patched so this command's baseline-selection logic
     * — the whole subject of mt#4415 — is testable without a live repo or a
     * network call: a spec citing only `mt#N` refs never invokes it, but the
     * changeset service would still be CONSTRUCTED, which is what made the
     * defect untestable at this seam before.
     */
    private readonly getChangesetInfoOverride?: SpecFreshnessDeps["getChangesetInfo"]
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

    // `??` short-circuits, so an injected resolver skips repo resolution and
    // changeset-service construction entirely.
    const getChangesetInfo =
      this.getChangesetInfoOverride ??
      (await (async () => {
        const { createChangesetService } = await import("@minsky/domain/changeset/index");
        const repoUrl = await resolveChangesetRepoUrl(params.repo);
        const changesetService = await createChangesetService(repoUrl);
        return async (prNumber: string) => {
          // changesetService.get() returns null/undefined for "not found" —
          // no try/catch needed for that case. A genuine error (network,
          // rate-limit, auth) propagates naturally so checkSpecFreshness
          // records the real reason instead of a misleading "not found".
          const changeset = await changesetService.get(prNumber);
          return changeset ? { status: changeset.status, updatedAt: changeset.updatedAt } : null;
        };
      })());

    const result = await checkSpecFreshness(
      validatedTaskId,
      specResult.content,
      // The spec-CONTENT timestamp, NOT `specResult.task?.updatedAt` (mt#4415).
      // The tasks-table row timestamp is bumped by ANY mutation, so reading it
      // here moved the baseline to ~now for every caller that transitions
      // status before checking — which `/plan-task` does on every run, making
      // the check vacuous exactly where it was most needed. When this is
      // undefined the core reports `checked: false` rather than a clean pass.
      specResult.specUpdatedAt,
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
        getChangesetInfo,
      }
    );

    this.debug("Spec freshness check complete", {
      checked: result.checked,
      hasDrift: result.hasDrift,
      driftCount: result.drift.length,
    });

    // Three outcomes, not two. The not-checked case previously rendered as the
    // clean-pass message, which is the reporting half of the mt#4415 defect: a
    // check that could not run must not read as a check that passed.
    let message: string;
    if (!result.checked) {
      message =
        `NOT CHECKED — ${validatedTaskId} has no spec-content timestamp to baseline against, ` +
        `so none of its cited refs were compared. This is not a clean result.`;
    } else if (result.hasDrift) {
      message = `${result.drift.length} ref(s) cited in ${validatedTaskId}'s spec changed state after the spec content was last edited (${result.specUpdatedAt})`;
    } else {
      message = `No drift — cited refs unchanged since ${validatedTaskId}'s spec content was last edited (${result.specUpdatedAt})`;
    }

    return this.formatResult(
      this.createSuccessResult(validatedTaskId, message, {
        specUpdatedAt: result.specUpdatedAt,
        checked: result.checked,
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
  getTaskService?: () => TaskServiceInterface,
  getChangesetInfoOverride?: SpecFreshnessDeps["getChangesetInfo"]
): TasksSpecFreshnessCommand =>
  new TasksSpecFreshnessCommand(getPersistenceProvider, getTaskService, getChangesetInfoOverride);
