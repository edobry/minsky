/**
 * Parameter Schemas
 *
 * This module provides reusable Zod schema definitions with standardized descriptions.
 * It builds upon option-descriptions.ts to further reduce duplication in schema definitions
 * across CLI and MCP interfaces.
 */

import { z } from "zod";
import * as descriptions from "./option-descriptions";

// ------------------------------------------------------------------
// Schema Helpers
// ------------------------------------------------------------------

/**
 * Create an optional string parameter with a description
 */
export const optionalString = (description: string) => (z.string().describe(description) as unknown).optional();

/**
 * Create a required string parameter with a description
 */
export const requiredString = (description: string) => z.string().describe(description);

/**
 * Create an optional boolean parameter with a description
 */
export const optionalBoolean = (description: string) =>
  (z.boolean().describe(description) as unknown).optional();

// ------------------------------------------------------------------
// Common Parameters - Repository
// ------------------------------------------------------------------

/**
 * Parameter for session name
 */
export const sessionParam = optionalString((descriptions as unknown).SESSION_DESCRIPTION);

/**
 * Parameter for repository URI
 */
export const repoParam = optionalString((descriptions as unknown).REPO_DESCRIPTION);

/**
 * Parameter for upstream repository URI
 */
export const upstreamRepoParam = optionalString((descriptions as unknown).UPSTREAM_REPO_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Output Format
// ------------------------------------------------------------------

/**
 * Parameter for JSON output
 */
export const jsonParam = optionalBoolean((descriptions as unknown).JSON_DESCRIPTION);

/**
 * Parameter for debug output
 */
export const debugParam = optionalBoolean((descriptions as unknown).DEBUG_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Task
// ------------------------------------------------------------------

/**
 * Parameter for task ID
 */
export const taskIdParam = optionalString((descriptions as unknown).TASK_ID_DESCRIPTION);

/**
 * Parameter for task status filter
 */
export const taskStatusFilterParam = optionalString((descriptions as unknown).TASK_STATUS_FILTER_DESCRIPTION);

/**
 * Parameter for task status
 */
export const taskStatusParam = requiredString((descriptions as unknown).TASK_STATUS_DESCRIPTION);

/**
 * Parameter for all tasks inclusion
 */
export const taskAllParam = optionalBoolean((descriptions as unknown).TASK_ALL_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Backend
// ------------------------------------------------------------------

/**
 * Parameter for backend type
 */
export const backendParam = optionalString((descriptions as unknown).BACKEND_DESCRIPTION);

/**
 * Parameter for task backend
 */
export const taskBackendParam = optionalString((descriptions as unknown).TASK_BACKEND_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Force
// ------------------------------------------------------------------

/**
 * Parameter for force operation
 */
export const forceParam = optionalBoolean((descriptions as unknown).FORCE_DESCRIPTION);

/**
 * Parameter for overwrite option
 */
export const overwriteParam = optionalBoolean((descriptions as unknown).OVERWRITE_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Git
// ------------------------------------------------------------------

/**
 * Parameter for git remote
 */
export const remoteParam = optionalString((descriptions as unknown).GIT_REMOTE_DESCRIPTION);

/**
 * Parameter for branch name
 */
export const branchParam = optionalString((descriptions as unknown).GIT_BRANCH_DESCRIPTION);

/**
 * Parameter for git force option
 */
export const gitForceParam = optionalBoolean((descriptions as unknown).GIT_FORCE_DESCRIPTION);

/**
 * Parameter for no status update option
 */
export const noStatusUpdateParam = optionalBoolean((descriptions as unknown).NO_STATUS_UPDATE_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Rules
// ------------------------------------------------------------------

/**
 * Parameter for rule content
 */
export const ruleContentParam = optionalString((descriptions as unknown).RULE_CONTENT_DESCRIPTION);

/**
 * Parameter for rule description
 */
export const ruleDescriptionParam = optionalString((descriptions as unknown).RULE_DESCRIPTION_DESCRIPTION);

/**
 * Parameter for rule name
 */
export const ruleNameParam = optionalString((descriptions as unknown).RULE_NAME_DESCRIPTION);

/**
 * Parameter for rule format
 */
export const ruleFormatParam = optionalString((descriptions as unknown).RULE_FORMAT_DESCRIPTION);

/**
 * Parameter for rule tags
 */
export const ruleTagsParam = optionalString((descriptions as unknown).RULE_TAGS_DESCRIPTION);
