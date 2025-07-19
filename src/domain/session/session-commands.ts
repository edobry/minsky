/**
 * Session Commands
 * 
 * Pure session-scoped command implementations that maintain
 * proper separation of concerns by wrapping domain functionality.
 */

import { MinskyError } from "../../errors/index.js";
import { log } from "../../utils/logger.js";

/**
 * Session commit command - commits changes within a specific session
 */
export async function sessionCommit(params: {
  session: string;
  message: string;
  all?: boolean;
  amend?: boolean;
  noStage?: boolean;
  noPush?: boolean;
}): Promise<{
  success: boolean;
  commitHash: string;
  message: string;
  pushed?: boolean;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Session commit command", { 
    session: params.session,
    message: params.message 
  });

  const { commitChangesFromParams, pushFromParams } = await import("../git");
  
  try {
    // Commit changes using session-scoped git command
    const commitResult = await commitChangesFromParams({
      message: params.message,
      session: params.session, // Always use session context
      all: params.all,
      amend: params.amend,
      noStage: params.noStage,
    });

    let pushed = false;
    
    // Push changes unless noPush is specified
    if (!params.noPush) {
      try {
        const pushResult = await pushFromParams({
          session: params.session, // Always use session context
        });
        pushed = pushResult.pushed;
      } catch (pushError) {
        log.warn("Commit succeeded but push failed", {
          session: params.session,
          commitHash: commitResult.commitHash,
          pushError: pushError instanceof Error ? pushError.message : String(pushError)
        });
        // Don't fail the whole operation if push fails
      }
    }

    return {
      success: true,
      commitHash: commitResult.commitHash,
      message: commitResult.message,
      pushed,
    };
  } catch (error) {
    log.error("Session commit failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session
    });
    throw error;
  }
}

/**
 * Session push command - pushes changes within a specific session
 */
export async function sessionPush(params: {
  session: string;
  remote?: string;
  force?: boolean;
}): Promise<{
  success: boolean;
  pushed: boolean;
  workdir: string;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Session push command", { 
    session: params.session,
    remote: params.remote 
  });

  const { pushFromParams } = await import("../git");
  
  try {
    // Push changes using session-scoped git command
    const result = await pushFromParams({
      session: params.session, // Always use session context
      remote: params.remote,
      force: params.force,
    });

    return {
      success: result.pushed,
      pushed: result.pushed,
      workdir: result.workdir,
    };
  } catch (error) {
    log.error("Session push failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session
    });
    throw error;
  }
} 
