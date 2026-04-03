import type { SessionRecord } from "./types";
import {
  taskIdToSessionName,
  sessionNameToTaskId,
  isQualifiedTaskId,
  extractBackend,
  extractLocalId,
  generateSessionId,
  isUuidSessionName,
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
   * Generate session name from qualified task ID
   *
   * @param taskId Task ID in qualified format (md#123, gh#456)
   * @returns Session name (task-md#123)
   */
  static generateSessionName(taskId: string, idGenerator?: () => string): string {
    if (!taskId) {
      throw new Error("Task ID is required for session name generation");
    }
    // Validate the task ID is qualified
    if (!isQualifiedTaskId(taskId)) {
      throw new Error(
        `Invalid task ID: '${taskId}'. Only qualified task IDs (md#123, gh#456) are supported.`
      );
    }
    // Generate opaque UUID session ID — task linkage is via SessionRecord.taskId
    return generateSessionId(idGenerator);
  }

  /**
   * Extract task ID from session name
   *
   * @param sessionName Session name (task-md#123)
   * @returns Task ID in qualified format (md#123)
   */
  static extractTaskIdFromSessionName(sessionName: string): string | null {
    if (!sessionName) {
      return null;
    }
    // UUID session names don't encode task IDs — use DB lookup instead
    if (isUuidSessionName(sessionName)) {
      return null;
    }
    // Legacy: task-md#123 → md#123
    if (sessionName.startsWith("task-")) {
      return sessionNameToTaskId(sessionName);
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
   * Check if session name uses new multi-backend format
   *
   * @param sessionName Session name to check
   * @returns True if using new format (task-md#123), false for legacy (task123)
   */
  static isMultiBackendSessionName(sessionName: string): boolean {
    // UUID session names are the new multi-backend format
    if (isUuidSessionName(sessionName)) {
      return true;
    }
    // Legacy format: task-md#123
    return sessionName.startsWith("task-") && sessionName.includes("#");
  }

  // migrateLegacySessionRecord removed: strict-only; callers should provide qualified IDs and session names

  // getDisplayTaskId removed: strict qualified IDs are displayed as-is

  /**
   * Validate session-task compatibility
   *
   * @param sessionName Session name
   * @param taskId Task ID
   * @returns True if session name matches task ID format
   */
  static validateSessionTaskCompatibility(sessionName: string, taskId: string): boolean {
    // UUID sessions can be associated with any task — validation is done via DB record
    if (isUuidSessionName(sessionName)) {
      return true; // Compatibility is checked at the DB level, not by name
    }
    // Legacy: check if session name matches expected format
    const expectedSessionName = taskIdToSessionName(taskId);
    return sessionName === expectedSessionName;
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
    // UUID session names are the current format — no migration needed
    if (isUuidSessionName(sessionRecord.session)) {
      return false;
    }
    // Qualified IDs should match the legacy session naming convention
    if (isQualifiedTaskId(sessionRecord.taskId)) {
      const expectedSessionName = taskIdToSessionName(sessionRecord.taskId);
      return sessionRecord.session !== expectedSessionName;
    }
    // Legacy/unqualified task IDs always need migration
    return true;
  }
}
