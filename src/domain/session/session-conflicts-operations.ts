/**
 * Session Conflicts Operations
 *
 * Provides session-specific conflict detection functionality that operates
 * within session workspaces and includes session metadata.
 */

import { ConflictScanner, type ConflictScanOptions, type ConflictScanResult } from "../git/conflict-scanner";
import { getCurrentSessionContext } from "../workspace";
import { getSessionDirFromParams } from "../session";
import { getCurrentWorkingDirectory } from "../../utils/process";
import { log } from "../../utils/logger";

export interface SessionConflictScanOptions extends ConflictScanOptions {
  sessionName?: string;
}

/**
 * Scan a session workspace for conflict markers
 */
export async function scanSessionConflicts(
  sessionName?: string,
  options: SessionConflictScanOptions = {}
): Promise<ConflictScanResult> {
  try {
    let sessionPath: string;
    let actualSessionName: string;

    if (sessionName) {
      // Get specific session path
      const sessionDir = await getSessionDirFromParams({ session: sessionName });
      sessionPath = sessionDir;
      actualSessionName = sessionName;
    } else {
      // Auto-detect current session from working directory
      const cwd = getCurrentWorkingDirectory();
      const context = await getCurrentSessionContext(cwd);
      
      if (!context) {
        throw new Error("Not in a session workspace. Please specify a session name or run from within a session.");
      }
      
      // Use current working directory as session path and extract session name from sessionId
      sessionPath = cwd;
      actualSessionName = context.sessionId;
    }

    log.debug("Scanning session for conflicts", {
      sessionName: actualSessionName,
      sessionPath,
      options,
    });

    const result = await ConflictScanner.scanRepository(sessionPath, options, actualSessionName);

    // Add session-specific metadata
    const enhancedResult: ConflictScanResult = {
      ...result,
      session: actualSessionName,
      repository: sessionPath,
    };

    return enhancedResult;
  } catch (error) {
    log.error("Error scanning session for conflicts", { error, sessionName, options });
    throw error;
  }
}

/**
 * Format session conflict results with additional session context
 */
export function formatSessionConflictResults(
  result: ConflictScanResult,
  format: "json" | "text" = "json"
): string {
  if (format === "text") {
    const baseOutput = ConflictScanner.formatAsText(result);
    
    // Add session-specific information at the top
    const sessionInfo = [
      `Session Conflict Scan Results`,
      `Session: ${result.session || "unknown"}`,
      `Session Workspace: ${result.repository}`,
      `Scan Time: ${result.timestamp}`,
      "",
      baseOutput.substring(baseOutput.indexOf("Summary:")),
    ].join("\n");

    return sessionInfo;
  } else {
    return JSON.stringify(result, null, 2);
  }
} 
