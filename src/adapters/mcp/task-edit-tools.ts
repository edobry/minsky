/**
 * Task Edit Tools
 *
 * MCP tools for editing task specifications using familiar editing patterns.
 * These tools work like session.edit_file and session.search_replace but operate
 * on task specs in-memory with backend delegation.
 *
 * mt#1792: heavy handler-module imports deferred into getHandler thunks.
 * Schemas (needed for tools/list metadata) and logger remain top-level.
 */
import { z } from "zod";
import type { CommandMapper } from "../../mcp/command-mapper";
import { log } from "@minsky/shared/logger";
import { countOccurrences } from "./session-edit-tools";

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
    // PR #1103 R1 BLOCKING: instructions is optional. The handler supports two
    // paths: marker-based merge (uses instructions) and full replacement (does
    // not use instructions). Requiring it in all cases tightens the contract
    // unnecessarily and breaks parity with session.edit_file.
    instructions: z
      .string()
      .optional()
      .describe(
        "Optional instructions describing the marker-based edit. Used only on the marker-merge path; ignored for full-replacement writes."
      ),
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

export function registerTaskEditTools(
  commandMapper: CommandMapper,
  container?: import("@minsky/domain/composition/types").AppContainerInterface
): void {
  // Marker-based spec patching — lazy handler (mt#1792)
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

Make all edits to a task spec in a single call instead of multiple calls to the same task.

FAIL-CLOSED (mt#2400): patching an EXISTING spec with content that has NO // ... existing code ... marker is REFUSED, because it would silently replace the entire spec. For an intentional full replacement, use tasks_edit with specContent.`,
    parameters: TaskEditSchema,
    getHandler: async () => {
      // mt#1792: defer heavy domain imports until first call.
      const [
        { getTaskSpecContentFromParams, updateTaskFromParams },
        { applyEditPattern },
        { hasExistingCodeMarkers },
        { autoIndexTaskEmbedding },
        { createSuccessResponse, createErrorResponse },
      ] = await Promise.all([
        import("@minsky/domain/tasks"),
        import("@minsky/domain/ai/edit-pattern-service"),
        import("@minsky/domain/ai/edit-pattern-utils"),
        import("../shared/commands/tasks/auto-index-embedding"),
        import("@minsky/domain/schemas"),
      ]);

      function getTaskDeps(
        c?: import("@minsky/domain/composition/types").AppContainerInterface
      ): import("@minsky/domain/tasks").TaskServiceDeps {
        if (c?.has("persistence")) {
          return {
            persistenceProvider: c.get("persistence"),
            taskService: c.has("taskService") ? c.get("taskService") : undefined,
          };
        }
        return {};
      }

      return async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
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
          } catch (_error) {
            // Spec doesn't exist or task doesn't exist - handle below
            log.debug("Task spec not found or empty", { taskId: typedArgs.taskId });
          }

          const hasMarkers = hasExistingCodeMarkers(typedArgs.content);

          // If spec doesn't exist and we have existing code markers, that's an error
          if (!specExists && hasMarkers) {
            throw new Error(
              `Cannot apply edits with existing code markers to task ${typedArgs.taskId} - task spec is empty or task doesn't exist`
            );
          }

          // mt#2400 fail-closed guard: patching an EXISTING spec with marker-less
          // content routes to a direct full-spec overwrite (the silent
          // content-destruction family — R4, mt#2369). tasks_spec_patch is a
          // partial-edit tool by contract; intentional full replacement has its
          // own explicit path. Refuse rather than silently destroy the spec.
          if (specExists && !hasMarkers) {
            throw new Error(
              `Refusing to patch task ${typedArgs.taskId} with marker-less content: this would silently replace the entire spec. ` +
                `Add '// ... existing code ...' markers around unchanged sections for a partial edit, ` +
                `or use 'tasks_edit' with specContent for an intentional full replacement.`
            );
          }

          let finalContent: string;

          if (specExists && hasMarkers) {
            // Apply the edit pattern using fast-apply providers, passing optional instruction
            finalContent = await applyEditPattern(
              originalContent,
              typedArgs.content,
              typedArgs.instructions
            );
          } else {
            // Direct write for a brand-new spec (specExists === false, no markers)
            finalContent = typedArgs.content;
          }

          if (typedArgs.dryRun) {
            // Return preview information without making changes
            const stats = {
              originalLines: originalContent.split("\n").length,
              newLines: finalContent.split("\n").length,
            };

            // PR #1103 R1 BLOCKING: use the standardized response envelope.
            return createSuccessResponse({
              dryRun: true,
              taskId: typedArgs.taskId,
              message: `Dry-run: Would update task ${typedArgs.taskId} specification`,
              changes: {
                linesAdded: Math.max(0, stats.newLines - stats.originalLines),
                linesRemoved: Math.max(0, stats.originalLines - stats.newLines),
                totalLines: stats.newLines,
              },
              preview: finalContent,
            });
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

          // PR #1103 R1 BLOCKING: use the standardized response envelope.
          return createSuccessResponse({
            taskId: typedArgs.taskId,
            message: `Successfully updated task ${typedArgs.taskId} specification`,
            instructions: typedArgs.instructions,
          });
        } catch (error) {
          log.error("Task spec.patch operation failed", { taskId: typedArgs.taskId, error });
          const errorMessage = error instanceof Error ? error.message : String(error);
          return createErrorResponse(errorMessage, undefined, {
            taskId: typedArgs.taskId,
          });
        }
      };
    },
  });

  // Search-replace on task specs — lazy handler (mt#1792)
  commandMapper.addCommand({
    name: "tasks.spec.search_replace",
    description:
      "Replace a single occurrence of text in a task specification. Task specs are stored in the database, not the filesystem.",
    parameters: TaskSearchReplaceSchema,
    getHandler: async () => {
      // mt#1792: defer heavy domain imports until first call.
      const [
        { getTaskSpecContentFromParams, updateTaskFromParams },
        { autoIndexTaskEmbedding },
        { createSuccessResponse, createErrorResponse },
      ] = await Promise.all([
        import("@minsky/domain/tasks"),
        import("../shared/commands/tasks/auto-index-embedding"),
        import("@minsky/domain/schemas"),
      ]);

      function getTaskDeps(
        c?: import("@minsky/domain/composition/types").AppContainerInterface
      ): import("@minsky/domain/tasks").TaskServiceDeps {
        if (c?.has("persistence")) {
          return {
            persistenceProvider: c.get("persistence"),
            taskService: c.has("taskService") ? c.get("taskService") : undefined,
          };
        }
        return {};
      }

      return async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
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

          // mt#2408: an empty search string has no well-defined occurrences and
          // would otherwise drive an unbounded scan. Reject it explicitly.
          if (typedArgs.search === "") {
            throw new Error(`Search text must be a non-empty string; received an empty string.`);
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

          // PR #1103 R1 BLOCKING: use the standardized response envelope.
          return createSuccessResponse({
            taskId: typedArgs.taskId,
            message: `Successfully replaced text in task ${typedArgs.taskId} specification`,
            search: typedArgs.search,
            replace: typedArgs.replace,
          });
        } catch (error) {
          log.error("Task search_replace operation failed", {
            taskId: typedArgs.taskId,
            error,
          });
          const errorMessage = error instanceof Error ? error.message : String(error);
          return createErrorResponse(errorMessage, undefined, {
            taskId: typedArgs.taskId,
          });
        }
      };
    },
  });
}
