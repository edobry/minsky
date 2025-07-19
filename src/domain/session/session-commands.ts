/**
 * Session Commands
 * 
 * Pure session-scoped command implementations that maintain
 * proper separation of concerns by wrapping domain functionality.
 */

import { MinskyError } from "../../errors/index.js";
import { log } from "../../utils/logger.js";

/**
 * Session commit command - commits and pushes changes within a specific session
 * 
 * Note: Always pushes after commit - in session context these operations should be atomic
 */
export async function sessionCommit(params: {
  session: string;
  message: string;
  all?: boolean;
  amend?: boolean;
  noStage?: boolean;
}): Promise<{
  success: boolean;
  commitHash: string;
  message: string;
  pushed: boolean;
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

    // Always push changes in session context - commit and push should be atomic
    const pushResult = await pushFromParams({
      session: params.session, // Always use session context
    });

    return {
      success: true,
      commitHash: commitResult.commitHash,
      message: commitResult.message,
      pushed: pushResult.pushed,
    };
  } catch (error) {
    log.error("Session commit failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session
    });
    throw error;
  }
} 
