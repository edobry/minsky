/**
 * Session PR Edit Command
 */

import {
  CommandCategory,
  type CommandDefinition,
  type CommandExecutionContext,
  type InferParams,
} from "../../command-registry";
import {
  MinskyError,
  SessionConflictError,
  ValidationError,
  getErrorMessage,
} from "@minsky/domain/errors/index";
import { log } from "@minsky/shared/logger";
import { type SessionCommandDependencies, type LazySessionDeps } from "./types";
import { sessionPrEditCommandParams } from "./session-parameters";
import { sessionPrEdit } from "@minsky/domain/session/commands/pr-subcommands";
import { composeConventionalTitle } from "./pr-conventional-title";
import {
  CONVENTIONAL_COMMIT_TYPE_ALTERNATION,
  CONVENTIONAL_COMMIT_TYPES_DISPLAY,
} from "@minsky/domain/git/conventional-commit-types";

export type SessionPrEditParams = InferParams<typeof sessionPrEditCommandParams>;

function handlePrError(error: unknown, params: SessionPrEditParams): Error {
  const errorMessage = getErrorMessage(error);

  if (error instanceof SessionConflictError) {
    return error;
  } else if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
    return new MinskyError(
      `🔥 Git merge conflict detected while updating PR.\n\nThis usually happens when:\n• There are conflicting changes between your session and the base branch\n• The PR branch has diverged from your session\n\n💡 Quick fixes:\n• Resolve conflicts manually and retry\n• Check the current state of your PR branch\n\nTechnical details: ${errorMessage}`
    );
  } else if (errorMessage.includes("No pull request found")) {
    return new MinskyError(
      `🔍 No PR found for this session.\n\nThe session '${params.sessionId || params.task}' doesn't have an existing pull request to edit.\n\n💡 Try:\n• Create a PR first: minsky session pr create --title "..." --body "..."\n• Check available PRs: minsky session pr list\n• Verify you're in the correct session\n\nTechnical details: ${errorMessage}`
    );
  } else if (
    errorMessage.includes("Permission denied") ||
    errorMessage.includes("authentication")
  ) {
    return new MinskyError(
      `🔐 Git authentication error.\n\nPlease check:\n• Your SSH keys are properly configured\n• You have push access to the repository\n• Your git credentials are valid\n\nTechnical details: ${errorMessage}`
    );
  } else if (errorMessage.includes("Session") && errorMessage.includes("not found")) {
    return new MinskyError(
      `🔍 Session not found.\n\nThe session '${params.sessionId || params.task}' could not be located.\n\n💡 Try:\n• Check available sessions: minsky session list\n• Verify you're in the correct directory\n• Use the correct session ID or task ID\n\nTechnical details: ${errorMessage}`
    );
  } else {
    return new MinskyError(
      `❌ Failed to edit session PR: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify the session has an existing PR\n• Try running with --debug for more details\n• Check 'minsky session pr list' to see available sessions\n\nNeed help? Run the command with --debug for detailed error information.`
    );
  }
}

/**
 * Injectable seams for the title-composition path (mt#4138).
 *
 * Both default to the real implementations, so this is an optional-`deps`
 * parameter with a real default — no exported-type change, which is what
 * ADR-036 rule 2 asks for in place of patching a collaborator the code reaches
 * itself. They exist because the composed title is otherwise unobservable: the
 * resolver is a dynamic import and `sessionPrEdit` a static one, so the only
 * way to assert what scope the title carries would be module patching.
 *
 * Deliberately NOT exported (PR #3010 R1): this is test scaffolding, not a
 * contract, and exporting it would imply a public API promise the module does
 * not intend to keep. `executeSessionPrEdit` still accepts it structurally, and
 * a test that needs the type derives it from the function itself via
 * `NonNullable<Parameters<typeof executeSessionPrEdit>[3]>` — so nothing is
 * lost by keeping it file-local.
 */
interface SessionPrEditSeams {
  /** Resolves session context; the real one throws when no session matches. */
  resolveSessionContext?: (options: {
    sessionId?: string;
    task?: string;
    repo?: string;
    sessionProvider: unknown;
    allowAutoDetection: boolean;
  }) => Promise<{ taskId?: string }>;
  /** Performs the actual PR edit. */
  editPr?: typeof sessionPrEdit;
}

/**
 * Pick the task scope for a composed PR title.
 *
 * Pure and total, and deliberately independent of whether session resolution
 * succeeded: `callerTask` was handed in by the caller and needs no resolution
 * to be known, so it stays available even when the resolver throws. A resolved
 * id wins when present (it is the more specific answer); otherwise the
 * caller's own argument is used. Returns undefined only when neither is
 * available — the one case where a scopeless title is correct rather than
 * degraded.
 */
export function pickTitleScope(
  callerTask: string | undefined,
  resolvedTaskId: string | undefined,
  formatForDisplay: (id: string) => string
): string | undefined {
  const preferred = resolvedTaskId || callerTask;
  if (!preferred) return undefined;
  return formatForDisplay(preferred) || undefined;
}

/**
 * Core execute logic for session.pr.edit. Exported for tests.
 */
export async function executeSessionPrEdit(
  deps: SessionCommandDependencies,
  params: SessionPrEditParams,
  context: CommandExecutionContext,
  seams: SessionPrEditSeams = {}
): Promise<Record<string, unknown>> {
  if (!params.title && !params.body && !params.bodyPath) {
    throw new ValidationError(
      'At least one field must be provided to update the PR:\n  --title <text>       Update PR title\n  --body <text>        Update PR body text\n  --body-path <path>   Update PR body from file\n\nExample:\n  minsky session pr edit --title "feat: Updated feature"\n  minsky session pr edit --body-path process/tasks/189/pr.md'
    );
  }

  try {
    let workingDirectory = process.cwd();
    const interfaceType = context.interface as "cli" | "mcp";

    if (interfaceType === "mcp") {
      let sessionId = params.sessionId;
      if (!sessionId && params.task) {
        const { resolveSessionContextWithFeedback } = await import(
          "@minsky/domain/session/session-context-resolver"
        );
        const resolvedContext = await resolveSessionContextWithFeedback({
          task: params.task,
          repo: params.repo,
          sessionProvider: deps.sessionProvider,
          allowAutoDetection: false,
        });
        sessionId = resolvedContext.sessionId;
      }

      if (sessionId) {
        const sessionRecord = await deps.sessionProvider.getSession(sessionId);
        if (sessionRecord) {
          workingDirectory = await deps.sessionProvider.getRepoPath(sessionRecord);
        }
      }
    }

    let finalTitle: string | undefined = params.title;
    let titleScopeDropped = false;
    if (params.title) {
      if (params.type) {
        // Description-only --title + --type: composeConventionalTitle is the
        // SAME shared validator+composer session_pr_create uses (mt#2821) —
        // it validates the description-only portion (length/format) and
        // composes the final title. Do not duplicate the check here; that is
        // exactly what caused create/edit to diverge (edit re-validated a
        // description-only title with different length accounting than
        // create).
        const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");

        // ONLY the resolution is guarded (mt#4138). The previous shape wrapped
        // resolution AND composition in one try, and the catch re-composed with
        // no taskId at all — discarding `params.task`, which the caller had
        // just supplied and which needs no resolution to be known.
        //
        // The trigger is ordinary, not exotic: resolving an explicit `task`
        // whose session no longer exists throws ResourceNotFoundError, and that
        // is a SIBLING of ValidationError, not a subclass, so the guard below
        // cannot catch it. Post-merge session cleanup puts every merged task in
        // exactly that state, so every `pr edit` after a merge lost its scope.
        let resolvedTaskId: string | undefined;
        try {
          const resolveSessionContext =
            seams.resolveSessionContext ??
            (await import("@minsky/domain/session/session-context-resolver"))
              .resolveSessionContextWithFeedback;

          const resolved = await resolveSessionContext({
            sessionId: params.sessionId,
            task: params.task,
            repo: params.repo,
            sessionProvider: deps.sessionProvider,
            allowAutoDetection: true,
          });
          resolvedTaskId = resolved.taskId;
        } catch (err) {
          // A ValidationError here is a real input problem and must reach the
          // caller. Anything else means only that the RESOLVED id is
          // unavailable — it says nothing about the caller-supplied one.
          if (err instanceof ValidationError) {
            throw err;
          }
          log.debug("session.pr.edit: session resolution failed; falling back to caller task", {
            task: params.task,
            error: getErrorMessage(err),
          });
        }

        const titleScope = pickTitleScope(params.task, resolvedTaskId, formatTaskIdForDisplay);

        // Composition sits OUTSIDE the try on purpose: a ValidationError from
        // composeConventionalTitle (bad title format/length) is deterministic
        // regardless of taskId and must propagate. That is what the old catch's
        // rethrow guard existed for; out here it simply propagates.
        finalTitle = composeConventionalTitle({
          type: params.type,
          title: params.title,
          taskId: titleScope,
        });

        // Regression signal: the caller named a task, so the title must carry
        // its scope. Post-fix this can only fire if the id is unformattable —
        // never from a resolution failure. Reported rather than returned
        // silently under `updated: true`.
        if (params.task && !titleScope) {
          titleScopeDropped = true;
          log.warn("session.pr.edit: composed a PR title without the caller's task scope", {
            task: params.task,
          });
        }
      } else {
        // Case-sensitive AND single-space-after-colon on purpose: the
        // commit-msg hook regex (`src/hooks/commit-msg.ts`
        // `CONVENTIONAL_COMMIT_PATTERN`) does NOT use the `i` flag and
        // requires exactly one literal space (`: `). Accepting `Feat(...)`
        // or `feat(scope):  two-spaces` here would let titles through that
        // the hook later rejects at commit time. Keep this validator
        // strictly aligned with the hook (PR #938 R3/R5).
        const conventionalRe = new RegExp(
          `^(${CONVENTIONAL_COMMIT_TYPE_ALTERNATION})(\\([^)]*\\))?: `
        );
        const match = params.title.match(conventionalRe);
        if (!match) {
          throw new ValidationError(
            "Invalid title. Provide either:\n" +
              `  • --type <${CONVENTIONAL_COMMIT_TYPES_DISPLAY.replaceAll(", ", "|")}> with a description-only --title\n` +
              "  • or a full conventional commit title like 'feat(scope): short description'"
          );
        }
        // Validate the description portion (after the "type(scope): "
        // prefix the user typed themselves) with the SAME validator
        // composeConventionalTitle uses above — so a full title supplied
        // directly is held to the same description-length budget as the
        // --type + description-only path, instead of counting the prefix
        // against the budget.
        const { assertValidPrTitle } = await import(
          "@minsky/domain/session/validation/title-validation"
        );
        assertValidPrTitle(params.title.slice(match[0].length));
      }
    }

    const editPr = seams.editPr ?? sessionPrEdit;
    const result = await editPr(
      {
        title: finalTitle,
        body: params.body,
        bodyPath: params.bodyPath,
        sessionId: params.sessionId,
        task: params.task,
        repo: params.repo,
        debug: params.debug,
      },
      { sessionDB: deps.sessionProvider },
      {
        interface: interfaceType,
        workingDirectory,
      }
    );

    return {
      success: true,
      prBranch: result.prBranch,
      baseBranch: result.baseBranch,
      title: result.title,
      body: result.body,
      updated: result.updated,
      titleScopeDropped,
    };
  } catch (error) {
    throw handlePrError(error, params);
  }
}

export function createSessionPrEditCommand(
  getDeps: LazySessionDeps
): CommandDefinition<typeof sessionPrEditCommandParams> {
  return {
    id: "session.pr.edit",
    category: CommandCategory.SESSION,
    name: "edit",
    description: "Update an existing pull request for a session",
    parameters: sessionPrEditCommandParams,
    mutating: true,
    execute: async (params, context) => {
      try {
        const deps = await getDeps();
        return await executeSessionPrEdit(deps, params, context);
      } catch (error) {
        log.debug(`Error in session.pr.edit`, {
          params,
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    },
  };
}
