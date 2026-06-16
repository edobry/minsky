/**
 * Task Dispatch Command
 *
 * Composes subtask creation + session start + prompt generation into
 * a single MCP tool for streamlined subagent dispatch.
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
import type { SubagentDispatchTracker } from "../../../../mcp/subagent-dispatch-tracker";
import {
  validateEvidenceArgument,
  type EvidenceArgument,
} from "@minsky/domain/validation/evidence-argument";

const tasksDispatchParams = {
  title: {
    schema: z.string(),
    description: "Title for the new subtask",
    required: true,
  },
  instructions: {
    schema: z.string(),
    description: "Work instructions for the subagent",
    required: true,
  },
  parentTaskId: {
    schema: z.string().optional(),
    description: "Parent task ID — creates a subtask. Omit for a root task.",
    required: false,
  },
  type: {
    schema: z
      .enum(["implementation", "refactor", "review", "cleanup", "audit"])
      .default("implementation"),
    description: "Prompt type for the subagent",
    required: false,
  },
  scope: {
    schema: z.string().optional(),
    description: "Comma-separated file paths to constrain the subagent to",
    required: false,
  },
  description: {
    schema: z.string().optional(),
    description: "Task description/spec content",
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
  title: string;
  instructions: string;
  parentTaskId?: string;
  type: "implementation" | "refactor" | "review" | "cleanup" | "audit";
  scope?: string;
  description?: string;
  premiseClaim: string;
  premiseFalsifier: string;
  premiseEvidence: string;
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
        { action: "tasks_dispatch" }
      );
      log.info("[tasks.dispatch] Evidence gate passed", {
        claim: premise.claim,
        falsifier: premise.falsifier,
      });

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

      // Step 1: Create the task
      log.debug("[tasks.dispatch] Creating task", { title: p.title, parent: p.parentTaskId });
      const { createTaskFromTitleAndSpec } = await import("@minsky/domain/tasks");
      const taskResult = await createTaskFromTitleAndSpec(
        {
          title: p.title,
          spec: p.description || p.instructions,
          workspace: process.cwd(),
        },
        { persistenceProvider: getPersistenceProvider(), taskService: getTaskService() }
      );

      const taskId = taskResult.id;
      log.debug("[tasks.dispatch] Task created", { taskId });

      // Step 2: Add parent edge if parentTaskId provided
      if (p.parentTaskId) {
        try {
          const service = getTaskGraphService();
          await service.addParent(taskId, p.parentTaskId);
          log.debug("[tasks.dispatch] Parent edge added", { taskId, parent: p.parentTaskId });
        } catch (err) {
          log.warn(`[tasks.dispatch] Failed to set parent: ${err}`);
        }
      }

      // Step 3: Start a session for the task
      log.debug("[tasks.dispatch] Starting session", { taskId });
      const { SessionService } = await import("@minsky/domain/session/session-service");
      const { createGitService } = await import("@minsky/domain/git");
      const { createWorkspaceUtils } = await import("@minsky/domain/workspace");
      const { getRepositoryBackendFromConfig } = await import(
        "@minsky/domain/session/repository-backend-detection"
      );
      const { getCurrentSession } = await import("@minsky/domain/workspace");
      const { execAsync } = await import("@minsky/shared/exec");
      const dispatchSessionProvider = await getSessionProvider();
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

      const sessionId =
        typeof sessionResult.sessionId === "string"
          ? sessionResult.sessionId
          : sessionResult.sessionId;
      log.debug("[tasks.dispatch] Session started", { sessionId });

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
        taskId,
        parentTaskId: p.parentTaskId,
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
