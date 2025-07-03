/**
 * Auto-Task Creation Utilities
 * 
 * This module provides utilities for automatically creating tasks when starting
 * sessions with the --description parameter.
 */

/**
 * Create a task specification from a description
 * @param description The description provided by the user
 * @returns Task specification object
 */
export function createTaskFromDescription(description: string): {
  title: string;
  description: string;
  priority: string;
  status: string;
} {
  return {
    title: description,
    description: `Auto-created task for session: ${description}`,
    priority: "MEDIUM",
    status: "BACKLOG",
  };
} 
