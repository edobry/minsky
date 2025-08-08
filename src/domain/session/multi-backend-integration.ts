import type { SessionRecord } from "./types";
import {
  taskIdToSessionName,
  sessionNameToTaskId,
  isQualifiedTaskId,
  extractBackend,
  extractLocalId,
} from "../tasks/unified-task-id";

/**
 * Enhanced SessionRecord with task backend information
 */
export interface MultiBackendSessionRecord extends SessionRecord {
  /** Task backend (md, gh, json, etc.) - derived from qualified task ID */
  taskBackend?: string;
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
  static generateSessionName(taskId: string): string {
    if (!taskId) {
      throw new Error("Task ID is required for session name generation");
    }

    // Only accept qualified IDs
    if (isQualifiedTaskId(taskId)) {
      return taskIdToSessionName(taskId);
    }

    throw new Error(
      `Invalid task ID: '${taskId}'. Only qualified task IDs (md#123, gh#456) are supported.`
    );
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

    // Extract using unified format
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

    if (sessionRecord.taskId && isQualifiedTaskId(sessionRecord.taskId)) {
      enhanced.taskBackend = extractBackend(sessionRecord.taskId) || undefined;
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
    return sessionName.startsWith("task-") && sessionName.includes("#");
  }

  /**
   * Migrate legacy session record to multi-backend format
   *
   * @param sessionRecord Legacy session record
   * @returns Migrated session record with updated naming and backend info
   */
  static migrateLegacySessionRecord(sessionRecord: SessionRecord): MultiBackendSessionRecord {
    const enhanced = this.enhanceSessionRecord(sessionRecord);

    // Update session name if it's legacy format
    if (sessionRecord.taskId && !this.isMultiBackendSessionName(sessionRecord.session)) {
      const newSessionName = this.generateSessionName(sessionRecord.taskId);
      enhanced.session = newSessionName;
    }

    return enhanced;
  }

  /**
   * Get display-friendly task ID from session record
   *
   * @param sessionRecord Session record
   * @returns Task ID for display
   */
  static getDisplayTaskId(sessionRecord: SessionRecord | MultiBackendSessionRecord): string {
    if (!sessionRecord.taskId || !isQualifiedTaskId(sessionRecord.taskId)) {
      return "";
    }

    return sessionRecord.taskId;
  }

  /**
   * Validate session-task compatibility
   *
   * @param sessionName Session name
   * @param taskId Task ID
   * @returns True if session name matches task ID format
   */
  static validateSessionTaskCompatibility(sessionName: string, taskId: string): boolean {
    const expectedSessionName = this.generateSessionName(taskId);
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
