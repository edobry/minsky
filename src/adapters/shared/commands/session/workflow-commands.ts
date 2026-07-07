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
  sessionMergeCommandParams,
  sessionInspectCommandParams,
  sessionReviewCommandParams,
} from "./session-parameters";
import { sessionCommitCommandParams } from "../session-parameters";
import { buildAskRepository } from "../asks";
import { type AIReviewResult } from "@minsky/domain/ai/review-service";
import type { SessionMergeDependencies } from "@minsky/domain/session/session-merge-operations";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import { McpErrorCode } from "@minsky/domain/errors/mcp-error-codes";
import { mcpStructuredError } from "@minsky/domain/errors/mcp-structured-errors";
import { SessionConflictError } from "@minsky/domain/errors/index";
import { DrizzleAskRepository, type AskRepository } from "@minsky/domain/ask/repository";
import { log } from "@minsky/shared/logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// mt#2635: bumped from 800 -> 2000. At 800 chars, a real ESLint-warning-
// threshold failure (mt#2637 R1 diagnosis: 10 warnings) or a TypeScript
// error dump routinely got truncated before the actual failing check's
// banner/detail lines were reached, since `pre-commit hook`'s stdout also
// includes the preceding (passing) steps' output. 2000 chars comfortably
// fits a failure banner plus its immediate detail lines while still being a
// bounded "tail" excerpt, not a full dump.
export const SUBPROCESS_OUTPUT_TRUNCATE_LIMIT = 2000;

/**
 * Known `pre-commit.ts` / `commit-msg.ts` failure banners, mapped to a
 * short human-readable step label. Used ONLY to produce a friendlier
 * `details.failingStep` field for the error message — matching is
 * best-effort: if pre-commit.ts's wording changes, `detectFailingStep`
 * silently returns `undefined` and the raw tail excerpt (which still
 * carries whatever banner text pre-commit.ts printed) is the fallback.
 * This deliberately does NOT change any hook's own check logic or output
 * (mt#2635 scope: "Out of scope: the pre-commit pipeline's checks
 * themselves") — it only reads text the checks already emit.
 *
 * COUPLING / SOURCE OF TRUTH (mt#2635 PR #1811 R1): every pattern below is
 * copied verbatim from a `log.cli(...)` / `log.error(...)` call in
 * `src/hooks/pre-commit.ts` or `src/hooks/commit-msg.ts`. If either hook's
 * banner wording changes, the corresponding pattern here silently stops
 * matching (safe degradation — `detectFailingStep` just returns
 * `undefined`, see above) but SHOULD be updated to track the new text.
 * `workflow-commands-payload.test.ts`'s "recognizes each known ... banner"
 * test pins these exact strings so drift breaks loudly (test failure)
 * rather than silently (a `failingStep` that quietly stops appearing).
 *
 * Each pattern is deliberately matched against the FAILURE-specific text,
 * not just a bare topic phrase, to avoid false-positiving on that same
 * check's SUCCESS banner. Concrete example this guards against: pre-commit.ts
 * prints "✅ No variable naming issues found." on success and "❌ Variable
 * naming issues found! Please fix them before committing." on failure — an
 * earlier draft of this list matched the bare phrase "variable naming
 * issues found", which matches BOTH banners; the pattern below requires the
 * failure-only "! Please fix" suffix.
 */
const KNOWN_FAILING_STEP_MARKERS: ReadonlyArray<{ pattern: RegExp; step: string }> = [
  { pattern: /too many warnings/i, step: "ESLint (warning threshold)" },
  { pattern: /linter errors detected/i, step: "ESLint (errors)" },
  { pattern: /secrets detected by gitleaks/i, step: "gitleaks (secret scan)" },
  { pattern: /node\.js shims detected/i, step: "Node-shim guard" },
  { pattern: /nul byte\(s\) detected/i, step: "NUL-byte guard" },
  { pattern: /typescript type errors found/i, step: "TypeScript typecheck" },
  {
    pattern: /executable entry points missing execute permission/i,
    step: "hook-file permission check",
  },
  {
    pattern: /applied migration file\(s\) staged for modification/i,
    step: "immutable-migration guard",
  },
  { pattern: /deploy-domain ownership violation/i, step: "deploy-domain ownership guard" },
  {
    // Failure-only: "! Please fix" excludes the success banner "✅ No
    // variable naming issues found." (see coupling note above).
    pattern: /variable naming issues found! please fix/i,
    step: "variable-naming check",
  },
  { pattern: /commit message validation failed/i, step: "commit-msg format validation" },
];

/**
 * Best-effort extraction of a human-readable "which check failed" label
 * from raw pre-commit/commit-msg subprocess output. Returns `undefined`
 * when no known banner is recognized (safe degradation — the raw tail is
 * still surfaced regardless).
 */
export function detectFailingStep(subprocessOutput: string): string | undefined {
  for (const { pattern, step } of KNOWN_FAILING_STEP_MARKERS) {
    if (pattern.test(subprocessOutput)) return step;
  }
  return undefined;
}

/**
 * Build the structured-error payload fields for a `git commit` subprocess
 * failure. Keeps `summary` terse (≤120 chars per `McpErrorPayload` contract)
 * and parks the truncated subprocess preview in `details.tail`, full text in
 * `subprocessOutput`. PR #962 R1: the previous shape stuffed up to
 * SUBPROCESS_OUTPUT_TRUNCATE_LIMIT chars of preview into `summary`, violating
 * the contract.
 *
 * mt#2635: `details.failingStep` (best-effort, see `detectFailingStep`) and
 * `details.tail` are both folded into the WIRE message by
 * `StructuredMcpError` (mcp-structured-errors.ts) — not just left in `data`
 * — because the opacity incidents this fixes showed operators seeing only
 * `error.message` (== `summary` before this fix), never `error.data`.
 */
export function buildSubprocessFailurePayload(
  hookKind: "commit-msg" | "pre-commit" | "unknown" | "none",
  subprocessOutput: string
): {
  code: (typeof McpErrorCode)[keyof typeof McpErrorCode];
  summary: string;
  subprocessOutput: string;
  details?: Record<string, unknown>;
} {
  let code: (typeof McpErrorCode)[keyof typeof McpErrorCode];
  let summary: string;
  if (hookKind === "commit-msg") {
    code = McpErrorCode.COMMIT_MSG_FAILED;
    summary = "commit-msg hook blocked the commit";
  } else if (hookKind === "pre-commit") {
    code = McpErrorCode.PRE_COMMIT_FAILED;
    summary = "pre-commit hook blocked the commit";
  } else {
    code = McpErrorCode.SUBPROCESS_FAILED;
    summary = "git commit failed";
  }
  if (!subprocessOutput) {
    return { code, summary, subprocessOutput };
  }
  const wasTruncated = subprocessOutput.length > SUBPROCESS_OUTPUT_TRUNCATE_LIMIT;
  const failingStep = detectFailingStep(subprocessOutput);
  return {
    code,
    summary,
    subprocessOutput,
    details: {
      tail: safeTruncate(subprocessOutput, SUBPROCESS_OUTPUT_TRUNCATE_LIMIT),
      truncated: wasTruncated,
      ...(failingStep ? { failingStep } : {}),
    },
  };
}

/** Minimal container interface required by buildSessionMergeDeps. */
type MergeDepContainer = { has(key: string): boolean; get(key: string): unknown };

// Re-export PR subcommand factories so consumers can import the full set
// from workflow-commands.
export { createSessionPrCreateCommand } from "./pr-create-command";
export { createSessionPrEditCommand } from "./pr-edit-command";
export { createSessionPrCloseCommand } from "./pr-close-command";
export { createSessionPrListCommand } from "./pr-list-command";
export { createSessionPrGetCommand } from "./pr-get-command";
export { createSessionPrOpenCommand } from "./pr-open-command";
export { createSessionPrChecksCommand } from "./pr-checks-command";
export { createSessionPrWaitForReviewCommand } from "./pr-wait-for-review-command";
export { createSessionPrReviewContextCommand } from "./pr-review-context-command";
export { createSessionPrReviewSubmitCommand } from "./pr-review-submit-command";
export { createSessionPrReviewDismissCommand } from "./pr-review-dismiss-command";
export { createSessionPrReviewThreadResolveCommand } from "./pr-review-thread-resolve-command";
export { createSessionPrCheckRunSubmitCommand } from "./pr-check-run-submit-command";

/**
 * Classify a caught error from `git commit` as a hook failure, and identify
 * which hook fired.
 *
 * Node's `child_process.exec` attaches `.stderr` and `.stdout` to the thrown
 * error when the process exits with a non-zero code. A hook failure looks
 * like: `ExecException { message: "Command failed: git -C ... commit ...", stderr: "<hook output>" }`.
 *
 * Distinguishing commit-msg from pre-commit matters for the structured error
 * (mt#1524): a single generic "pre-commit" summary hides commit-msg failures
 * (e.g., non-conventional format) that have nothing to do with pre-commit
 * tooling. We branch on substrings that the project's hook output reliably
 * emits:
 *
 *   - `commit-msg` (script name in husky output, plus our hook's own
 *     "Commit message validation failed:" header)
 *   - `pre-commit` (script name and our hook headers)
 *
 * If subprocess output is empty, the error is internal (not a hook failure)
 * and `hookKind` is "none".
 *
 * mt#2635: also falls back to `err.cause` for both the message and the
 * stderr/stdout fields. `execInRepositoryImpl` (git-core-operations.ts)
 * wraps a subprocess failure in a fresh `MinskyError` and — as of mt#2635 —
 * preserves the original error as `.cause`. `session_commit`'s own commit
 * path no longer routes through that wrapper (it now goes through
 * `commitImpl`, which re-throws the original error unmodified), but this
 * fallback is defense-in-depth for any OTHER caller that reaches this
 * classifier via an `execInRepositoryImpl`-wrapped error.
 */
type HookKind = "commit-msg" | "pre-commit" | "unknown" | "none";

function classifyHookFailure(err: unknown): {
  isHookFailure: boolean;
  hookKind: HookKind;
  subprocessOutput: string;
} {
  if (err === null || typeof err !== "object") {
    return { isHookFailure: false, hookKind: "none", subprocessOutput: "" };
  }
  const e = err as Record<string, unknown>;
  const cause =
    e.cause !== null && typeof e.cause === "object" ? (e.cause as Record<string, unknown>) : null;

  const msg = typeof e.message === "string" ? e.message : "";
  const causeMsg = typeof cause?.message === "string" ? cause.message : "";
  const stderr =
    typeof e.stderr === "string" ? e.stderr : typeof cause?.stderr === "string" ? cause.stderr : "";
  const stdout =
    typeof e.stdout === "string" ? e.stdout : typeof cause?.stdout === "string" ? cause.stdout : "";
  const subprocessOutput = [stderr, stdout].filter(Boolean).join("\n").trim();

  // Must reference a git commit invocation — check the outer message first,
  // falling back to the cause's message (the outer MinskyError's "cleaned"
  // message may not retain "git"/"commit" substrings verbatim).
  const isCommitCommand =
    (msg.includes("git") && msg.includes("commit")) ||
    (causeMsg.includes("git") && causeMsg.includes("commit"));
  // Must have subprocess output (if there is none, it's an internal error, not a hook)
  const hasOutput = subprocessOutput.length > 0;

  if (!isCommitCommand || !hasOutput) {
    return { isHookFailure: false, hookKind: "none", subprocessOutput };
  }

  // Disambiguate commit-msg vs pre-commit. The husky shim prints the script
  // name on failure (`husky - commit-msg script failed (code 1)`); our own
  // hooks also include their headers ("Commit message validation failed:"
  // for commit-msg, various pre-commit task names for pre-commit).
  const out = subprocessOutput.toLowerCase();
  const looksLikeCommitMsg =
    out.includes("commit-msg") || out.includes("commit message validation failed");
  const looksLikePreCommit = out.includes("pre-commit");

  let hookKind: HookKind;
  if (looksLikeCommitMsg && !looksLikePreCommit) {
    hookKind = "commit-msg";
  } else if (looksLikePreCommit && !looksLikeCommitMsg) {
    hookKind = "pre-commit";
  } else if (looksLikeCommitMsg && looksLikePreCommit) {
    // Both substrings present (e.g., output mentions both hooks). Prefer
    // commit-msg since it's the later-firing hook — if it failed, that's
    // the proximate cause of the rejection.
    hookKind = "commit-msg";
  } else {
    hookKind = "unknown";
  }

  return { isHookFailure: true, hookKind, subprocessOutput };
}

export function createSessionCommitCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.commit",
    category: CommandCategory.SESSION,
    name: "commit",
    description: "Commit and push changes within a session workspace",
    parameters: sessionCommitCommandParams,
    mutating: true,
    execute: withErrorLogging(
      "session.commit",
      async (params: Record<string, unknown>, context) => {
        const { sessionCommit } = await import("@minsky/domain/session/session-commands");
        const { log } = await import("@minsky/shared/logger");
        const { createTokenProvider } = await import("@minsky/domain/auth");
        const { getConfiguration } = await import("@minsky/domain/configuration");
        const deps = await getDeps();
        // Guard: skip DB touch when persistence is not registered in the container.
        // buildAskRepository is a no-op when container is absent, but calling it
        // unconditionally still triggers an async DB-init path and log.warn noise
        // whenever persistence is not configured (e.g. CLI-only contexts).
        let askRepository: Awaited<ReturnType<typeof buildAskRepository>> = null;
        if (context.container?.has("persistence")) {
          askRepository = await buildAskRepository(context.container);
          if (askRepository === null) {
            // Persistence is registered but buildAskRepository returned null
            // (e.g. DB connection unavailable or non-SQL backend). Surface this
            // at the adapter layer so operators know Ask emission is silently
            // disabled for this command run — don't just coerce null → undefined.
            log.warn(
              "[session.commit] persistence is registered but buildAskRepository returned null; authorization.approve Ask emission disabled for this invocation"
            );
          }
        }

        try {
          const result = await sessionCommit(
            {
              session: (params.sessionId as string | undefined) ?? "",
              message: (params.message as string | undefined) ?? "",
              all: params.all as boolean | undefined,
              amend: params.amend as boolean | undefined,
              noStage: params.noStage as boolean | undefined,
              noFiles: params.noFiles as boolean | undefined,
            },
            deps.sessionProvider,
            askRepository ?? undefined,
            (() => {
              try {
                const cfg = getConfiguration();
                const userToken = String(cfg.github?.token ?? "");
                return createTokenProvider(cfg.github ?? {}, userToken);
              } catch {
                return undefined;
              }
            })()
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
        } catch (err) {
          const { isHookFailure, hookKind, subprocessOutput } = classifyHookFailure(err);
          if (isHookFailure) {
            // Map hook kind to error code + human-readable summary so MCP
            // clients can branch on `error.data.code` and humans see which
            // hook actually fired (mt#1524: a generic "pre-commit" summary
            // was masking commit-msg failures from non-conventional formats).
            // Three-way mapping:
            //   - commit-msg → COMMIT_MSG_FAILED + "commit-msg hook blocked the commit"
            //   - pre-commit → PRE_COMMIT_FAILED + "pre-commit hook blocked the commit"
            //   - unknown    → SUBPROCESS_FAILED + neutral "git commit failed" wording
            //                  (we know `git commit` exited non-zero with output, but
            //                  we cannot identify a specific hook — fabricating a
            //                  "git commit hook" name would be misleading).
            throw mcpStructuredError(buildSubprocessFailurePayload(hookKind, subprocessOutput));
          }
          throw err;
        }
      }
    ),
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
        const { SessionService } = await import("@minsky/domain/session/session-service");
        const deps = await getDeps();
        const service = new SessionService(deps);

        const result = await service.approve({
          session: params.sessionId as string | undefined,
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
      const { SessionService } = await import("@minsky/domain/session/session-service");
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
    const { createChangesetService } = await import("@minsky/domain/changeset/changeset-service");
    const changesetService = await createChangesetService(
      changeset.metadata?.github?.url || changeset.metadata?.local?.sessionId || "unknown"
    );

    const commentText = formatAIReviewComment(aiResult);
    await changesetService.approve(changeset.id, commentText);
  } catch (error) {
    const { log } = await import("@minsky/shared/logger");
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
    const { createChangesetService } = await import("@minsky/domain/changeset/changeset-service");
    const changesetService = await createChangesetService(
      changeset.metadata?.github?.url || changeset.metadata?.local?.sessionId || "unknown"
    );

    const approvalText = `AI Review: ${aiResult.overall.summary} (Score: ${aiResult.overall.score}/10)`;
    await changesetService.approve(changeset.id, approvalText);
  } catch (error) {
    const { log } = await import("@minsky/shared/logger");
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
        "@minsky/domain/session/session-review-operations"
      );

      const reviewResult = await sessionReviewImpl(
        {
          sessionId:
            (params.sessionId as string | undefined) || (params.session as string | undefined),
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
          const { AIReviewService } = await import("@minsky/domain/ai/review-service");
          const { DefaultAICompletionService } = await import(
            "@minsky/domain/ai/completion-service"
          );
          const { getConfiguration } = await import("@minsky/domain/configuration");

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
    mutating: true,
    execute: withErrorLogging(
      "session.pr.approve",
      async (params: Record<string, unknown>, _context) => {
        const { SessionService } = await import("@minsky/domain/session/session-service");
        const deps = await getDeps();
        const service = new SessionService(deps);

        const result = await service.approve({
          session: params.sessionId as string | undefined,
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
 *
 * `askRepository` is optional — callers that need Ask emission (e.g., the
 * session.pr.merge execute path) should build it asynchronously and pass it
 * explicitly. Tests can pass a FakeAskRepository stub.
 */
export function buildSessionMergeDeps(
  deps: Awaited<ReturnType<LazySessionDeps>>,
  container: MergeDepContainer | undefined,
  askRepository?: AskRepository
): SessionMergeDependencies {
  return {
    sessionDB: deps.sessionProvider,
    taskService: deps.taskService,
    gitService: deps.gitService,
    persistenceProvider: container?.has("persistence")
      ? (container.get("persistence") as PersistenceProvider)
      : undefined,
    askRepository,
  };
}

/**
 * Return true when an error from a PR merge operation indicates a git conflict.
 */
function isMergeConflictError(err: unknown): boolean {
  if (err instanceof SessionConflictError) return true;
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  return (
    msg.includes("CONFLICT") ||
    msg.includes("conflict") ||
    msg.includes("merge conflict") ||
    msg.includes("Cannot merge") ||
    msg.includes("mergeable")
  );
}

export function createSessionPrMergeCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.merge",
    category: CommandCategory.SESSION,
    name: "merge",
    description: "Merge an approved session pull request",
    parameters: sessionMergeCommandParams,
    mutating: true,
    execute: withErrorLogging(
      "session.pr.merge",
      async (params: Record<string, unknown>, context) => {
        const deps = await getDeps();
        const { mergeSessionPr } = await import("@minsky/domain/session/session-merge-operations");

        const shouldCleanup = params.skipCleanup !== true;

        // Build AskRepository best-effort (same pattern as pr-create-command.ts).
        // When unavailable, merge proceeds without Ask emission.
        let askRepository: DrizzleAskRepository | undefined;
        const persistenceForAsk = context.container?.has("persistence")
          ? context.container.get("persistence")
          : undefined;
        if (persistenceForAsk) {
          try {
            const sqlProvider = persistenceForAsk as SqlCapablePersistenceProvider;
            if (sqlProvider.getDatabaseConnection) {
              const db = await sqlProvider.getDatabaseConnection();
              if (db) {
                askRepository = new DrizzleAskRepository(db);
              }
            }
          } catch (askRepoError) {
            log.debug(`Could not initialize AskRepository for PR merge: ${askRepoError}`);
          }
        }

        try {
          const result = await mergeSessionPr(
            {
              session: params.sessionId as string | undefined,
              task: params.task as string | undefined,
              repo: params.repo as string | undefined,
              json: params.json as boolean | undefined,
              cleanupSession: shouldCleanup,
              acceptStaleReviewerSilence: params.acceptStaleReviewerSilence as boolean | undefined,
              forceBypass: params.forceBypass as boolean | undefined,
              bypassReason: params.bypassReason as string | undefined,
            },
            buildSessionMergeDeps(deps, context.container, askRepository)
          );

          return { success: true, result, printed: true };
        } catch (err) {
          if (isMergeConflictError(err)) {
            const msg = err instanceof Error ? err.message : String(err);
            throw mcpStructuredError({
              code: McpErrorCode.CONFLICT,
              summary: "Merge conflict prevented PR from merging",
              details: { originalMessage: msg },
            });
          }
          throw err;
        }
      }
    ),
  };
}
