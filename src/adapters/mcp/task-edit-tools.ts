/**
 * Task Edit Tools
 *
 * MCP tools for editing task specifications using familiar editing patterns.
 * These tools work like session.edit_file and session.search_replace but operate
 * on task specs in-memory with backend delegation.
 */
import { z } from "zod";
import { CommandMapper } from "../../mcp/command-mapper";
import {
  getTaskSpecContentFromParams,
  updateTaskFromParams,
  type TaskServiceDeps,
} from "../../domain/tasks";
import { log } from "../../utils/logger";
import { applyEditPattern } from "../../domain/ai/edit-pattern-service";
import { countOccurrences } from "./session-edit-tools";
import { autoIndexTaskEmbedding } from "../shared/commands/tasks/auto-index-embedding";

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
const TaskEditSchema = TaskIdentifierSchema.extend(
  z.object({
    instructions: z.string().describe("Instructions describing the edit to make"),
    content: z.string().describe("The edit content with '// ... existing code ...' markers"),
    dryRun: z.boolean().optional().default(false).describe("Preview changes without applying"),
  }).shape
);

/**
 * Schema for task search and replace operations
 */
const TaskSearchReplaceSchema = TaskIdentifierSchema.extend(
  z.object({
    search: z.string().describe("Text to search for (must be unique in the task spec)"),
    replace: z.string().describe("Text to replace with"),
  }).shape
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
function getTaskDeps(
  container?: import("../../composition/types").AppContainerInterface
): TaskServiceDeps {
  if (container?.has("persistence")) {
    return {
      persistenceProvider: container.get("persistence"),
      taskService: container.has("taskService") ? container.get("taskService") : undefined,
    };
  }
  return {};
}

export function registerTaskEditTools(
  commandMapper: CommandMapper,
  container?: import("../../composition/types").AppContainerInterface
): void {
  // Marker-based spec patching — edits task specs using // ... existing code ... markers
  commandMapper.addCommand({
    name: "tasks.spec.patch",
    description: `Edit a task specification using marker-based patching. Task specs are stored in the database, not the filesystem.

Use this tool to make partial edits to a task spec. Specify each edit with the special comment // ... existing code ... to represent unchanged content between edited sections.

For example:

// ... existing code ...
## New Section
Added content here
// ... existing code ...
## Updated Section
Modified content here
// ... existing code ...

Bias towards repeating as few lines of the original spec as possible. Each edit should contain sufficient context of unchanged lines to resolve ambiguity.

DO NOT omit spans of pre-existing content without using the // ... existing code ... comment. If you omit it, the model may inadvertently delete those sections.

Make all edits to a task spec in a single call instead of multiple calls to the same task.`,
    parameters: TaskEditSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as TaskEditArgs;
      try {
        log.debug("Starting task spec.patch operation", { taskId: typedArgs.taskId });

        // Load current task spec content
        let originalContent = "";
        let specExists = false;

        try {
          const specResult = await getTaskSpecContentFromParams(
            {
              taskId: typedArgs.taskId,
              repo: typedArgs.repo,
              workspace: typedArgs.workspace,
              session: typedArgs.session,
              backend: typedArgs.backend,
            },
            getTaskDeps(container)
          );
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
        await updateTaskFromParams(
          {
            taskId: typedArgs.taskId,
            spec: finalContent,
            repo: typedArgs.repo,
            workspace: typedArgs.workspace,
            session: typedArgs.session,
            backend: typedArgs.backend,
          },
          getTaskDeps(container)
        );

        // Fire-and-forget embedding re-index after spec update
        if (container?.has("persistence")) {
          autoIndexTaskEmbedding(typedArgs.taskId, {
            getPersistenceProvider: () => container.get("persistence"),
            getTaskService: () => container.get("taskService"),
          });
        }

        log.debug("Task spec.patch operation completed", { taskId: typedArgs.taskId });

        return {
          success: true,
          taskId: typedArgs.taskId,
          message: `Successfully updated task ${typedArgs.taskId} specification`,
          instructions: typedArgs.instructions,
        };
      } catch (error) {
        log.error("Task spec.patch operation failed", { taskId: typedArgs.taskId, error });
        throw error;
      }
    },
  });

  // Search-replace on task specs (database-backed, not filesystem)
  commandMapper.addCommand({
    name: "tasks.spec.search_replace",
    description:
      "Replace a single occurrence of text in a task specification. Task specs are stored in the database, not the filesystem.",
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
        const specResult = await getTaskSpecContentFromParams(
          {
            taskId: typedArgs.taskId,
            repo: typedArgs.repo,
            workspace: typedArgs.workspace,
            session: typedArgs.session,
            backend: typedArgs.backend,
          },
          getTaskDeps(container)
        );

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

        // Perform replacement using function-replacer overload to avoid special $-pattern
        // substitutions (e.g. dollar-backtick, dollar-ampersand) in the replace string.
        const replaceValue = typedArgs.replace;
        const newContent = content.replace(typedArgs.search, () => replaceValue);

        // Apply the changes by updating the task
        await updateTaskFromParams(
          {
            taskId: typedArgs.taskId,
            spec: newContent,
            repo: typedArgs.repo,
            workspace: typedArgs.workspace,
            session: typedArgs.session,
            backend: typedArgs.backend,
          },
          getTaskDeps(container)
        );

        // Fire-and-forget embedding re-index after spec update
        if (container?.has("persistence")) {
          autoIndexTaskEmbedding(typedArgs.taskId, {
            getPersistenceProvider: () => container.get("persistence"),
            getTaskService: () => container.get("taskService"),
          });
        }

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
