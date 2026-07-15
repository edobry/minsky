/**
 * Session Generate Prompt Command
 *
 * Generates complete subagent prompt strings for session work.
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { z } from "zod";
import { SubagentDispatchTracker } from "../../../../mcp/subagent-dispatch-tracker";
import { log } from "@minsky/shared/logger";

const promptCommandParams = {
  task: { schema: z.string(), description: "Task ID (required)", required: true },
  type: {
    schema: z.enum(["implementation", "refactor", "review", "cleanup", "audit"]),
    description: "Prompt type: implementation, refactor, review, cleanup, or audit",
    required: true,
  },
  instructions: {
    schema: z.string(),
    description: "Specific work instructions for the subagent",
    required: true,
  },
  scope: {
    schema: z.string(),
    description: "Comma-separated list of file paths to constrain to",
    required: false,
  },
  omitOperatingEnvelope: {
    schema: z.boolean(),
    description:
      "Suppress the Operating Envelope block (budget awareness, graceful exit, handoff-note convention). Default: envelope is included.",
    required: false,
  },
};

export function createSessionGeneratePromptCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.generate_prompt",
    category: CommandCategory.SESSION,
    name: "generate_prompt",
    description: "Generate a complete subagent prompt for session work",
    parameters: promptCommandParams,
    execute: withErrorLogging("session.generate_prompt", async (params) => {
      const { SessionService } = await import("@minsky/domain/session/session-service");
      const { generateSubagentPrompt } = await import("@minsky/domain/session/prompt-generation");
      const { resolveSessionDirectory } = await import(
        "@minsky/domain/session/resolve-session-directory"
      );

      const deps = await getDeps();
      const service = new SessionService(deps);

      const task = params.task as string;
      const type = params.type as "implementation" | "refactor" | "review" | "cleanup" | "audit";
      const instructions = params.instructions as string;
      const scopeRaw = params.scope as string | undefined;
      const omitOperatingEnvelope = params.omitOperatingEnvelope as boolean | undefined;

      const session = await service.get({ task });

      if (!session) {
        throw new Error(`No session found for task '${task}'`);
      }

      const sessionId = session.sessionId;
      const sessionDir = await resolveSessionDirectory(sessionId, deps.sessionProvider);

      const scope =
        scopeRaw && scopeRaw.trim().length > 0
          ? scopeRaw
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
              .map((s) => (s.startsWith("/") ? s : `${sessionDir}/${s}`))
          : undefined;

      const taskId = task.replace(/^mt#/, "").replace(/^#/, "");

      const result = generateSubagentPrompt({
        sessionDir,
        sessionId,
        taskId,
        type,
        instructions,
        scope,
        omitOperatingEnvelope,
      });

      // mt#2796: write a pending dispatch-time invocation row so
      // `suggested_model` is populated before the subagent even starts,
      // mirroring tasks.dispatch's Step 5 pending-row pattern (see
      // dispatch-command.ts). This is the primary dispatch path — a main
      // agent calling session_generate_prompt directly (per the Subagent
      // Routing convention) then dispatching via the Agent tool — which,
      // unlike tasks_dispatch, previously wrote no row at all until
      // SubagentStop. The SubagentStop hook upserts on subagentSessionId
      // and never clobbers suggestedModel (it doesn't include the field in
      // its own object literal), so this pending row's value survives.
      // Best-effort — never blocks prompt generation on a tracker failure.
      try {
        const tracker = SubagentDispatchTracker.getInstance();
        await tracker.recordSubagentInvocation({
          taskId: task,
          subagentSessionId: sessionId,
          agentType: result.agentType ?? type,
          suggestedModel: result.suggestedModel ?? null,
          startedAt: new Date(),
          outcome: "crashed-no-output",
        });
      } catch (err) {
        log.warn(`[session.generate_prompt] Failed to write pending invocation row: ${err}`);
      }

      return { success: true, ...result };
    }),
  };
}
