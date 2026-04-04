/**
 * Task Edit Tools
 *
 * MCP tools for editing task specifications using familiar editing patterns.
 * These tools work like session.edit_file and session.search_replace but operate
 * on task specs in-memory with backend delegation.
 */
import { z } from "zod";
import { CommandMapper } from "../../mcp/command-mapper";
import { getTaskSpecContentFromParams, updateTaskFromParams } from "../../domain/tasks";
import { log } from "../../utils/logger";
import { applyEditPattern, countOccurrences } from "./session-edit-tools";

// ========================
// SCHEMAS
// ========================

/**
 * Base schema for task operations
 */
const TaskIdentifierSchema = z.object({
  taskId: z.string().describe("Task identifier (e.g., mt#123, md#456)"),
  repo: z.string().optional().describe("Repository path"),
  workspace: z.string().optional().describe("Workspace path"),
  session: z.string().optional().describe("Session identifier"),
  backend: z.string().optional().describe("Backend type"),
});

/**
 * Schema for task edit operations
 */
const TaskEditSchema = TaskIdentifierSchema.merge(
  z.object({
    instructions: z.string().describe("Instructions describing the edit to make"),
    content: z.string().describe("The edit content with '// ... existing code ...' markers"),
    dryRun: z.boolean().optional().default(false).describe("Preview changes without applying"),
  })
);

/**
 * Schema for task search and replace operations
 */
const TaskSearchReplaceSchema = TaskIdentifierSchema.merge(
  z.object({
    search: z.string().describe("Text to search for (must be unique in the task spec)"),
    replace: z.string().describe("Text to replace with"),
  })
);

// ========================
// TYPE DEFINITIONS
// ========================

type TaskEditArgs = z.infer<typeof TaskEditSchema>;
type TaskSearchReplaceArgs = z.infer<typeof TaskSearchReplaceSchema>;

// ========================
// TOOL REGISTRATION
// ========================

/**
 * Registers task-aware editing tools with the MCP command mapper
 */
export function registerTaskEditTools(commandMapper: CommandMapper): void {
  // Task edit file tool - works like session.edit_file but for task specs
  commandMapper.addCommand({
    name: "tasks.edit_file",
    description: `Edit a task specification using familiar file editing patterns. Works exactly like session.edit_file but operates on task specs in-memory with backend delegation.

Use this tool to make edits to a task specification. You should make it clear what the edit is, while also minimizing the unchanged content you write.

When writing the edit, you should specify each edit in sequence, with the special comment // ... existing code ... to represent unchanged content in between edited lines.

For example:

// ... existing code ...
## New Section
Added content here
// ... existing code ...
## Updated Section
Modified content here
// ... existing code ...

You should still bias towards repeating as few lines of the original spec as possible to convey the change. But, each edit should contain sufficient context of unchanged lines around the content you're editing to resolve ambiguity.

DO NOT omit spans of pre-existing content without using the // ... existing code ... comment to indicate its absence. If you omit the existing code comment, the model may inadvertently delete these sections.

If you plan on deleting a section, you must provide context before and after to delete it. Make sure it is clear what the edit should be, and where it should be applied.

Make edits to a task spec in a single edit_file call instead of multiple edit_file calls to the same task. The apply model can handle many distinct edits at once.`,
    parameters: TaskEditSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as TaskEditArgs;
      try {
        log.debug("Starting task edit_file operation", { taskId: typedArgs.taskId });

        // Load current task spec content
        let originalContent = "";
        let specExists = false;

        try {
          const specResult = await getTaskSpecContentFromParams({
            taskId: typedArgs.taskId,
            repo: typedArgs.repo,
            workspace: typedArgs.workspace,
            session: typedArgs.session,
            backend: typedArgs.backend,
          });
          if (specResult?.content) {
            originalContent = specResult.content;
            specExists = true;
          }
        } catch (error) {
          // Spec doesn't exist or task doesn't exist - handle below
          log.debug("Task spec not found or empty", { taskId: typedArgs.taskId });
        }

        // If spec doesn't exist and we have existing code markers, that's an error
        if (!specExists && typedArgs.content.includes("// ... existing code ...")) {
          throw new Error(
            `Cannot apply edits with existing code markers to task ${typedArgs.taskId} - task spec is empty or task doesn't exist`
          );
        }

        let finalContent: string;

        if (specExists && typedArgs.content.includes("// ... existing code ...")) {
          // Apply the edit pattern using fast-apply providers, passing optional instruction
          finalContent = await applyEditPattern(
            originalContent,
            typedArgs.content,
            typedArgs.instructions
          );
        } else {
          // Direct write for new specs or complete replacements
          finalContent = typedArgs.content;
        }

        if (typedArgs.dryRun) {
          // Return preview information without making changes
          const stats = {
            originalLines: originalContent.split("\n").length,
            newLines: finalContent.split("\n").length,
          };

          return {
            success: true,
            dryRun: true,
            taskId: typedArgs.taskId,
            message: `Dry-run: Would update task ${typedArgs.taskId} specification`,
            changes: {
              linesAdded: Math.max(0, stats.newLines - stats.originalLines),
              linesRemoved: Math.max(0, stats.originalLines - stats.newLines),
              totalLines: stats.newLines,
            },
            preview: finalContent,
          };
        }

        // Apply the changes by updating the task
        await updateTaskFromParams({
          taskId: typedArgs.taskId,
          spec: finalContent,
          repo: typedArgs.repo,
          workspace: typedArgs.workspace,
          session: typedArgs.session,
          backend: typedArgs.backend,
        });

        log.debug("Task edit_file operation completed", { taskId: typedArgs.taskId });

        return {
          success: true,
          taskId: typedArgs.taskId,
          message: `Successfully updated task ${typedArgs.taskId} specification`,
          instructions: typedArgs.instructions,
        };
      } catch (error) {
        log.error("Task edit_file operation failed", { taskId: typedArgs.taskId, error });
        throw error;
      }
    },
  });

  // Task search replace tool - works like session.search_replace but for task specs
  commandMapper.addCommand({
    name: "tasks.search_replace",
    description:
      "Replace a single occurrence of text in a task specification. Works exactly like session.search_replace but operates on task specs in-memory with backend delegation.",
    parameters: TaskSearchReplaceSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as TaskSearchReplaceArgs;
      try {
        // Validate required parameters to catch parameter naming mismatches early
        if (typedArgs.search == null || typeof typedArgs.search !== "string") {
          const receivedKeys = Object.keys(typedArgs).join(", ");
          throw new Error(
            `Missing required parameter "search". Received parameters: [${receivedKeys}]. ` +
              `Expected: taskId, search, replace`
          );
        }
        if (typedArgs.replace == null || typeof typedArgs.replace !== "string") {
          const receivedKeys = Object.keys(typedArgs).join(", ");
          throw new Error(
            `Missing required parameter "replace". Received parameters: [${receivedKeys}]. ` +
              `Expected: taskId, search, replace`
          );
        }

        log.debug("Starting task search_replace operation", { taskId: typedArgs.taskId });

        // Load current task spec content
        const specResult = await getTaskSpecContentFromParams({
          taskId: typedArgs.taskId,
          repo: typedArgs.repo,
          workspace: typedArgs.workspace,
          session: typedArgs.session,
          backend: typedArgs.backend,
        });

        if (!specResult?.content) {
          throw new Error(`Task ${typedArgs.taskId} has no specification content to search in`);
        }

        const content = specResult.content;

        // Count occurrences
        const occurrences = countOccurrences(content, typedArgs.search);

        if (occurrences === 0) {
          throw new Error(
            `Search text not found in task ${typedArgs.taskId}: "${typedArgs.search}"`
          );
        }

        if (occurrences > 1) {
          throw new Error(
            `Search text found ${occurrences} times in task ${typedArgs.taskId}. Please provide more context to make it unique.`
          );
        }

        // Perform replacement
        const newContent = content.replace(typedArgs.search, typedArgs.replace);

        // Apply the changes by updating the task
        await updateTaskFromParams({
          taskId: typedArgs.taskId,
          spec: newContent,
          repo: typedArgs.repo,
          workspace: typedArgs.workspace,
          session: typedArgs.session,
          backend: typedArgs.backend,
        });

        log.debug("Task search_replace operation completed", {
          taskId: typedArgs.taskId,
          searchLength: typedArgs.search.length,
          replaceLength: typedArgs.replace.length,
        });

        return {
          success: true,
          taskId: typedArgs.taskId,
          message: `Successfully replaced text in task ${typedArgs.taskId} specification`,
          search: typedArgs.search,
          replace: typedArgs.replace,
        };
      } catch (error) {
        log.error("Task search_replace operation failed", { taskId: typedArgs.taskId, error });
        throw error;
      }
    },
  });
}
