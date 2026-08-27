import type { SessionPRParameters } from "../../schemas";
import type { GitServiceInterface } from "../../git/types";
import { sessionPrImpl } from "../session-pr-operations";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { SessionPrResult, SessionProviderInterface } from "../types";
import {
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
  getLoggableErrorSummary,
} from "../../errors/index";
import { log } from "@minsky/shared/logger";
import { readTextFile } from "@minsky/shared/fs";
import { isAbsolute, relative, resolve as resolvePath } from "path";

export interface SessionPrDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  persistenceProvider?: import("../../persistence/types").PersistenceProvider;
  /** Optional — forwarded to sessionPrImpl so the task can be advanced to IN-REVIEW. */
  taskService?: import("../../tasks/taskService").TaskServiceInterface;
  /**
   * The PR-preparation implementation. Defaults to the real `sessionPrImpl`
   * (mt#4046, PR #3021 R1).
   *
   * Injected rather than reached for so that what this function ASSEMBLES — in
   * particular that `headSha` lands on the returned result — is observable
   * without patching a module import. The reviewer's finding was precisely that
   * `resolvePrHeadSha` was tested while its wiring into the result was not,
   * which is the shape where a helper ships with passing tests and zero
   * production effect.
   */
  sessionPrImpl?: typeof sessionPrImpl;
}

/**
 * Resolve the commit the PR points at, after creation (mt#4046).
 *
 * PR creation runs a pre-PR session update before pushing, so the head here is a
 * DIFFERENT commit from the one `session_commit` returned to the caller moments
 * earlier. The caller needs THIS sha for `session_pr_wait-for-review`'s
 * `expectedHeadSha`; without it, the only sha in hand is one the remote has
 * already replaced, and the watcher waits out its full timeout while a real
 * review sits suppressed.
 *
 * **Returns undefined rather than throwing.** By the time this runs the PR
 * exists, so failing the whole operation over a diagnostic read would trade a
 * rare inconvenience for a common one. `undefined` means "unknown" — a caller
 * must not read it as "the head is unchanged", which is the very conflation this
 * field exists to remove.
 *
 * Exported and dependency-injected so the behavior is observable without
 * patching a module import.
 */
export async function resolvePrHeadSha(
  execInRepository: (workdir: string, command: string) => Promise<string>,
  workdir: string
): Promise<string | undefined> {
  try {
    const raw = await execInRepository(workdir, "git rev-parse HEAD");
    const sha = raw.trim();
    return sha.length > 0 ? sha : undefined;
  } catch (error) {
    log.debug(`Could not resolve PR head sha after creation: ${getLoggableErrorSummary(error)}`);
    return undefined;
  }
}

/**
 * Prepares a PR for a session based on parameters
 */
export async function sessionPr(
  params: SessionPRParameters,
  deps: SessionPrDependencies,
  options?: {
    interface?: "cli" | "mcp";
    workingDirectory?: string;
  }
): Promise<SessionPrResult> {
  const { session, task, repo, title, body, bodyPath, debug } = params;
  const { sessionDB, gitService } = deps;

  // Session resolution owns the "No session detected" guidance, and NOTHING else
  // does (mt#4307). This translation used to sit on a `try` wrapping the WHOLE
  // operation, so a `ValidationError` raised by any later stage was reported as a
  // session-resolution failure — an assertion that was simply false.
  //
  // What that cost: a `bodyPath` relative to the session workspace could not be
  // read, the code raised the exact, correct, actionable message naming the file,
  // and forty-nine lines later the same function destroyed it and substituted a
  // claim about session resolution. `session_pr_create` then failed four times in
  // a row — including when passed an explicit `--sessionId`, which is what makes
  // the substituted message so misleading: it names as missing the very thing the
  // caller supplied. `session_get --task` resolved that same session throughout.
  //
  // The original message is appended even here, where the diagnosis IS session
  // resolution, so the specific reason survives alongside the guidance.
  let resolvedContext: Awaited<ReturnType<typeof resolveSessionContextWithFeedback>>;
  try {
    // Use unified session context resolver with auto-detection support
    resolvedContext = await resolveSessionContextWithFeedback({
      sessionId: session,
      task,
      repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ResourceNotFoundError(
        "No session detected. Please provide a session ID (--sessionId), task ID (--task), " +
          `or run this command from within a session workspace. (${getErrorMessage(error)})`
      );
    }
    throw error;
  }

  // Get the session details using the resolved session ID
  const sessionRecord = await sessionDB.getSession(resolvedContext.sessionId);

  if (!sessionRecord) {
    throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
  }

  // Get session working directory
  const workdir = await sessionDB.getSessionWorkdir(resolvedContext.sessionId);

  // Check if PR already exists based on session record
  if (sessionRecord.prState?.exists) {
    log.debug(`PR already exists for session '${resolvedContext.sessionId}'`);
    // Force recreation by clearing the prState and deleting git branch
    try {
      const branchToDelete =
        sessionRecord.backendType === "github"
          ? sessionRecord.branch || resolvedContext.sessionId
          : `pr/${sessionRecord.branch || resolvedContext.sessionId}`;

      await gitService.execInRepository(workdir, `git branch -D ${branchToDelete}`);
      log.debug(`Deleted existing PR branch ${branchToDelete} to force recreation`);
    } catch (error) {
      log.debug(`Could not delete existing PR branch: ${error}`);
    }

    // Clear prState to allow recreation
    await sessionDB.updateSession(resolvedContext.sessionId, {
      prBranch: undefined, // Clear prBranch field too
      prState: undefined,
    });
  }

  // TASK 360 FIX: Read body content from bodyPath if provided
  let bodyContent = body;
  if (!bodyContent && bodyPath) {
    // A RELATIVE `bodyPath` resolves against the SESSION workspace, not the
    // process cwd (mt#4307). `readTextFile` resolves against cwd, which for the
    // MCP server is the MAIN repo — so a caller writing its PR body into the
    // session workspace and passing `.pr-body-mt4215.md` addressed a file that
    // does not exist there. A session-relative path is what such a caller means;
    // an absolute path is still honored unchanged.
    const bodyPathIsRelative = !isAbsolute(bodyPath);
    const resolvedBodyPath = bodyPathIsRelative ? resolvePath(workdir, bodyPath) : bodyPath;

    // A relative path is CONTAINED to the session workspace (PR #3201 R1). Saying
    // "relative means inside the session" and then following `../../` out of it
    // would be a contradiction, and a silent one — the read would succeed and the
    // caller would never learn the body came from somewhere else. An ABSOLUTE
    // path is still honored anywhere: that is the explicit way to say "elsewhere",
    // so the containment costs no capability.
    if (bodyPathIsRelative) {
      const relativeToWorkdir = relative(workdir, resolvedBodyPath);
      if (relativeToWorkdir.startsWith("..") || isAbsolute(relativeToWorkdir)) {
        throw new ValidationError(
          `bodyPath '${bodyPath}' escapes the session workspace (resolves to ${resolvedBodyPath}). ` +
            `A relative bodyPath is read inside the session workspace; pass an absolute path to ` +
            `read a file outside it.`,
          "bodyPath",
          bodyPath
        );
      }
    }

    try {
      bodyContent = await readTextFile(resolvedBodyPath);
      if (debug) {
        log.debug("Read body content from file", {
          bodyPath,
          resolvedBodyPath,
          contentLength: bodyContent?.length ?? 0,
        });
      }
    } catch (error) {
      // Names BOTH paths: the one given and the one actually read. Which of the
      // two is wrong is the whole question when this fires, and reporting only
      // the given path leaves the reader unable to tell.
      throw new ValidationError(
        `Failed to read body content from file: ${bodyPath} (resolved to ${resolvedBodyPath}). ` +
          `${getErrorMessage(error)}`,
        "bodyPath",
        bodyPath
      );
    }
  }

  // Prepare PR using session operations layer (proper architecture)
  const prepare = deps.sessionPrImpl ?? sessionPrImpl;
  const result = await prepare(
    {
      session: resolvedContext.sessionId,
      task: params.task,
      repo: params.repo,
      title,
      body: bodyContent,
      autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
      skipConflictCheck: params.skipConflictCheck,
      draft: params.draft,
      debug,
      noStatusUpdate: params.noStatusUpdate,
    },
    {
      sessionDB,
      gitService,
      persistenceProvider: deps.persistenceProvider,
      taskService: deps.taskService,
    },
    options
  );

  const headSha = await resolvePrHeadSha(
    (dir, command) => gitService.execInRepository(dir, command),
    workdir
  );

  // Repository backends handle PR state persistence; include session info for CLI formatting
  return {
    ...result,
    headSha,
    session: {
      sessionId: sessionRecord.sessionId,
      taskId: sessionRecord.taskId,
      repoName: sessionRecord.repoName,
    },
    sessionId: sessionRecord.sessionId, // Alternative property name for formatter compatibility
  };
}
