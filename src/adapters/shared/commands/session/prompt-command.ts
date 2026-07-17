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
  intent: {
    schema: z.enum(["read-only", "implementation"]),
    description:
      'Dispatch intent (mt#2865). Defaults to "implementation" — no behavior change from before ' +
      'this param existed. "read-only" adds an explicit read-only-bound section to the generated ' +
      "prompt AND writes a TTL-bound declaration to the dispatch-intent store for this session — " +
      "the PreToolUse write-gate guard (dispatch-intent-write-gate.ts) then DENIES " +
      "session_commit/session_edit_file/session_write_file/session_search_replace/" +
      "session_pr_create/session_pr_edit for ANY subagent operating in this session while the " +
      "declaration is live, regardless of which specific agent_id makes the call (covers a " +
      "context-inheriting `fork`, not just the dispatched agent itself). Use this for bounded " +
      "lookups (memory search, code investigation, review) dispatched from inside an active " +
      "implementation context — never fork for those; see subagent-routing.mdc.",
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
      const intent = (params.intent as "read-only" | "implementation" | undefined) ?? undefined;

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
        intent,
      });

      // mt#2865: write the dispatch-intent declaration BEFORE the caller
      // dispatches the subagent (this call returns the prompt text; the
      // caller passes it to the Agent tool next) — so the write-gate guard
      // is already live by the time the subagent (or a fork it later
      // spawns, inheriting the SAME session) makes its first tool call.
      // Best-effort: never blocks prompt generation on a store-write
      // failure — the declaration is defense-in-depth, not correctness-
      // critical for the prompt text itself (which already states the
      // read-only bound regardless of whether the write succeeded).
      if (intent === "read-only") {
        try {
          const { declareReadOnlyIntent } = await import(
            "@minsky/domain/session/dispatch-intent-writer"
          );
          const declared = declareReadOnlyIntent(sessionId, {
            issuedBy: `session.generate_prompt:${task}`,
            reason: instructions.slice(0, 300),
          });
          if (!declared) {
            log.warn(
              `[session.generate_prompt] Failed to write read-only dispatch-intent declaration for session ${sessionId}`
            );
          }
        } catch (err) {
          log.warn(`[session.generate_prompt] dispatch-intent declaration write threw: ${err}`);
        }
      }

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
      //
      // R1 BLOCKING fix: `task` is the raw, loosely-formatted caller input
      // (any of "mt#2796" / "2796" / "#2796" — the Zod schema is a bare
      // `z.string()`). Every other writer of `subagent_invocations.task_id`
      // (tasks.dispatch's `taskId`, and the SubagentStop hook's
      // `resolveTaskId`) always produces the qualified "mt#N" form — writing
      // `task` verbatim here would silently store an unqualified id on a
      // bare-numeric or "#N" input, breaking JOINs/reporting against every
      // other qualified taskId in the table.
      //
      // Prefer `session.taskId` — the canonical qualified value already
      // resolved from storage (`service.get({ task })` above), which can't
      // diverge from `session_records.task_id` even when `task` was resolved
      // via auto-detection rather than matched literally. Fall back to
      // `normalizeTaskIdInput` (the same helper dispatch-command.ts uses for
      // its existing-task-mode taskId — NOT `validateQualifiedTaskId`, which
      // qualifies bare input to the legacy "md#" prefix, not "mt#") for the
      // rare case where the resolved session record has no taskId set.
      try {
        const { normalizeTaskIdInput } = await import(
          "@minsky/domain/tasks/commands/shared-helpers"
        );
        const tracker = SubagentDispatchTracker.getInstance();
        await tracker.recordSubagentInvocation({
          taskId: session.taskId ?? normalizeTaskIdInput(task),
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
