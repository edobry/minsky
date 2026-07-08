/**
 * Task Dispatch Command
 *
 * Composes subtask creation + session start + prompt generation into
 * a single MCP tool for streamlined subagent dispatch.
 *
 * Two modes (mt#2657):
 *   - New-task mode (`title`): create a subtask/root task, start a session, generate a prompt.
 *   - Existing-task mode (`taskId`): walk the task's current status to READY
 *     (TODO -> PLANNING -> READY, skipping already-satisfied steps), start a session, generate
 *     a prompt. Replaces the manual 5-call pipeline (tasks_status_set x2 + session_start +
 *     session_generate_prompt + Agent) for pre-filed tasks (e.g. audit-burndown shape).
 *
 * Guard composition (existing-task mode): the status walk calls `setTaskStatusFromParams` —
 * the same function `tasks_status_set` calls (both resolve the `@minsky/domain/tasks` barrel to
 * `packages/domain/src/tasks.ts`, NOT the transition-validating implementation in
 * `packages/domain/src/tasks/commands/mutation-commands.ts`, which is currently dead code on
 * this path — tracked separately, out of scope here). The bind/advance spec-read guard
 * (`.claude/hooks/check-task-spec-read.ts`) is extended to also match this tool when it carries
 * an existing `taskId`, since the guard is a harness-level PreToolUse hook keyed on tool name
 * and would otherwise never see the internal status-set/session-start calls this command makes
 * in-process. See that hook's `resolveTargetTaskId` for the DISPATCH_TOOL branch.
 *
 * Crash-safety (mt#2695): a dispatch that fails mid-pipeline — after the status walk +
 * session_start but before prompt generation completes — is made re-dispatchable by RESUME,
 * not rollback. A repeat `tasks_dispatch taskId:...` call detects the stranded state (task
 * IN-PROGRESS + a session with `SessionStatus.CREATED`, i.e. no commits yet) and completes the
 * remaining step (prompt generation) against the existing session instead of refusing or
 * rolling back the status/session. Resume was chosen deliberately over rollback: it is
 * idempotent-safe (worst case, a redundant prompt is regenerated for a session that's already
 * in progress), whereas rollback would need to either delete a session that might belong to a
 * human who just ran `session_start` (indistinguishable from a stranded dispatch by the same
 * IN-PROGRESS+CREATED signature) or revert task status — both destructive, neither reversible if
 * the assumption is wrong. See the resume-detection block in `execute()` for the full rationale
 * and its accepted tradeoff.
 */
import { z } from "zod";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";
import { type CommandParameterMap, type InferParams } from "../../command-registry";
import {
  detectAgentHarness,
  hasNativeSubagentSupport,
} from "@minsky/domain/runtime/harness-detection";
import { log } from "@minsky/shared/logger";
import { ValidationError } from "@minsky/domain/errors";
import type { SubagentDispatchTracker } from "../../../../mcp/subagent-dispatch-tracker";
import {
  validateEvidenceArgument,
  type EvidenceArgument,
} from "@minsky/domain/validation/evidence-argument";

const tasksDispatchParams = {
  title: {
    schema: z.string().optional(),
    description:
      "Title for a new subtask. Required unless `taskId` is provided (existing-task mode).",
    required: false,
  },
  taskId: {
    schema: z.string().optional(),
    description:
      "ID of an EXISTING task to dispatch (mt#2657). Alternative to `title`: walks the task's " +
      "current status to READY (TODO -> PLANNING -> READY as needed), starts a session, and " +
      "generates the prompt. Mutually exclusive with `title` (exactly one of the two is " +
      "required — supplying both is rejected), with `parentTaskId` (rejected — existing tasks " +
      "don't get a new parent edge here), and with `description` (rejected — existing-task " +
      "mode targets a task whose spec already exists; passing `description` here would be " +
      "silently ignored, so it's rejected instead). Crash-safety (mt#2695): if a PRIOR dispatch " +
      "for this same taskId crashed after starting a session but before finishing, re-calling " +
      "with the same taskId RESUMES that stranded session (detected via task IN-PROGRESS + an " +
      "untouched/CREATED session) instead of erroring — see the result's `resumed` field.",
    required: false,
  },
  instructions: {
    schema: z.string(),
    description: "Work instructions for the subagent",
    required: true,
  },
  parentTaskId: {
    schema: z.string().optional(),
    description:
      "Parent task ID — creates a subtask. Omit for a root task. Only valid in new-task " +
      "(`title`) mode.",
    required: false,
  },
  type: {
    schema: z
      .enum(["implementation", "refactor", "review", "cleanup", "audit"])
      .default("implementation"),
    description: 'Prompt type for the subagent. Defaults to "implementation" when omitted.',
    required: false,
    // mt#2695: the Zod schema's own `.default("implementation")` above is INERT at both the
    // MCP boundary (convertMcpArgsToParameters, src/adapters/mcp/shared-command-integration.ts)
    // and the CLI boundary (normalizeCliParameters, src/adapters/shared/bridges/parameter-mapper.ts)
    // — neither calls `schema.parse()` on an omitted value; both only consult THIS sibling
    // `defaultValue` field. Omitting it crashed at
    // packages/domain/src/session/prompt-generation.ts:207 (`params.type.charAt(0)`) when a
    // caller omitted `type`. See the defensive `p.type = p.type ?? "implementation"` guard in
    // `execute()` below for the second layer of protection.
    defaultValue: "implementation",
  },
  scope: {
    schema: z.string().optional(),
    description: "Comma-separated file paths to constrain the subagent to",
    required: false,
  },
  description: {
    schema: z.string().optional(),
    description:
      "Task description/spec content for a NEW task. Only valid in new-task (`title`) mode — " +
      "rejected when passed together with `taskId` (existing-task mode).",
    required: false,
  },
  premiseClaim: {
    schema: z.string(),
    description:
      "Evidence gate (mt#2488): the load-bearing premise this dispatch rests on — the " +
      "assumption that, if false, means the dispatch is misdirected. For premise-free / " +
      "greenfield work, state that as the claim. Required: dispatching a subagent on an " +
      "unverified premise (e.g. a fix on a misdiagnosed cause) is the R7 failure this gate retires.",
    required: true,
  },
  premiseFalsifier: {
    schema: z.string(),
    description:
      "Evidence gate (mt#2488): the CHEAPEST check that would disprove `premiseClaim` if it " +
      "were false (e.g. 'is this CI check red on main too?').",
    required: true,
  },
  premiseEvidence: {
    schema: z.string(),
    description:
      "Evidence gate (mt#2488): the result of actually running `premiseFalsifier` — not an " +
      "assertion that you would, the actual outcome.",
    required: true,
  },
} satisfies CommandParameterMap;

interface DispatchParams {
  title?: string;
  taskId?: string;
  instructions: string;
  parentTaskId?: string;
  type: "implementation" | "refactor" | "review" | "cleanup" | "audit";
  scope?: string;
  description?: string;
  premiseClaim: string;
  premiseFalsifier: string;
  premiseEvidence: string;
}

/**
 * Validate the mode-selection params (mt#2657): exactly one of `taskId`/`title` must be
 * supplied (XOR — not "at least one"), and `parentTaskId`/`description` only apply to
 * new-task (`title`) mode.
 *
 * Declared at module scope (not inline in `execute()`) so its `throw new ValidationError`
 * statements live outside the AST `execute()` closure — per ADR-004 / the
 * `custom/no-validation-error-in-execute` lint rule, which flags a `ValidationError` thrown
 * directly inside a command's `execute()` body. `validateEvidenceArgument` (imported from the
 * domain layer) follows the same pattern for the premise gate.
 */
function validateDispatchMode(p: DispatchParams): void {
  if (!p.taskId && !p.title) {
    throw new ValidationError(
      "tasks.dispatch requires either `taskId` (dispatch an existing task) or `title` " +
        "(create a new task)."
    );
  }
  if (p.taskId && p.title) {
    throw new ValidationError(
      "`taskId` and `title` are mutually exclusive; pass exactly one. `taskId` dispatches an " +
        "EXISTING task; `title` creates a NEW one — supplying both is an ambiguous call shape."
    );
  }
  if (p.taskId && p.parentTaskId) {
    throw new ValidationError(
      "`parentTaskId` only applies to new-task creation (`title` mode); existing-task " +
        "dispatch (`taskId`) does not set parent edges. Use tasks_deps_add / " +
        "tasks_graph tooling to manage parent edges for existing tasks."
    );
  }
  if (p.taskId && p.description) {
    throw new ValidationError(
      "`description` only applies to new-task creation (`title` mode) as the new task's spec " +
        "content; existing-task dispatch (`taskId`) targets a task whose spec already exists. " +
        "Passing `description` alongside `taskId` would be silently ignored, which risks " +
        "operator confusion — omit `description` when dispatching an existing task."
    );
  }
}

export function createTasksDispatchCommand(
  getPersistenceProvider: () => PersistenceProvider,
  getSessionProvider: () => Promise<
    import("@minsky/domain/session/types").SessionProviderInterface
  >,
  getTaskGraphService: () => TaskGraphService,
  getTaskService: () => import("@minsky/domain/tasks/taskService").TaskServiceInterface,
  /**
   * Optional tracker for recording subagent invocations (mt#1737).
   * When provided, a pending row is written at dispatch time so that
   * crashed subagents leave a stale-pending row that is classifiable later.
   * When absent (e.g., DB unavailable at startup), the write is skipped silently.
   */
  getTracker?: () => SubagentDispatchTracker | null
) {
  return {
    id: "tasks.dispatch",
    name: "dispatch",
    description:
      "Create a subtask, start a session, and generate a subagent prompt — all in one call",
    parameters: tasksDispatchParams,
    execute: async (params: InferParams<typeof tasksDispatchParams>) => {
      const p = params as DispatchParams;

      // Defensive default (mt#2695): `defaultValue: "implementation"` on the `type` param def
      // above is what actually applies the default at the MCP/CLI boundaries — the Zod
      // schema's `.default(...)` alone never reaches this function's caller. This assignment
      // is a second, cheap layer of protection so any calling path that bypasses the
      // parameter-map layer (a direct `command.execute()` call, a future refactor) still
      // cannot reach `params.type.charAt(0)` in prompt-generation.ts with `type` unset.
      p.type = p.type ?? "implementation";

      // Evidence gate (mt#2488): a subagent dispatch must carry the premise it rests on as
      // a STRUCTURED, mechanically-validated argument — generalizing the mt#2215 forceBypass
      // tool-boundary evidence gate. Dispatching on an unverified premise (R7: a fix subagent
      // spawned on a misdiagnosed CI failure) is the failure this retires. Throws
      // ValidationError when the premise is absent or not well-formed, blocking the dispatch.
      const premise: EvidenceArgument = validateEvidenceArgument(
        {
          claim: p.premiseClaim,
          falsifier: p.premiseFalsifier,
          evidence: p.premiseEvidence,
        },
        { action: "tasks.dispatch" }
      );
      log.info("[tasks.dispatch] Evidence gate passed", {
        claim: premise.claim,
        falsifier: premise.falsifier,
      });

      // Mode selection (mt#2657): `taskId` dispatches an EXISTING task; `title` creates a new
      // one. Exactly one must be supplied — the two modes' remaining params don't compose.
      // Validated before the harness check (like the evidence gate above) so input-shape errors
      // are deterministic regardless of environment/harness capability.
      validateDispatchMode(p);
      const isExistingTaskMode = Boolean(p.taskId);

      const harness = detectAgentHarness();

      if (!hasNativeSubagentSupport()) {
        return {
          success: false,
          error:
            `Standalone agent loop not yet available. ` +
            `Detected harness: "${harness}". ` +
            `This tool currently requires Claude Code for subagent dispatch.`,
          harness,
        };
      }

      // Resolved once, used both by the existing-task-mode resume-detection check (crash-safety,
      // mt#2695 — see below) and by Step 3's session creation further down.
      const dispatchSessionProvider = await getSessionProvider();

      let taskId: string;
      const statusWalk: string[] = [];
      // Set when existing-task mode detects a stranded prior dispatch (crash-safety resume path,
      // mt#2695) — a non-undefined value here skips Step 3's `service.start()` call entirely.
      let resumedSessionId: string | undefined;

      if (isExistingTaskMode) {
        // Existing-task mode (mt#2657): walk the task's current status to READY, calling the
        // SAME domain function `tasks_status_set` calls (`setTaskStatusFromParams`) — see
        // module header "Guard composition" note for what that function does and doesn't
        // enforce today, and the "Crash-safety" note for the resume path below. See module
        // header also for the spec-read guard composition note (enforced by the harness hook,
        // not here).
        const { normalizeTaskIdInput } = await import(
          "@minsky/domain/tasks/commands/shared-helpers"
        );
        taskId = normalizeTaskIdInput(p.taskId);
        log.debug("[tasks.dispatch] Existing-task mode", { taskId });

        const { getTaskStatusFromParams, setTaskStatusFromParams } = await import(
          "@minsky/domain/tasks"
        );
        const { TASK_STATUS } = await import("@minsky/domain/tasks/taskConstants");
        const persistenceProvider = getPersistenceProvider();
        const taskService = getTaskService();

        let status = await getTaskStatusFromParams(
          { taskId },
          { persistenceProvider, taskService }
        );

        if (status === TASK_STATUS.TODO) {
          await setTaskStatusFromParams(
            { taskId, status: TASK_STATUS.PLANNING },
            { persistenceProvider, taskService }
          );
          statusWalk.push(TASK_STATUS.PLANNING);
          status = TASK_STATUS.PLANNING;
        }

        if (status === TASK_STATUS.PLANNING) {
          await setTaskStatusFromParams(
            { taskId, status: TASK_STATUS.READY },
            { persistenceProvider, taskService }
          );
          statusWalk.push(TASK_STATUS.READY);
          status = TASK_STATUS.READY;
        }

        if (status !== TASK_STATUS.READY) {
          // Crash-safety (mt#2695): RESUME, not rollback. Chosen deliberately — see module
          // header. A prior dispatch that crashed AFTER the status walk + session_start but
          // BEFORE prompt generation leaves the task IN-PROGRESS with a freshly-created
          // session that has SessionStatus.CREATED (start-session-operations.ts:392) and no
          // commits — CREATED only ever advances to ACTIVE on a first commit
          // (session-commands.ts:504-507). A repeat dispatch for the same task detects that
          // exact signature and completes the remaining step (prompt generation) against the
          // existing session instead of refusing outright.
          //
          // Resume was picked over rollback because it's idempotent-safe: reusing an untouched
          // session to regenerate a prompt has no destructive failure mode. Rollback (deleting
          // the CREATED session / reverting status) risks discarding a session that a human —
          // not a crashed dispatch — is genuinely about to start working in; there is also no
          // bypass for SessionService.start()'s "actively in use" refusal
          // (start-session-operations.ts:245-249) that a rollback-then-retry design could rely
          // on instead, since `recover` only ever applies to stale/orphaned liveness, never
          // "healthy" (which is what a just-created session always reports).
          //
          // Known tradeoff: this heuristic cannot structurally distinguish "stranded dispatch"
          // from "a human ran session_start moments ago and hasn't committed yet" — both look
          // identical (IN-PROGRESS task + CREATED session). Accepted as a rare, low-cost
          // false-positive: the worst case is a redundant prompt regenerated for a session
          // that's already in progress, not data loss.
          if (status === TASK_STATUS.IN_PROGRESS) {
            const existingSession = await dispatchSessionProvider.getSessionByTaskId(taskId);
            const { SessionStatus } = await import("@minsky/domain/session/types");

            if (existingSession && existingSession.status === SessionStatus.CREATED) {
              resumedSessionId = existingSession.sessionId;
              log.debug("[tasks.dispatch] Detected stranded dispatch — resuming", {
                taskId,
                sessionId: resumedSessionId,
              });
            } else {
              return {
                success: false,
                error:
                  `Task ${taskId} is IN-PROGRESS with no resumable session ${
                    existingSession
                      ? `("${existingSession.sessionId}" already has committed work — status: ` +
                        `${existingSession.status}); another actor may be using it.`
                      : `(no session exists for this task).`
                  } If this is a genuine collision, coordinate with the other actor. If it's ` +
                  `safe to reset, the repair path is via PLANNING — IN-PROGRESS -> READY is NOT ` +
                  `a valid status-machine transition: tasks_status_set taskId:"${taskId}" ` +
                  `status:"PLANNING", then status:"READY", then re-dispatch.`,
                taskId,
                harness,
              };
            }
          } else {
            return {
              success: false,
              error:
                `Task ${taskId} is in status ${status}; tasks.dispatch existing-task mode walks ` +
                `TODO -> PLANNING -> READY automatically but cannot resolve from ${status}. ` +
                `Advance or resolve the task manually (e.g. via tasks_status_set), then dispatch.`,
              taskId,
              harness,
            };
          }
        }
        if (!resumedSessionId) {
          log.debug("[tasks.dispatch] Status walk complete", { taskId, statusWalk, from: status });
        }
      } else {
        // New-task mode: create the task, optionally wire a parent edge.
        log.debug("[tasks.dispatch] Creating task", { title: p.title, parent: p.parentTaskId });
        const { createTaskFromTitleAndSpec } = await import("@minsky/domain/tasks");
        const taskResult = await createTaskFromTitleAndSpec(
          {
            title: p.title as string,
            spec: p.description || p.instructions,
            workspace: process.cwd(),
          },
          { persistenceProvider: getPersistenceProvider(), taskService: getTaskService() }
        );

        taskId = taskResult.id;
        log.debug("[tasks.dispatch] Task created", { taskId });

        if (p.parentTaskId) {
          try {
            const service = getTaskGraphService();
            await service.addParent(taskId, p.parentTaskId);
            log.debug("[tasks.dispatch] Parent edge added", { taskId, parent: p.parentTaskId });
          } catch (err) {
            log.warn(`[tasks.dispatch] Failed to set parent: ${err}`);
          }
        }
      }

      // Step 3: Start a session for the task — SKIPPED when resuming a stranded dispatch
      // (mt#2695; see the resume-detection block above). Calling `service.start()` again here
      // would unconditionally throw "actively in use" against the just-created session (a
      // "healthy"-liveness session per SessionService.start's precondition check —
      // start-session-operations.ts:245-249 — has NO bypass; `recover` only covers
      // stale/orphaned liveness), so a resumed dispatch reuses the existing sessionId directly
      // instead of calling `.start()` at all.
      let sessionId: string;
      if (resumedSessionId) {
        sessionId = resumedSessionId;
        log.debug("[tasks.dispatch] Resuming stranded dispatch — reusing session", {
          taskId,
          sessionId,
        });
      } else {
        log.debug("[tasks.dispatch] Starting session", { taskId });
        const { SessionService } = await import("@minsky/domain/session/session-service");
        const { createGitService } = await import("@minsky/domain/git");
        const { createWorkspaceUtils } = await import("@minsky/domain/workspace");
        const { getRepositoryBackendFromConfig } = await import(
          "@minsky/domain/session/repository-backend-detection"
        );
        const { getCurrentSession } = await import("@minsky/domain/workspace");
        const { execAsync } = await import("@minsky/shared/exec");
        const gitService = createGitService();
        const taskService = getTaskService();

        const service = new SessionService({
          sessionProvider: dispatchSessionProvider,
          gitService,
          taskService,
          workspaceUtils: createWorkspaceUtils(dispatchSessionProvider),
          getCurrentSession: async (repoPath: string) =>
            (await getCurrentSession(repoPath, execAsync, dispatchSessionProvider)) ?? null,
          getRepositoryBackend: getRepositoryBackendFromConfig,
        });

        const sessionResult = await service.start({
          task: taskId,
          quiet: true,
          skipInstall: false,
          noStatusUpdate: false,
        });

        if (!sessionResult?.sessionId) {
          return {
            success: false,
            error: `Task ${taskId} created but session start failed`,
            taskId,
            harness,
          };
        }

        sessionId = sessionResult.sessionId;
        log.debug("[tasks.dispatch] Session started", { sessionId });
      }

      // Step 4: Generate the subagent prompt
      log.debug("[tasks.dispatch] Generating prompt", { taskId, type: p.type });
      const { generateSubagentPrompt } = await import("@minsky/domain/session/prompt-generation");
      const { resolveSessionDirectory } = await import(
        "@minsky/domain/session/resolve-session-directory"
      );

      const sessionProvider = dispatchSessionProvider;
      const sessionDir = await resolveSessionDirectory(sessionId, sessionProvider);
      const plainTaskId = taskId.replace(/^mt#/, "").replace(/^#/, "");

      const scope = p.scope
        ? p.scope
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => (s.startsWith("/") ? s : `${sessionDir}/${s}`))
        : undefined;

      const promptResult = generateSubagentPrompt({
        sessionDir,
        sessionId,
        taskId: plainTaskId,
        type: p.type,
        instructions: p.instructions,
        scope,
      });

      // TODO(mt#441): When native subagent dispatch ships, set _meta["io.minsky/agent_id"]
      // on each MCP request the dispatched subagent makes. The value should be:
      //   `minsky.native-subagent:run:${taskId}@${callerAgentId}`
      // where callerAgentId is the agentId of the dispatching agent (resolved by the server
      // from the current request's extras). The subagent prompt or session record should
      // carry the parent agentId so the subagent knows its parent chain.
      // See: src/domain/agent-identity/resolve.ts for the resolver,
      //      src/domain/agent-identity/layer2.ts for the _meta key constant (AGENT_ID_META_KEY).

      // Step 5 (mt#1737): Write a pending invocation row at dispatch time.
      //
      // Outcome choice: `crashed-no-output` is the pessimistic default that the
      // SubagentStop classifier will overwrite via upsert on subagentSessionId.
      // There is no "pending" enum value in the schema (deferred follow-up).
      // Using `crashed-no-output` ensures that if the SubagentStop hook never
      // fires (process kill, network error), the row describes the worst-case
      // observed state rather than an unresolved placeholder.
      //
      // Correlation key: PR #1053 R1 BLOCKING #1 — the upsert key MUST be the
      // subagent's Minsky session ID, which is known at BOTH dispatch time
      // (here, as `sessionId`) AND SubagentStop time (extracted from `cwd`).
      // The harness's `agent_id` is NOT used as the key — it's stored
      // separately in `agentSessionId` at Stop time. Without this correlation
      // the upsert would fail and the dispatch row would orphan as a duplicate.
      try {
        const tracker = getTracker?.();
        if (tracker) {
          await tracker.recordSubagentInvocation({
            taskId,
            subagentSessionId: sessionId, // Minsky session id of the subagent's workspace
            agentType: promptResult.agentType ?? p.type,
            suggestedModel: promptResult.suggestedModel ?? null,
            startedAt: new Date(),
            outcome: "crashed-no-output",
          });
          log.debug("[tasks.dispatch] Pending invocation row written", { taskId });
        }
      } catch (err) {
        // Non-fatal: fail-safe. The invocation row is best-effort telemetry.
        log.warn(`[tasks.dispatch] Failed to write pending invocation row: ${err}`);
      }

      return {
        success: true,
        mode: isExistingTaskMode ? "existing" : "created",
        taskId,
        parentTaskId: isExistingTaskMode ? undefined : p.parentTaskId,
        statusWalk: isExistingTaskMode ? statusWalk : undefined,
        // mt#2695: true when this dispatch resumed a stranded session left by a prior dispatch
        // that crashed after session creation but before prompt generation, rather than
        // creating a new session.
        resumed: Boolean(resumedSessionId),
        sessionId,
        sessionDir,
        harness,
        prompt: promptResult.prompt,
        suggestedModel: promptResult.suggestedModel,
        agentType: promptResult.agentType,
        skillsEmbedded: promptResult.skillsEmbedded,
        scopeWarning: promptResult.scopeWarning,
        batches: promptResult.batches,
        premise,
      };
    },
  };
}
