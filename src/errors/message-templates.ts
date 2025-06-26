/**
 * Error Message Templates and Utilities
 * 
 * This module provides reusable templates and utilities for creating consistent,
 * user-friendly error messages throughout the Minsky application.
 */

// Error message emojis for consistent visual communication
export const ErrorEmojis = {
  // Problem indicators
  BLOCKED: "🚫",
  NOT_FOUND: "🔍",
  WARNING: "⚠️",
  FAILED: "❌",
  CONFLICT: "💥",
  
  // Solution indicators  
  SUGGESTION: "💡",
  INFO: "ℹ️",
  TIP: "💭",
  
  // Action indicators
  LIST: "📋",
  CREATE: "🆕",
  FILE: "📁",
  DIRECTORY: "📂",
  COMMAND: "⚡",
  HELP: "❓",
  
  // Navigation indicators
  NEXT_STEP: "➡️",
  ARROW: "→",
  CHECK: "✅",
} as const;

// Common error message sections
export interface ErrorMessageSection {
  title?: string;
  content: string;
  emoji?: string;
}

export interface ErrorTemplate {
  title: string;
  description?: string;
  sections: ErrorMessageSection[];
}

export interface CommandSuggestion {
  description: string;
  command: string;
  emoji?: string;
}

export interface ContextInfo {
  label: string;
  value: string;
}

/**
 * Utility function to safely extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Format command suggestions with consistent styling
 */
export function formatCommandSuggestions(suggestions: CommandSuggestion[]): string {
  return suggestions
    .map(({ description, command, emoji = ErrorEmojis.COMMAND }) => 
      `${emoji} ${description}:\n   ${command}`
    )
    .join("\n\n");
}

/**
 * Format context information for error messages
 */
export function formatContextInfo(contexts: ContextInfo[]): string {
  if (contexts.length === 0) return "";
  
  const formatted = contexts
    .map(({ label, value }) => `${label}: ${value}`)
    .join("\n");
    
  return `\n${formatted}`;
}

/**
 * Build a structured error message from template
 */
export function buildErrorMessage(template: ErrorTemplate, context?: ContextInfo[]): string {
  const parts: string[] = [];
  
  // Add title
  parts.push(template.title);
  
  // Add description if provided
  if (template.description) {
    parts.push("");
    parts.push(template.description);
  }
  
  // Add sections
  template.sections.forEach(section => {
    parts.push("");
    
    if (section.title) {
      const title = section.emoji ? `${section.emoji} ${section.title}` : section.title;
      parts.push(title);
      parts.push("");
    }
    
    parts.push(section.content);
  });
  
  // Add context information if provided
  if (context && context.length > 0) {
    parts.push("");
    parts.push(formatContextInfo(context));
  }
  
  return parts.join("\n");
}

/**
 * Template for "Resource Not Found" errors
 */
export function createResourceNotFoundMessage(
  resourceType: string,
  resourceId: string,
  suggestions: CommandSuggestion[],
  context?: ContextInfo[]
): string {
  const template: ErrorTemplate = {
    title: `${ErrorEmojis.NOT_FOUND} ${resourceType} "${resourceId}" Not Found`,
    description: `The ${resourceType.toLowerCase()} you're looking for doesn't exist or isn't accessible.`,
    sections: [
      {
        title: "What you can do:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions(suggestions)
      }
    ]
  };
  
  return buildErrorMessage(template, context);
}

/**
 * Template for "Missing Required Information" errors
 */
export function createMissingInfoMessage(
  operation: string,
  alternatives: CommandSuggestion[],
  context?: ContextInfo[]
): string {
  const template: ErrorTemplate = {
    title: `${ErrorEmojis.BLOCKED} Cannot ${operation} - missing required information`,
    description: "You need to specify one of these options to continue:",
    sections: [
      {
        content: formatCommandSuggestions(alternatives)
      }
    ]
  };
  
  return buildErrorMessage(template, context);
}

/**
 * Template for validation errors with specific field information
 */
export function createValidationErrorMessage(
  field: string,
  value: string,
  validOptions: string[],
  context?: ContextInfo[]
): string {
  const template: ErrorTemplate = {
    title: `${ErrorEmojis.FAILED} Invalid ${field}`,
    description: `The provided ${field} "${value}" is not valid.`,
    sections: [
      {
        title: "Valid options:",
        emoji: ErrorEmojis.LIST,
        content: validOptions.map(option => `• ${option}`).join("\n")
      }
    ]
  };
  
  return buildErrorMessage(template, context);
}

/**
 * Template for command execution failures
 */
export function createCommandFailureMessage(
  command: string,
  error: unknown,
  suggestions: CommandSuggestion[],
  context?: ContextInfo[]
): string {
  const template: ErrorTemplate = {
    title: `${ErrorEmojis.FAILED} Command Failed`,
    description: `The command "${command}" failed with error: ${getErrorMessage(error)}`,
    sections: [
      {
        title: "Try these alternatives:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions(suggestions)
      }
    ]
  };
  
  return buildErrorMessage(template, context);
}

/**
 * Template for session-related errors
 */
export function createSessionErrorMessage(
  sessionName: string,
  errorType: "not_found" | "exists" | "invalid",
  context?: ContextInfo[]
): string {
  const templates = {
    not_found: {
      title: `${ErrorEmojis.NOT_FOUND} Session "${sessionName}" Not Found`,
      description: "The session you're trying to access doesn't exist.",
      suggestions: [
        {
          description: "List all available sessions",
          command: "minsky sessions list",
          emoji: ErrorEmojis.LIST
        },
        {
          description: "Create a new session",
          command: `minsky session start "${sessionName}"`,
          emoji: ErrorEmojis.CREATE
        },
        {
          description: "Check session details",
          command: `minsky sessions get --name "${sessionName}"`,
          emoji: ErrorEmojis.INFO
        }
      ]
    },
    exists: {
      title: `${ErrorEmojis.BLOCKED} Session "${sessionName}" Already Exists`,
      description: "A session with this name already exists.",
      suggestions: [
        {
          description: "Use a different session name",
          command: "minsky session start \"new-session-name\"",
          emoji: ErrorEmojis.CREATE
        },
        {
          description: "Resume existing session",
          command: `minsky session get "${sessionName}"`,
          emoji: ErrorEmojis.ARROW
        },
        {
          description: "Delete existing session first",
          command: `minsky session delete "${sessionName}"`,
          emoji: ErrorEmojis.WARNING
        }
      ]
    },
    invalid: {
      title: `${ErrorEmojis.FAILED} Invalid Session "${sessionName}"`,
      description: "The session exists but is in an invalid state.",
      suggestions: [
        {
          description: "Check session status",
          command: `minsky sessions get --name "${sessionName}"`,
          emoji: ErrorEmojis.INFO
        },
        {
          description: "Update session configuration",
          command: `minsky session update "${sessionName}"`,
          emoji: ErrorEmojis.COMMAND
        }
      ]
    }
  };
  
  const config = templates[errorType];
  const template: ErrorTemplate = {
    title: config.title,
    description: config.description,
    sections: [
      {
        title: "What you can do:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions(config.suggestions)
      }
    ]
  };
  
  return buildErrorMessage(template, context);
}

/**
 * Template for Git-related errors
 */
export function createGitErrorMessage(
  operation: string,
  error: unknown,
  workdir?: string,
  context?: ContextInfo[]
): string {
  const errorMessage = getErrorMessage(error);
  const isConflict = errorMessage.toLowerCase().includes("conflict");
  
  const baseContext: ContextInfo[] = [
    ...(context || []),
    ...(workdir ? [{ label: "Working directory", value: workdir }] : [])
  ];
  
  if (isConflict) {
    const template: ErrorTemplate = {
      title: `${ErrorEmojis.CONFLICT} Git ${operation} Conflict`,
      description: `The ${operation} operation failed due to merge conflicts.`,
      sections: [
        {
          title: "Resolve conflicts:",
          emoji: ErrorEmojis.SUGGESTION,
          content: formatCommandSuggestions([
            {
              description: "Check conflict status",
              command: "git status",
              emoji: ErrorEmojis.INFO
            },
            {
              description: "Edit conflicted files",
              command: "git diff --name-only --diff-filter=U",
              emoji: ErrorEmojis.FILE
            },
            {
              description: "Mark conflicts as resolved",
              command: "git add .",
              emoji: ErrorEmojis.CHECK
            },
            {
              description: "Complete the operation",
              command: `git ${operation} --continue`,
              emoji: ErrorEmojis.NEXT_STEP
            }
          ])
        }
      ]
    };
    
    return buildErrorMessage(template, baseContext);
  }
  
  const template: ErrorTemplate = {
    title: `${ErrorEmojis.FAILED} Git ${operation} Failed`,
    description: `The ${operation} operation failed: ${errorMessage}`,
    sections: [
      {
        title: "Troubleshooting:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions([
          {
            description: "Check repository status",
            command: "git status",
            emoji: ErrorEmojis.INFO
          },
          {
            description: "Check recent commits",
            command: "git log --oneline -5",
            emoji: ErrorEmojis.LIST
          },
          {
            description: "Get help for this command",
            command: `git ${operation} --help`,
            emoji: ErrorEmojis.HELP
          }
        ])
      }
    ]
  };
  
  return buildErrorMessage(template, baseContext);
}

/**
 * Template for configuration errors
 */
export function createConfigErrorMessage(
  configKey: string,
  issue: string,
  suggestions: CommandSuggestion[],
  context?: ContextInfo[]
): string {
  const template: ErrorTemplate = {
    title: `${ErrorEmojis.FAILED} Configuration Error`,
    description: `Issue with configuration key "${configKey}": ${issue}`,
    sections: [
      {
        title: "How to fix:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions(suggestions)
      }
    ]
  };
  
  return buildErrorMessage(template, context);
}

/**
 * Common patterns for error context extraction
 */
export class ErrorContextBuilder {
  private contexts: ContextInfo[] = [];
  
  addCurrentDirectory(): this {
    this.contexts.push({
      label: "Current directory",
      value: process.cwd()
    });
    return this;
  }
  
  addSession(sessionName: string): this {
    this.contexts.push({
      label: "Session",
      value: sessionName
    });
    return this;
  }
  
  addRepository(repoPath: string): this {
    this.contexts.push({
      label: "Repository",
      value: repoPath
    });
    return this;
  }
  
  addTask(taskId: string): this {
    this.contexts.push({
      label: "Task ID",
      value: taskId
    });
    return this;
  }
  
  addCommand(command: string): this {
    this.contexts.push({
      label: "Command",
      value: command
    });
    return this;
  }
  
  addCustom(label: string, value: string): this {
    this.contexts.push({ label, value });
    return this;
  }
  
  build(): ContextInfo[] {
    return [...this.contexts];
  }
}

/**
 * Convenient builder for creating error contexts
 */
export function createErrorContext(): ErrorContextBuilder {
  return new ErrorContextBuilder();
} 
