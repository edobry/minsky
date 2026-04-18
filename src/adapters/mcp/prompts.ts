import type { MinskyMCPServer } from "../../mcp/server";

/**
 * Register session prompt templates in the MCP prompt registry.
 * These surface as slash commands in Claude Code (e.g., /mcp__minsky__session_implementation).
 */
export function registerPrompts(server: MinskyMCPServer): void {
  // Register one prompt per type. Each prompt's handler calls generateSubagentPrompt
  // with the provided arguments.

  const promptTypes = [
    {
      name: "session_implementation",
      type: "implementation",
      description: "Generate a subagent prompt for implementation work in a session",
    },
    {
      name: "session_refactor",
      type: "refactor",
      description: "Generate a subagent prompt for refactor work in a session",
    },
    {
      name: "session_review",
      type: "review",
      description: "Generate a subagent prompt for review work in a session",
    },
    {
      name: "session_cleanup",
      type: "cleanup",
      description: "Generate a subagent prompt for cleanup work in a session",
    },
    {
      name: "session_audit",
      type: "audit",
      description: "Generate a subagent prompt for post-merge audit in a session",
    },
  ] as const;

  for (const { name, type, description } of promptTypes) {
    server.addPrompt({
      name,
      description,
      handler: async (args: Record<string, unknown>) => {
        const { getSessionFromParams } = await import("../../domain/session");
        const { generateSubagentPrompt } = await import("../../domain/session/prompt-generation");
        const { resolveSessionDirectory } = await import(
          "../../domain/session/resolve-session-directory"
        );

        const task = args.task as string;
        const instructions = (args.instructions as string) || "";

        if (!task) {
          return "Error: 'task' argument is required. Provide a task ID (e.g., mt#756).";
        }

        const session = await getSessionFromParams({ task });
        if (!session) {
          return `Error: No session found for task '${task}'.`;
        }

        const sessionId = session.session;
        const sessionDir = await resolveSessionDirectory(sessionId);
        const taskId = task.replace(/^mt#/, "").replace(/^#/, "");

        const result = generateSubagentPrompt({
          sessionDir,
          sessionId,
          taskId,
          type,
          instructions,
        });

        return result.prompt;
      },
    });
  }
}
