/**
 * Domain Session Commands
 * 
 * Core session operations that accept session parameters directly.
 * These functions handle the business logic for session operations.
 */

import { z } from "zod";
import { MinskyError } from "../../errors/index";
import { log } from "../../utils/logger";

/**
 * Session PR creation parameters
 */
export interface SessionPrParams {
  session: string;
  title?: string;
  body?: string;
  bodyPath?: string;
  noStatusUpdate?: boolean;
  skipUpdate?: boolean;
  skipConflictCheck?: boolean;
  autoResolveDeleteConflicts?: boolean;
  debug?: boolean;
}

/**
 * Create a pull request for a session
 */
export async function sessionPr(params: SessionPrParams): Promise<{
  success: boolean;
  pullRequestUrl?: string;
  message: string;
}> {
  // ✅ Explicit validation - no process.cwd() inspection
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Explicit session PR command", { 
    session: params.session,
    title: params.title 
  });

  // Import domain services (not interface services)
  const { sessionPrFromParams } = await import("../session.js");
  
  try {
    // Call existing domain logic with proper session parameter
    const result = await sessionPrFromParams({
      name: params.session,
      title: params.title,
      body: params.body,
      bodyPath: params.bodyPath,
      noStatusUpdate: params.noStatusUpdate || false,
      skipUpdate: params.skipUpdate || false,
      skipConflictCheck: params.skipConflictCheck || false,
      autoResolveDeleteConflicts: params.autoResolveDeleteConflicts || false,
      debug: params.debug || false,
    });

    return {
      success: true,
      pullRequestUrl: `PR created: ${result.prBranch}`,
      message: `Pull request created successfully on branch ${result.prBranch}`
    };
  } catch (error) {
    log.error("Explicit session PR failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session
    });
    throw error;
  }
}

/**
 * Session update interface with explicit parameters
 */
export interface SessionUpdateParams {
  session: string;  // ✅ ALWAYS required
  branch?: string;
  force?: boolean;
  dryRun?: boolean;
  noStash?: boolean;
  noPush?: boolean;
  skipConflictCheck?: boolean;
  skipIfAlreadyMerged?: boolean;
  autoResolveDeleteConflicts?: boolean;
}

/**
 * Pure session update domain function
 */
export async function pureSessionUpdate(params: SessionUpdateParams): Promise<{
  success: boolean;
  message: string;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Pure session update command", { session: params.session });

  const { updateSessionFromParams } = await import("../session.js");
  
  try {
    const result = await updateSessionFromParams({
      name: params.session,
      branch: params.branch,
      force: params.force,
      dryRun: params.dryRun,
      noStash: params.noStash,
      noPush: params.noPush,
      skipConflictCheck: params.skipConflictCheck,
      skipIfAlreadyMerged: params.skipIfAlreadyMerged,
      autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
    });

    return {
      success: true,
      message: result.message || "Session updated successfully"
    };
  } catch (error) {
    log.error("Pure session update failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session
    });
    throw error;
  }
}

/**
 * Pure domain interface for session approval
 */
export interface SessionApproveParams {
  session: string;  // ✅ ALWAYS required
}

/**
 * Pure session approve domain function
 */
export async function pureSessionApprove(params: SessionApproveParams): Promise<{
  success: boolean;
  message: string;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Pure session approve command", { session: params.session });

  const { sessionApprove } = await import("./index.js");
  
  try {
    const result = await sessionApprove({
      name: params.session
    });

    return {
      success: true,
      message: result.message || "Session approved successfully"
    };
  } catch (error) {
    log.error("Pure session approve failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session
    });
    throw error;
  }
} 
