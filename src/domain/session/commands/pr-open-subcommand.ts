/**
 * Session PR Open Subcommand
 */

import { createSessionProvider } from "../session-db-adapter";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../../errors/index";
import { sessionPrGet } from "./pr-get-subcommand";

/**
 * Session PR Open implementation
 * Opens the pull request in the default web browser (GitHub backend only)
 */
export async function sessionPrOpen(params: {
  sessionName?: string;
  name?: string;
  task?: string;
  repo?: string;
}): Promise<{
  url: string;
  sessionName: string;
  prNumber?: number;
}> {
  const sessionDB = await createSessionProvider();

  try {
    // Resolve session context using existing resolver
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: params.sessionName || params.name,
      task: params.task,
      repo: params.repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });

    // Get the session record
    const sessionRecord = await sessionDB.getSession(resolvedContext.sessionName);

    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionName}' not found`);
    }

    // Check if this is a GitHub repository backend
    const repoUrl = sessionRecord.repoUrl || "";
    const isGitHubRepo = repoUrl.includes("github.com");

    if (!isGitHubRepo) {
      throw new MinskyError(
        `Session PR open is only supported for GitHub repositories. This session uses: ${sessionRecord.repoUrl || "local repository"}`
      );
    }

    // Get PR details using the existing sessionPrGet function
    const prResult = await sessionPrGet({
      sessionName: resolvedContext.sessionName,
      task: params.task,
      repo: params.repo,
    });

    const pr = prResult.pullRequest;

    // Check if PR has a URL
    if (!pr.url) {
      throw new MinskyError(
        `No pull request URL found for session '${resolvedContext.sessionName}'. ` +
          `PR status: ${pr.status}. Please ensure a PR has been created for this session.`
      );
    }

    // Open the URL in the default browser
    const { execSync } = await import("child_process");
    try {
      // Use the system's default browser opener
      if (process.platform === "darwin") {
        execSync(`open "${pr.url}"`, { stdio: "ignore" });
      } else if (process.platform === "win32") {
        execSync(`start "${pr.url}"`, { stdio: "ignore" });
      } else {
        // Linux and other Unix-like systems
        execSync(`xdg-open "${pr.url}"`, { stdio: "ignore" });
      }
    } catch (error) {
      throw new MinskyError(
        `Failed to open PR in browser: ${getErrorMessage(error)}. ` +
          `You can manually open: ${pr.url}`
      );
    }

    return {
      url: pr.url,
      sessionName: resolvedContext.sessionName,
      prNumber: pr.number,
    };
  } catch (error) {
    if (
      error instanceof ResourceNotFoundError ||
      error instanceof ValidationError ||
      error instanceof MinskyError
    ) {
      throw error;
    }
    throw new MinskyError(`Failed to open session PR: ${getErrorMessage(error)}`);
  }
}
