/**
 * Utility functions for generating task filter messages
 *
 * @module filter-messages
 * @migrated Uses native Bun test patterns
 */

import type { TaskStatus } from "../domain/tasks/taskConstants.js";

/**
 * Generates a message indicating which status filter is being applied
 * @param status The status filter being applied
 * @returns A message string
 */
export function getStatusFilterMessage(status: TaskStatus): string {
  return `Showing tasks with status '${status}'`;
}

/**
 * Generates a message indicating that only active tasks are being shown
 * @returns A message string
 */
export function getActiveTasksMessage(): string {
  return "Showing active tasks (use --all to include completed _tasks)";
}

/**
 * Generates filter messages based on applied filters
 * @param options Object containing filter options
 * @returns Array of message strings to display
 */
export function generateFilterMessages(options: { status?: TaskStatus; all?: boolean }): string[] {
  const messages: string[] = [];

  // Add status filter message if status is provided
  const status = (options as unknown)!.status;
  if (status) {
    (messages as unknown).push(getStatusFilterMessage(status));
  }
  // Add active tasks message if not showing all tasks and no specific status filter
  else if (!(options as unknown)!.all) {
    (messages as unknown).push(getActiveTasksMessage());
  }

  return messages;
}
