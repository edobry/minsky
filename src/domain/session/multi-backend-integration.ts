import type { SessionRecord } from "./types";
import {
  taskIdToSessionName,
  sessionNameToTaskId,
  isQualifiedTaskId,
  extractBackend,
  extractLocalId,
  migrateUnqualifiedTaskId,
} from "../tasks/unified-task-id";
import { normalizeTaskIdForStorage, formatTaskIdForDisplay } from "../tasks/task-id-utils";

/**
 * Enhanced SessionRecord with task backend information
 */
export interface MultiBackendSessionRecord extends SessionRecord {
  /** Task backend (md, gh, json, etc.) - derived from qualified task ID */
  taskBackend?: string;
  /** Original task ID format for backward compatibility */
  legacyTaskId?: string;
}

/**
 * Session naming integration for multi-backend task system
 */
export class SessionMultiBackendIntegration {
  /**
   * Generate session name from task ID using unified format
   *
   * @param taskId Task ID in any format (123, #123, md#123, task#123)
   * @returns Session name (task-md#123, task123 for legacy)
   */
  static generateSessionName(taskId: string): string {
    if (!taskId) {
      throw new Error("Task ID is required for session name generation");
    }

    // Check if it's already a qualified ID
    if (isQualifiedTaskId(taskId)) {
      return taskIdToSessionName(taskId);
    }

    // Handle legacy task ID formats
    const normalizedTaskId = normalizeTaskIdForStorage(taskId);
    if (normalizedTaskId) {
      // Legacy numeric ID - migrate to markdown backend
      const qualifiedId = migrateUnqualifiedTaskId(normalizedTaskId, "md");
      return taskIdToSessionName(qualifiedId);
    }

    // If all else fails, use legacy format for backward compatibility
    return `task${taskId}`;
  }

  /**
   * Extract task ID from session name
   *
   * @param sessionName Session name (task-md#123, task123, etc.)
   * @returns Task ID in qualified format (md#123) or legacy format
   */
  static extractTaskIdFromSessionName(sessionName: string): string | null {
    if (!sessionName) {
      return null;
    }

    // Try to extract using unified format first
    if (sessionName.startsWith("task-")) {
      return sessionNameToTaskId(sessionName);
    }

    // Handle legacy format (task123, task#123)
    if (sessionName.startsWith("task")) {
      const legacyId = sessionName.substring(4); // Remove "task" prefix

      // If it's just a number, it's legacy format
      if (/^\d+$/.test(legacyId)) {
        return migrateUnqualifiedTaskId(legacyId, "md");
      }

      // If it's task#123 format
      if (legacyId.startsWith("#") && /^#\d+$/.test(legacyId)) {
        const numericId = legacyId.substring(1);
        return migrateUnqualifiedTaskId(numericId, "md");
      }
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
      } else {
        // Legacy task ID - assume markdown backend
        enhanced.taskBackend = "md";
        enhanced.legacyTaskId = sessionRecord.taskId;

        // Optionally migrate to qualified format
        const qualifiedId = migrateUnqualifiedTaskId(sessionRecord.taskId, "md");
        if (qualifiedId !== sessionRecord.taskId) {
          enhanced.taskId = qualifiedId;
        }
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
   * @param sessionRecord Session record (legacy or enhanced)
   * @returns Task ID formatted for display
   */
  static getDisplayTaskId(sessionRecord: SessionRecord | MultiBackendSessionRecord): string {
    if (!sessionRecord.taskId) {
      return "";
    }

    // If it's already qualified, return as-is
    if (isQualifiedTaskId(sessionRecord.taskId)) {
      return sessionRecord.taskId;
    }

    // Legacy format - add display formatting
    return formatTaskIdForDisplay(sessionRecord.taskId);
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
    // If it's a qualified ID, store as-is (new format)
    if (isQualifiedTaskId(taskId)) {
      return taskId;
    }

    // Use legacy normalization for unqualified IDs
    const normalized = normalizeTaskIdForStorage(taskId);
    return normalized || taskId;
  }

  /**
   * Convert any task ID to display format
   *
   * @param taskId Task ID in any format
   * @returns Task ID formatted for display
   */
  static toDisplayFormat(taskId: string): string {
    // If it's qualified, return as-is
    if (isQualifiedTaskId(taskId)) {
      return taskId;
    }

    // Use legacy display formatting
    return formatTaskIdForDisplay(taskId);
  }

  /**
   * Check if a session record needs migration
   *
   * @param sessionRecord Session record to check
   * @returns True if migration is needed
   */
  static needsMigration(sessionRecord: SessionRecord): boolean {
    if (!sessionRecord.taskId) {
      return false;
    }

    // Check if session name format matches task ID format
    const expectedSessionName = SessionMultiBackendIntegration.generateSessionName(
      sessionRecord.taskId
    );
    return sessionRecord.session !== expectedSessionName;
  }
}
