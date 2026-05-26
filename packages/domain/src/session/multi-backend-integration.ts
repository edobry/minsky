import type { SessionRecord } from "./types";
import {
  taskIdToSessionId,
  sessionIdToTaskId,
  isQualifiedTaskId,
  extractBackend,
  generateSessionId,
  isUuidSessionId,
} from "../tasks/task-id";

/**
 * Enhanced SessionRecord with task backend information
 */
export interface MultiBackendSessionRecord extends SessionRecord {
  /** Task backend (md, gh, json, etc.) - derived from qualified task ID */
  taskBackend?: string;
  /** Legacy task ID before migration (preserved for reference) */
  legacyTaskId?: string;
}

/**
 * Session naming integration for multi-backend task system
 */
export class SessionMultiBackendIntegration {
  /**
   * Generate session ID from qualified task ID.
   * Returns an opaque UUID — task linkage is via SessionRecord.taskId, not the session ID.
   *
   * @param taskId Task ID in qualified format (md#123, gh#456)
   * @param idGenerator Optional custom ID generator (for testing)
   * @returns Session ID (UUID)
   */
  static generateSessionId(taskId: string, idGenerator?: () => string): string {
    if (!taskId) {
      throw new Error("Task ID is required for session ID generation");
    }

    // Strict: qualified IDs only
    if (isQualifiedTaskId(taskId)) {
      return generateSessionId(idGenerator);
    }

    throw new Error(
      `Invalid task ID: '${taskId}'. Only qualified task IDs (md#123, gh#456) are supported.`
    );
  }

  /**
   * Extract task ID from session ID.
   * Returns null for UUID session IDs — use DB lookup instead.
   *
   * @param sessionId Session ID (UUID or legacy task-md#123)
   * @returns Task ID in qualified format (md#123) or null
   */
  static extractTaskIdFromSessionId(sessionId: string): string | null {
    if (!sessionId) {
      return null;
    }

    // UUID session IDs don't encode task IDs — use DB lookup instead
    if (isUuidSessionId(sessionId)) {
      return null;
    }

    // Legacy: task-md#123 → md#123
    if (sessionId.startsWith("task-")) {
      return sessionIdToTaskId(sessionId);
    }

    return null;
  }

  /**
   * Enhance session record with backend information
   *
   * @param sessionRecord Original session record
   * @returns Enhanced session record with backend info
   */
  static enhanceSessionRecord(sessionRecord: SessionRecord): MultiBackendSessionRecord {
    const enhanced: MultiBackendSessionRecord = { ...sessionRecord };

    if (sessionRecord.taskId) {
      // Extract backend information if it's a qualified ID
      if (isQualifiedTaskId(sessionRecord.taskId)) {
        enhanced.taskBackend = extractBackend(sessionRecord.taskId) || undefined;
      }
    }

    return enhanced;
  }

  /**
   * Check if session ID uses multi-backend format (UUID or legacy task-md#123)
   *
   * @param sessionId Session ID to check
   * @returns True if using multi-backend format
   */
  static isMultiBackendSessionId(sessionId: string): boolean {
    // UUID session IDs are the new multi-backend format
    if (isUuidSessionId(sessionId)) {
      return true;
    }
    // Legacy format: task-md#123
    return sessionId.startsWith("task-") && sessionId.includes("#");
  }

  // migrateLegacySessionRecord removed: strict-only; callers should provide qualified IDs and session IDs

  // getDisplayTaskId removed: strict qualified IDs are displayed as-is

  /**
   * Validate session-task compatibility.
   * UUID sessions are always compatible — validation is via DB record, not name.
   *
   * @param sessionId Session ID
   * @param taskId Task ID
   * @returns True if session ID is compatible with task ID
   */
  static validateSessionTaskCompatibility(sessionId: string, taskId: string): boolean {
    // UUID sessions can be associated with any task — validation is done via DB record
    if (isUuidSessionId(sessionId)) {
      return true;
    }
    // Legacy: check if session ID matches expected format
    const expectedSessionId = taskIdToSessionId(taskId);
    return sessionId === expectedSessionId;
  }

  /**
   * Get task backend from session record
   *
   * @param sessionRecord Session record
   * @returns Task backend identifier or null
   */
  static getTaskBackend(sessionRecord: SessionRecord | MultiBackendSessionRecord): string | null {
    // Check if enhanced record has backend info
    if ("taskBackend" in sessionRecord && sessionRecord.taskBackend) {
      return sessionRecord.taskBackend;
    }

    // Try to extract from task ID
    if (sessionRecord.taskId && isQualifiedTaskId(sessionRecord.taskId)) {
      return extractBackend(sessionRecord.taskId);
    }

    // Default to markdown for legacy records
    if (sessionRecord.taskId) {
      return "md";
    }

    return null;
  }
}

/**
 * Backward compatibility utilities for existing session operations
 */
export class SessionBackwardCompatibility {
  /**
   * Convert any task ID to storage format (for legacy system compatibility)
   *
   * @param taskId Task ID in any format
   * @returns Task ID in storage format or original if qualified
   */
  static toStorageFormat(taskId: string): string {
    // Qualified only; return as-is
    return taskId;
  }

  /**
   * Convert any task ID to display format
   *
   * @param taskId Task ID in any format
   * @returns Task ID formatted for display
   */
  static toDisplayFormat(taskId: string): string {
    // Qualified only; return as-is
    return taskId;
  }

  /**
   * Check if a session record needs migration
   *
   * @param sessionRecord Session record to check
   * @returns True if migration is needed
   */
  static needsMigration(sessionRecord: SessionRecord): boolean {
    // No task ID: treat as custom session; no migration needed
    if (!sessionRecord.taskId) {
      return false;
    }

    // UUID session IDs are the current format — no migration needed
    if (isUuidSessionId(sessionRecord.sessionId)) {
      return false;
    }

    // Any non-UUID session ID with a task ID needs migration to UUID format
    return true;
  }
}
