/**
 * Session Workflow Commands
 *
 * Factories for session workflow operations: commit, approve, inspect,
 * review, pr.approve, pr.merge. PR create/edit/list/get/open factories
 * live in their own files and are re-exported here for convenience.
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import {
  sessionApproveCommandParams,
  sessionInspectCommandParams,
  sessionReviewCommandParams,
} from "./session-parameters";
import { sessionCommitCommandParams } from "../session-parameters";
import { type AIReviewResult } from "../../../../domain/ai/review-service";
import type { SessionMergeDependencies } from "../../../../domain/session/session-merge-operations";
import type { PersistenceProvider } from "../../../../domain/persistence/types";
/** Minimal container interface required by buildSessionMergeDeps. */
type MergeDepContainer = { has(key: string): boolean; get(key: string): unknown };

// Re-export PR subcommand factories so consumers can import the full set
// from workflow-commands.
export { createSessionPrCreateCommand } from "./pr-create-command";
export { createSessionPrEditCommand } from "./pr-edit-command";
export { createSessionPrListCommand } from "./pr-list-command";
export { createSessionPrGetCommand } from "./pr-get-command";
export { createSessionPrOpenCommand } from "./pr-open-command";
export { createSessionPrChecksCommand } from "./pr-checks-command";
export { createSessionPrReviewContextCommand } from "./pr-review-context-command";
export { createSessionPrReviewSubmitCommand } from "./pr-review-submit-command";
export { createSessionPrReviewDismissCommand } from "./pr-review-dismiss-command";

export function createSessionCommitCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.commit",
    category: CommandCategory.SESSION,
    name: "commit",
    description: "Commit and push changes within a session workspace",
    parameters: sessionCommitCommandParams,
    execute: withErrorLogging("session.commit", async (params: Record<string, unknown>) => {
      const { sessionCommit } = await import("../../../../domain/session/session-commands");
      const deps = await getDeps();

      const result = await sessionCommit(
        {
          session: (params.sessionId as string | undefined) ?? "",
          message: (params.message as string | undefined) ?? "",
          all: params.all as boolean | undefined,
          amend: params.amend as boolean | undefined,
          noStage: params.noStage as boolean | undefined,
        },
        deps.sessionProvider
      );

      return {
        success: result.success,
        sessionId: params.sessionId,
        commitHash: result.commitHash,
        shortHash: result.shortHash,
        subject: result.subject,
        branch: result.branch,
        authorName: result.authorName,
        authorEmail: result.authorEmail,
        timestamp: result.timestamp,
        message: result.message,
        filesChanged: result.filesChanged,
        insertions: result.insertions,
        deletions: result.deletions,
        files: result.files,
        pushed: result.pushed,
        oneline: params.oneline === true,
        noFiles: params.noFiles === true,
      };
    }),
  };
}

export function createSessionApproveCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.approve",
    category: CommandCategory.SESSION,
    name: "approve",
    description: "Approve a session pull request",
    parameters: sessionApproveCommandParams,
    execute: withErrorLogging(
      "session.approve",
      async (params: Record<string, unknown>, _context) => {
        const { SessionService } = await import("../../../../domain/session/session-service");
        const deps = await getDeps();
        const service = new SessionService(deps);

        const result = await service.approve({
          session: params.name as string | undefined,
          task: params.task as string | undefined,
          repo: params.repo as string | undefined,
          json: params.json as boolean | undefined,
        });

        return { success: true, result };
      }
    ),
  };
}

export function createSessionInspectCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.inspect",
    category: CommandCategory.SESSION,
    name: "inspect",
    description: "Inspect the current session (auto-detected from workspace)",
    parameters: sessionInspectCommandParams,
    execute: withErrorLogging("session.inspect", async (params: Record<string, unknown>) => {
      const { SessionService } = await import("../../../../domain/session/session-service");
      const deps = await getDeps();
      const service = new SessionService(deps);

      const result = await service.inspect({
        json: params.json as boolean | undefined,
      });

      return { success: true, ...(result ?? {}) };
    }),
  };
}

/**
 * Format an AI review result as a human-readable comment.
 */
function formatAIReviewComment(aiResult: AIReviewResult): string {
  const sections: string[] = [];

  sections.push(`## 🤖 AI Code Review`);
  sections.push(`**Overall Score:** ${aiResult.overall.score}/10`);
  sections.push(
    `**Recommendation:** ${aiResult.overall.recommendation.replace("_", " ").toUpperCase()}`
  );
  sections.push(`**Focus Area:** ${aiResult.metadata.focus}`);
  sections.push("");
  sections.push(`### Summary`);
  sections.push(aiResult.overall.summary);

  if (aiResult.suggestions && aiResult.suggestions.length > 0) {
    sections.push("");
    sections.push(`### Key Suggestions`);
    aiResult.suggestions.slice(0, 5).forEach((suggestion: string, i: number) => {
      sections.push(`${i + 1}. ${suggestion}`);
    });
  }

  if (aiResult.fileReviews && aiResult.fileReviews.length > 0) {
    sections.push("");
    sections.push(`### File Reviews`);
    aiResult.fileReviews.slice(0, 3).forEach((file) => {
      sections.push(`- **${file.path}**: Score ${file.score}/10`);
    });
  }

  sections.push("");
  sections.push(
    `*Generated by ${aiResult.metadata.model} in ${aiResult.metadata.analysisTimeMs}ms*`
  );

  return sections.join("\n");
}

/**
 * Add the AI review as a changeset comment. Failures are logged but do not
 * abort the review.
 */
async function handleAutoComment(
  reviewResult: {
    changeset?: {
      id: string;
      metadata?: { github?: { url?: string }; local?: { sessionId?: string } };
    };
  },
  aiResult: AIReviewResult
): Promise<void> {
  const changeset = reviewResult.changeset;
  if (!changeset) return;

  try {
    const { createChangesetService } = await import(
      "../../../../domain/changeset/changeset-service"
    );
    const changesetService = await createChangesetService(
      changeset.metadata?.github?.url || changeset.metadata?.local?.sessionId || "unknown"
    );

    const commentText = formatAIReviewComment(aiResult);
    await changesetService.approve(changeset.id, commentText);
  } catch (error) {
    const { log } = await import("../../../../utils/logger");
    log.warn("Failed to auto-comment AI review:", { error });
  }
}

/**
 * Approve the changeset when the AI score is high enough.
 */
async function handleAutoApprove(
  reviewResult: {
    changeset?: {
      id: string;
      metadata?: { github?: { url?: string }; local?: { sessionId?: string } };
    };
  },
  aiResult: AIReviewResult
): Promise<void> {
  const changeset = reviewResult.changeset;
  if (!changeset || aiResult.overall.score < 8) return;

  try {
    const { createChangesetService } = await import(
      "../../../../domain/changeset/changeset-service"
    );
    const changesetService = await createChangesetService(
      changeset.metadata?.github?.url || changeset.metadata?.local?.sessionId || "unknown"
    );

    const approvalText = `AI Review: ${aiResult.overall.summary} (Score: ${aiResult.overall.score}/10)`;
    await changesetService.approve(changeset.id, approvalText);
  } catch (error) {
    const { log } = await import("../../../../utils/logger");
    log.warn("Failed to auto-approve changeset:", { error });
  }
}

export function createSessionReviewCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.review",
    category: CommandCategory.SESSION,
    name: "review",
    description: "Review a session PR by gathering and displaying relevant information",
    parameters: sessionReviewCommandParams,
    execute: withErrorLogging("session.review", async (params: Record<string, unknown>) => {
      const deps = await getDeps();
      const { sessionReviewImpl } = await import(
        "../../../../domain/session/session-review-operations"
      );

      const reviewResult = await sessionReviewImpl(
        {
          session: (params.session as string | undefined) || (params.name as string | undefined),
          task: params.task as string | undefined,
          repo: params.repo as string | undefined,
          json: params.json as boolean | undefined,
          output: params.output as string | undefined,
          prBranch: params.prBranch as string | undefined,
        },
        {
          sessionDB: deps.sessionProvider,
          gitService: deps.gitService,
          taskService: deps.taskService,
          workspaceUtils: deps.workspaceUtils,
          getCurrentSession: async (repoPath: string) =>
            (await deps.getCurrentSession(repoPath)) ?? undefined,
        }
      );

      if (params.ai && reviewResult.changeset) {
        try {
          const { AIReviewService } = await import("../../../../domain/ai/review-service");
          const { DefaultAICompletionService } = await import(
            "../../../../domain/ai/completion-service"
          );
          const { getConfiguration } = await import("../../../../domain/configuration");

          const configService: {
            loadConfiguration: () => Promise<{ resolved: ReturnType<typeof getConfiguration> }>;
          } = {
            loadConfiguration: () => Promise.resolve({ resolved: getConfiguration() }),
          };
          const aiService = new DefaultAICompletionService(configService);
          const reviewService = new AIReviewService(aiService);

          const aiReviewResult = await reviewService.reviewChangeset(reviewResult.changeset, {
            model: params.model as string | undefined,
            provider: params.provider as string | undefined,
            focus: ((params.focus as string | undefined) || "general") as
              | "style"
              | "security"
              | "performance"
              | "logic"
              | "testing"
              | "general",
            detailed: (params.detailed as boolean | undefined) || false,
            includeTaskSpec: (params.includeTaskSpec as boolean | undefined) || false,
            includeHistory: (params.includeHistory as boolean | undefined) || false,
            temperature: params.temperature as number | undefined,
            maxTokens: params.maxTokens as number | undefined,
          });

          if (params.autoComment && aiReviewResult.overall.recommendation !== "approve") {
            await handleAutoComment(reviewResult, aiReviewResult);
          }

          if (params.autoApprove && aiReviewResult.overall.score >= 8) {
            await handleAutoApprove(reviewResult, aiReviewResult);
          }

          return {
            success: true,
            ...reviewResult,
            aiAnalysis: aiReviewResult,
            enhancedWithAI: true,
          };
        } catch (aiError) {
          const errorMessage = aiError instanceof Error ? aiError.message : String(aiError);
          return {
            success: true,
            ...reviewResult,
            aiAnalysis: null,
            aiError: `AI analysis failed: ${errorMessage}`,
            enhancedWithAI: false,
          };
        }
      }

      return { success: true, ...reviewResult };
    }),
  };
}

export function createSessionPrApproveCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.approve",
    category: CommandCategory.SESSION,
    name: "approve",
    description: "Approve a session pull request (does not merge)",
    parameters: sessionApproveCommandParams,
    execute: withErrorLogging(
      "session.pr.approve",
      async (params: Record<string, unknown>, _context) => {
        const { SessionService } = await import("../../../../domain/session/session-service");
        const deps = await getDeps();
        const service = new SessionService(deps);

        const result = await service.approve({
          session: params.name as string | undefined,
          task: params.task as string | undefined,
          repo: params.repo as string | undefined,
          json: params.json as boolean | undefined,
          reviewComment:
            (params.comment as string | undefined) || (params.reviewComment as string | undefined),
        });

        return { success: true, result };
      }
    ),
  };
}

/**
 * Build the SessionMergeDependencies shape from the adapter's DI deps and
 * command execution container. Exported for unit-testing the DI wiring —
 * see workflow-commands-merge-deps.test.ts (mt#1025).
 */
export function buildSessionMergeDeps(
  deps: Awaited<ReturnType<LazySessionDeps>>,
  container: MergeDepContainer | undefined
): SessionMergeDependencies {
  return {
    sessionDB: deps.sessionProvider,
    taskService: deps.taskService,
    gitService: deps.gitService,
    persistenceProvider: container?.has("persistence")
      ? (container.get("persistence") as PersistenceProvider)
      : undefined,
  };
}

export function createSessionPrMergeCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.merge",
    category: CommandCategory.SESSION,
    name: "merge",
    description: "Merge an approved session pull request",
    parameters: sessionApproveCommandParams, // Reuse same params
    execute: withErrorLogging(
      "session.pr.merge",
      async (params: Record<string, unknown>, context) => {
        const deps = await getDeps();
        const { mergeSessionPr } = await import(
          "../../../../domain/session/session-merge-operations"
        );

        const shouldCleanup = params.skipCleanup !== true;

        const result = await mergeSessionPr(
          {
            session: params.name as string | undefined,
            task: params.task as string | undefined,
            repo: params.repo as string | undefined,
            json: params.json as boolean | undefined,
            cleanupSession: shouldCleanup,
          },
          buildSessionMergeDeps(deps, context.container)
        );

        return { success: true, result, printed: true };
      }
    ),
  };
}
