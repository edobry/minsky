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
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import { countOccurrences } from "./session-edit-tools";
import { formatLineCount } from "@minsky/domain/ai/edit-pattern-utils";

/** Shape of the collapse detector this module consumes (mt#2577's predicate). */
type CollapseDetector = (
  originalContent: string,
  finalContent: string
) => { originalLines: number; finalLines: number } | null;

/**
 * Throws when the apply model's merge result collapsed the spec (mt#3674).
 *
 * Exported and dependency-injected purely so the refusal is testable without
 * reaching into the handler's dynamic imports: the handler resolves the real
 * `detectSuspiciousCollapse` at call time and passes it in. That keeps this a
 * pure decision over strings — the `assert`-shaped signature is the only IO.
 *
 * The DECISION itself is not defined here; it lives in
 * `@minsky/domain/ai/edit-pattern-utils` alongside the growth guard, shared with
 * `session_edit_file`. This function owns only the spec-surface refusal message,
 * which differs from the file surface in one load-bearing way: a file can be
 * restored from git, a task spec cannot be restored from anything.
 */
/**
 * What the handler should DO with a merge result — the ordering of the collapse guard
 * relative to the dry-run preview and the write, as DATA (mt#3674, PR #2618 R1).
 *
 * Extracted because the ordering was previously enforced only by statement order plus a
 * comment: the guard sat above `if (dryRun)` and above the write, and a refactor moving it
 * below either would have failed no test. That is the same defect class this guard exists to
 * prevent, one level up. Modelling the outcome as a value makes "a collapse refuses BEFORE
 * anything is written, and before a preview is returned" an asserted property rather than an
 * invariant of line numbers. Follows the pure-decision-core pattern (mt#3629).
 *
 * Precedence, and the reason for it:
 *   1. `refuse` — a collapse outranks EVERYTHING, including `dryRun`. A preview that renders a
 *      collapsed body as a normal diff would read as an ordinary large edit.
 *   2. `preview` — dry-run, once the content is known not to be collapsed.
 *   3. `write`.
 */
export type SpecPatchOutcome =
  | { kind: "refuse"; message: string }
  | { kind: "preview" }
  | { kind: "write" };

export function decideSpecPatchOutcome(args: {
  taskId: string;
  originalContent: string;
  finalContent: string;
  allowShrink: boolean;
  dryRun: boolean;
  /** False for a brand-new spec / marker-less full replacement — the guard only covers merges. */
  wasMarkerMerge: boolean;
  detect: CollapseDetector;
}): SpecPatchOutcome {
  if (args.wasMarkerMerge) {
    try {
      assertNoSuspiciousSpecCollapse(
        args.taskId,
        args.originalContent,
        args.finalContent,
        args.allowShrink,
        args.detect
      );
    } catch (err) {
      return { kind: "refuse", message: err instanceof Error ? err.message : String(err) };
    }
  }
  return args.dryRun ? { kind: "preview" } : { kind: "write" };
}

/**
 * What a spec READ result permits, before any merge or write (mt#4108).
 *
 * Sibling of {@link decideSpecPatchOutcome}, same pure-decision-core pattern
 * (mt#3629), one phase earlier: that one decides what to do with a merge RESULT,
 * this one decides whether the read is a basis for doing anything at all.
 *
 * **The distinction it exists to make.** A read that THREW and a spec that is
 * ABSENT both used to land as `specExists === false`, so a transient failure was
 * reported as "task spec is empty or task doesn't exist" — two claims that are
 * both false on that path. An agent told its task does not exist stops trusting
 * the id it was handed.
 *
 * **Why a failed read aborts even with no markers.** The obvious fix is to gate
 * this on `hasMarkers`, matching the branch that raised the misleading error.
 * That leaves a worse hole open. With a failed read AND marker-less content,
 * `specExists` is false, so the mt#2400 fail-closed guard (which fires on
 * `specExists && !hasMarkers`) does NOT fire, and control reaches the direct-write
 * branch for a brand-new spec — replacing a populated spec with the payload.
 * The mt#3674 collapse guard cannot catch it either: it compares against
 * `originalContent`, which is `""` after a failed read, so there is no shrink to
 * detect. A read that threw is not evidence of anything, least of all a licence
 * to overwrite; it aborts unconditionally.
 *
 * Precedence: `read-failed` outranks `absent`, because a read that threw tells
 * us nothing about whether the spec exists.
 */
export type SpecReadOutcome =
  | { kind: "read-failed"; message: string }
  | { kind: "absent-with-markers"; message: string }
  | { kind: "proceed" };

export function decideSpecReadOutcome(args: {
  taskId: string;
  specExists: boolean;
  specReadError: unknown;
  hasMarkers: boolean;
  describeError: (err: unknown) => string;
}): SpecReadOutcome {
  if (args.specReadError) {
    return {
      kind: "read-failed",
      message:
        `Cannot patch task ${args.taskId}: reading its current spec FAILED, so it is unknown ` +
        `whether the spec exists — this is NOT a claim that the task is missing. The spec was ` +
        `NOT modified; retry. Cause: ${args.describeError(args.specReadError)}`,
    };
  }
  if (!args.specExists && args.hasMarkers) {
    return {
      kind: "absent-with-markers",
      message: `Cannot apply edits with existing code markers to task ${args.taskId} - task spec is empty or task doesn't exist`,
    };
  }
  return { kind: "proceed" };
}

export function assertNoSuspiciousSpecCollapse(
  taskId: string,
  originalContent: string,
  finalContent: string,
  allowShrink: boolean,
  detect: CollapseDetector
): void {
  if (allowShrink) return;
  const collapse = detect(originalContent, finalContent);
  if (!collapse) return;

  const dropPct = Math.round((1 - collapse.finalLines / collapse.originalLines) * 100);
  throw new Error(
    `Refusing to patch task ${taskId}: the merge result is dramatically smaller than the ` +
      `original spec (${formatLineCount(collapse.originalLines)} -> ` +
      `${formatLineCount(collapse.finalLines)}, a ${dropPct}% ` +
      `drop). This is the marker-collapse failure (mt#2577/mt#3674): the apply model likely ` +
      `mis-resolved a '// ... existing code ...' marker — check the patch content for stray text ` +
      `outside the intended edit. Re-issue with tighter, smaller marker regions, or pass ` +
      `allowShrink=true if this large deletion is intentional. A task spec has no version ` +
      `history, so this refusal is the only thing standing between a malformed patch and ` +
      `unrecoverable content loss.`
  );
}

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
    allowShrink: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Override the mt#3674 collapse guard, which refuses a merge result dramatically smaller than the original spec. Set true only when the large deletion is intentional."
      ),
  }).shape
);

/**
 * Schema for task search and replace operations
 */
const TaskSearchReplaceSchema = TaskIdentifierSchema.extend(
  z.object({
    search: z
      .string()
      .min(1, "search text must be non-empty")
      .describe("Text to search for (must be unique in the task spec)"),
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

FAIL-CLOSED (mt#2400): patching an EXISTING spec with content that has NO // ... existing code ... marker is REFUSED, because it would silently replace the entire spec. For an intentional full replacement, use tasks_edit with specContent.

COLLAPSE-GUARD (mt#3674): the marker check above validates the MARKER, not the rest of the payload, and the merge is performed by a fast-apply model. A merge result dramatically smaller than the original spec is REFUSED — that is the signature of the model mis-resolving a marker (e.g. because stray text was prefixed before the intended patch body). Re-issue with tighter marker regions, or pass allowShrink=true for an intentional large deletion. Task specs have no version history, so this refusal is the last line before unrecoverable content loss.`,
    parameters: TaskEditSchema,
    getHandler: async () => {
      // mt#1792: defer heavy domain imports until first call.
      const [
        { getTaskSpecContentFromParams, updateTaskFromParams },
        { applyEditPattern },
        { hasExistingCodeMarkers, detectSuspiciousCollapse },
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
          // Distinct from `!specExists` (mt#4108): "the read threw" and "there
          // is no spec" are different facts, and only one of them says anything
          // about whether the task exists.
          let specReadError: unknown = null;

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
            // A THROW here is not the same condition as a spec that is absent
            // (mt#4108). Both used to collapse into `specExists === false`, so a
            // transient read failure — a pool blip, a timeout — was reported to
            // the caller as "task spec is empty or task doesn't exist": two
            // claims that are both FALSE on this path, about a task that exists
            // and a spec that is populated. An agent reading that concludes its
            // id is wrong and goes looking for a task that was there all along.
            //
            // Kept separate so the message below can be, and carried rather than
            // discarded — `getLoggableErrorSummary` keeps the Postgres cause,
            // which on a Drizzle failure sits on `.cause` while `.message` is
            // the query text (mt#3398).
            specReadError = error;
            log.warn(`Task spec read failed for ${typedArgs.taskId}`, {
              error: getLoggableErrorSummary(error),
            });
          }

          const hasMarkers = hasExistingCodeMarkers(typedArgs.content);

          // Read-phase decision as DATA (mt#4108), mirroring
          // `decideSpecPatchOutcome`'s treatment of the merge phase. A failed
          // read outranks the absent-spec branch and aborts regardless of
          // markers — see `decideSpecReadOutcome`'s docblock for why gating it
          // on markers would leave a spec-overwrite path open.
          const readOutcome = decideSpecReadOutcome({
            taskId: typedArgs.taskId,
            specExists,
            specReadError,
            hasMarkers,
            describeError: getLoggableErrorSummary,
          });
          if (readOutcome.kind !== "proceed") {
            throw new Error(readOutcome.message);
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

          // mt#3674 collapse guard. The marker check above validates the MARKER, not the rest
          // of the payload — and the merge is performed by a fast-apply MODEL whose output was
          // previously written unchecked, so a patch carrying a valid marker plus malformed
          // text could come back as anything.
          //
          // Originating incident (mt#3339, 2026-08-04): a stray fragment accidentally prefixed
          // before an otherwise-correct patch body; the model returned a 7-character string; a
          // ~26,000-character spec was destroyed with no error. A task spec has NO version
          // history and no undo, so unlike the file surface this is unrecoverable — which is
          // why leaving this tool the weaker one was backwards.
          //
          // Same predicate as `session_edit_file` (mt#2577), imported rather than re-derived.
          // The guard/preview/write ORDERING is decided as DATA (PR #2618 R1) rather than by
          // statement order: a `refuse` outranks `dryRun`, so a collapsed merge never renders
          // as an ordinary preview and never reaches the write below.
          const outcome = decideSpecPatchOutcome({
            taskId: typedArgs.taskId,
            originalContent,
            finalContent,
            allowShrink: typedArgs.allowShrink,
            dryRun: typedArgs.dryRun,
            wasMarkerMerge: specExists && hasMarkers,
            detect: detectSuspiciousCollapse,
          });
          if (outcome.kind === "refuse") {
            throw new Error(outcome.message);
          }

          if (outcome.kind === "preview") {
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
