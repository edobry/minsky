/**
 * Session Workflow Commands
 *
 * Commands for session workflow operations (approve, pr, inspect).
 * Extracted from session.ts as part of modularization effort.
 *
 * Replaced single "session pr" with subcommands (create, list, get)
 */
import { z } from "zod";
import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import {
  sessionApproveCommandParams,
  sessionInspectCommandParams,
  sessionReviewCommandParams,
} from "./session-parameters";
import { sessionCommitCommandParams } from "../session-parameters";

// Import the new PR subcommand classes
import {
  SessionPrCreateCommand,
  SessionPrEditCommand,
  SessionPrListCommand,
  SessionPrGetCommand,
  SessionPrOpenCommand,
} from "./pr-subcommand-commands";

/**
 * Session Commit Command
 *
 * Commits and pushes changes within a session workspace
 */
export class SessionCommitCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.commit";
  }

  getCommandName(): string {
    return "commit";
  }

  getCommandDescription(): string {
    return "Commit and push changes within a session workspace";
  }

  getParameterSchema(): Record<string, any> {
    return sessionCommitCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { sessionCommit } = await import("../../../../domain/session/session-commands");

    const result = await sessionCommit({
      session: params.sessionName,
      message: params.message,
      all: params.all,
      amend: params.amend,
      noStage: params.noStage,
    });

    return this.createSuccessResult({
      success: result.success,
      sessionName: params.sessionName,
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
    });
  }
}

/**
 * Session Approve Command
 */
export class SessionApproveCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.approve";
  }

  getCommandName(): string {
    return "approve";
  }

  getCommandDescription(): string {
    return "Approve a session pull request";
  }

  getParameterSchema(): Record<string, any> {
    return sessionApproveCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { approveSessionFromParams } = await import("../../../../domain/session");

    const result = await approveSessionFromParams({
      session: params.name,
      task: params.task,
      repo: params.repo,
      json: params.json,
    });

    return this.createSuccessResult({ result });
  }
}

/**
 * Session Inspect Command
 */
export class SessionInspectCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.inspect";
  }

  getCommandName(): string {
    return "inspect";
  }

  getCommandDescription(): string {
    return "Inspect the current session (auto-detected from workspace)";
  }

  getParameterSchema(): Record<string, any> {
    return sessionInspectCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { inspectSessionFromParams } = await import("../../../../domain/session");

    const result = await inspectSessionFromParams({
      json: params.json,
    });

    return this.createSuccessResult(result);
  }
}

/**
 * Session Review Command
 */
export class SessionReviewCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.review";
  }

  getCommandName(): string {
    return "review";
  }

  getCommandDescription(): string {
    return "Review a session PR by gathering and displaying relevant information";
  }

  getParameterSchema(): Record<string, any> {
    return sessionReviewCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { sessionReviewImpl } = await import(
      "../../../../domain/session/session-review-operations"
    );

    // Get basic session review data (with changeset integration)
    const reviewResult = await sessionReviewImpl({
      session: params.session || params.name,
      task: params.task,
      repo: params.repo,
      json: params.json,
      output: params.output,
      prBranch: params.prBranch,
    });

    // If AI analysis is requested, enhance with AI review
    if (params.ai && reviewResult.changeset) {
      try {
        // Import AI services
        const { AIReviewService } = await import("../../../../domain/ai/review-service");
        const { DefaultAICompletionService } = await import(
          "../../../../domain/ai/completion-service"
        );
        const { ConfigurationService } = await import("../../../../domain/configuration");

        // Create AI completion service
        const configService = new ConfigurationService(process.cwd());
        const aiService = new DefaultAICompletionService(configService);
        const reviewService = new AIReviewService(aiService);

        // Perform AI analysis
        const aiReviewResult = await reviewService.reviewChangeset(reviewResult.changeset, {
          model: params.model,
          provider: params.provider,
          focus: params.focus || "general",
          detailed: params.detailed || false,
          includeTaskSpec: params.includeTaskSpec || false,
          includeHistory: params.includeHistory || false,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
        });

        // Handle AI actions if requested
        if (params.autoComment && aiReviewResult.overall.recommendation !== "approve") {
          await this.handleAutoComment(reviewResult, aiReviewResult);
        }

        if (params.autoApprove && aiReviewResult.overall.score >= 8) {
          await this.handleAutoApprove(reviewResult, aiReviewResult);
        }

        // Return enhanced result with AI analysis
        return this.createSuccessResult({
          ...reviewResult,
          aiAnalysis: aiReviewResult,
          enhancedWithAI: true,
        });
      } catch (aiError) {
        // If AI analysis fails, return basic result with error info
        const errorMessage = aiError instanceof Error ? aiError.message : String(aiError);
        return this.createSuccessResult({
          ...reviewResult,
          aiAnalysis: null,
          aiError: `AI analysis failed: ${errorMessage}`,
          enhancedWithAI: false,
        });
      }
    }

    // Return basic review result
    return this.createSuccessResult(reviewResult);
  }

  /**
   * Handle auto-comment action: add AI review as changeset comment
   */
  private async handleAutoComment(reviewResult: any, aiResult: any): Promise<void> {
    if (!reviewResult.changeset) return;

    try {
      const { createChangesetService } = await import(
        "../../../../domain/changeset/changeset-service"
      );
      const changesetService = await createChangesetService(
        reviewResult.changeset.metadata?.github?.url ||
          reviewResult.changeset.metadata?.local?.sessionName ||
          "unknown"
      );

      // Get adapter to submit comment
      const adapter = await changesetService.getAdapter();
      if (adapter && typeof adapter.approve === "function") {
        const commentText = this.formatAIReviewComment(aiResult);
        await adapter.approve(reviewResult.changeset.id, commentText);
      }
    } catch (error) {
      // Log error but don't fail the entire review
      const { log } = await import("../../../../utils/logger");
      log.warn("Failed to auto-comment AI review:", { error });
    }
  }

  /**
   * Handle auto-approve action: approve changeset if AI score is high
   */
  private async handleAutoApprove(reviewResult: any, aiResult: any): Promise<void> {
    if (!reviewResult.changeset || aiResult.overall.score < 8) return;

    try {
      const { createChangesetService } = await import(
        "../../../../domain/changeset/changeset-service"
      );
      const changesetService = await createChangesetService(
        reviewResult.changeset.metadata?.github?.url ||
          reviewResult.changeset.metadata?.local?.sessionName ||
          "unknown"
      );

      // Get adapter to approve
      const adapter = await changesetService.getAdapter();
      if (adapter && typeof adapter.approve === "function") {
        const approvalText = `AI Review: ${aiResult.overall.summary} (Score: ${aiResult.overall.score}/10)`;
        await adapter.approve(reviewResult.changeset.id, approvalText);
      }
    } catch (error) {
      // Log error but don't fail the entire review
      const { log } = await import("../../../../utils/logger");
      log.warn("Failed to auto-approve changeset:", { error });
    }
  }

  /**
   * Format AI review result as a comment
   */
  private formatAIReviewComment(aiResult: any): string {
    const sections = [];

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
      aiResult.fileReviews.slice(0, 3).forEach((file: any) => {
        sections.push(`- **${file.path}**: Score ${file.score}/10`);
      });
    }

    sections.push("");
    sections.push(
      `*Generated by ${aiResult.metadata.model} in ${aiResult.metadata.analysisTimeMs}ms*`
    );

    return sections.join("\n");
  }
}

/**
 * Session PR Approve Command (Task #358 - New Structure)
 */
export class SessionPrApproveCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.pr.approve";
  }

  getCommandName(): string {
    return "approve";
  }

  getCommandDescription(): string {
    return "Approve a session pull request (does not merge)";
  }

  getParameterSchema(): Record<string, any> {
    return sessionApproveCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { approveSessionFromParams } = await import("../../../../domain/session");

    const result = await approveSessionFromParams({
      session: params.name,
      task: params.task,
      repo: params.repo,
      json: params.json,
      reviewComment: params.comment || params.reviewComment,
    });

    return this.createSuccessResult({ result });
  }
}

/**
 * Session PR Merge Command (Task #358 - New Structure)
 */
export class SessionPrMergeCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.pr.merge";
  }

  getCommandName(): string {
    return "merge";
  }

  getCommandDescription(): string {
    return "Merge an approved session pull request";
  }

  getParameterSchema(): Record<string, any> {
    return sessionApproveCommandParams; // Reuse same params for now
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { mergeSessionPr } = await import("../../../../domain/session/session-merge-operations");

    // Cleanup is enabled by default, but can be disabled with --skip-cleanup
    const shouldCleanup = params.skipCleanup !== true;

    const result = await mergeSessionPr({
      session: params.name,
      task: params.task,
      repo: params.repo,
      json: params.json,
      cleanupSession: shouldCleanup,
    });

    return this.createSuccessResult({ result, printed: true });
  }
}

// Export the imported PR subcommand classes
export {
  SessionPrCreateCommand,
  SessionPrEditCommand,
  SessionPrListCommand,
  SessionPrGetCommand,
  SessionPrOpenCommand,
};

/**
 * Factory functions for creating workflow commands
 */
export const createSessionCommitCommand = (deps?: SessionCommandDependencies) =>
  new SessionCommitCommand(deps);

export const createSessionApproveCommand = (deps?: SessionCommandDependencies) =>
  new SessionApproveCommand(deps);

export const createSessionInspectCommand = (deps?: SessionCommandDependencies) =>
  new SessionInspectCommand(deps);

export const createSessionReviewCommand = (deps?: SessionCommandDependencies) =>
  new SessionReviewCommand(deps);

export const createSessionPrApproveCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrApproveCommand(deps);

export const createSessionPrMergeCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrMergeCommand(deps);

// Factory functions for PR commands
export const createSessionPrCreateCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrCreateCommand(deps);

export const createSessionPrEditCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrEditCommand(deps);

export const createSessionPrListCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrListCommand(deps);

export const createSessionPrGetCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrGetCommand(deps);

export const createSessionPrOpenCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrOpenCommand(deps);
