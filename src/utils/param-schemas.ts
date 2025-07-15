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
export const optionalString = (description: string) => z.string().describe(description).optional();

/**
 * Create a required string parameter with a description
 */
export const requiredString = (description: string) => z.string().describe(description);

/**
 * Create an optional boolean parameter with a description
 */
export const optionalBoolean = (description: string) =>
  z.boolean().describe(description).optional();

// ------------------------------------------------------------------
// Common Parameters - Repository
// ------------------------------------------------------------------

/**
 * Parameter for session name
 */
export const _sessionParam = optionalString(descriptions.SESSION_DESCRIPTION);

/**
 * Parameter for repository URI
 */
export const _repoParam = optionalString(descriptions.REPO_DESCRIPTION);

/**
 * Parameter for upstream repository URI
 */
export const _upstreamRepoParam = optionalString(descriptions.UPSTREAM_REPO_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Output Format
// ------------------------------------------------------------------

/**
 * Parameter for JSON output
 */
export const _jsonParam = optionalBoolean(descriptions.JSON_DESCRIPTION);

/**
 * Parameter for debug output
 */
export const _debugParam = optionalBoolean(descriptions.DEBUG_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Task
// ------------------------------------------------------------------

/**
 * Parameter for task ID
 */
export const _taskIdParam = optionalString(descriptions.TASK_ID_DESCRIPTION);

/**
 * Parameter for task status filter
 */
export const _taskStatusFilterParam = optionalString(descriptions.TASK_STATUS_FILTER_DESCRIPTION);

/**
 * Parameter for task status
 */
export const _taskStatusParam = requiredString(descriptions.TASK_STATUS_DESCRIPTION);

/**
 * Parameter for all tasks inclusion
 */
export const _taskAllParam = optionalBoolean(descriptions.TASK_ALL_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Backend
// ------------------------------------------------------------------

/**
 * Parameter for backend type
 */
export const _backendParam = optionalString(descriptions.BACKEND_DESCRIPTION);

/**
 * Parameter for task backend
 */
export const _taskBackendParam = optionalString(descriptions.TASK_BACKEND_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Force
// ------------------------------------------------------------------

/**
 * Parameter for force operation
 */
export const _forceParam = optionalBoolean(descriptions.FORCE_DESCRIPTION);

/**
 * Parameter for overwrite option
 */
export const _overwriteParam = optionalBoolean(descriptions.OVERWRITE_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Git
// ------------------------------------------------------------------

/**
 * Parameter for git remote
 */
export const _remoteParam = optionalString(descriptions.GIT_REMOTE_DESCRIPTION);

/**
 * Parameter for branch name
 */
export const _branchParam = optionalString(descriptions.GIT_BRANCH_DESCRIPTION);

/**
 * Parameter for git force option
 */
export const _gitForceParam = optionalBoolean(descriptions.GIT_FORCE_DESCRIPTION);

/**
 * Parameter for no status update option
 */
export const _noStatusUpdateParam = optionalBoolean(descriptions.NO_STATUS_UPDATE_DESCRIPTION);

// ------------------------------------------------------------------
// Common Parameters - Rules
// ------------------------------------------------------------------

/**
 * Parameter for rule content
 */
export const _ruleContentParam = optionalString(descriptions.RULE_CONTENT_DESCRIPTION);

/**
 * Parameter for rule description
 */
export const _ruleDescriptionParam = optionalString(descriptions.RULE_DESCRIPTION_DESCRIPTION);

/**
 * Parameter for rule name
 */
export const _ruleNameParam = optionalString(descriptions.RULE_NAME_DESCRIPTION);

/**
 * Parameter for rule format
 */
export const _ruleFormatParam = optionalString(descriptions.RULE_FORMAT_DESCRIPTION);

/**
 * Parameter for rule tags
 */
export const _ruleTagsParam = optionalString(descriptions.RULE_TAGS_DESCRIPTION);
