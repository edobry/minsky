/**
 * Task 223: Enhanced Error Messages and Debugging
 * 
 * This module provides enhanced error message templates for specific error scenarios
 * identified in Task 209, building on the error template infrastructure from Task 169.
 */

import {
  ErrorEmojis,
  ErrorTemplate,
  buildErrorMessage,
  formatCommandSuggestions,
  formatContextInfo,
  type CommandSuggestion,
  type ContextInfo
} from "./message-templates";

/**
 * Enhanced error message for session PR branch restriction
 * Requirement 1: Detect when user attempts `session pr` from PR branch and suggest switching to session branch
 */
export function createSessionPrBranchErrorMessage(
  currentBranch: string,
  sessionName?: string,
  context?: ContextInfo[]
): string {
  const suggestions: CommandSuggestion[] = [
    {
      description: "Switch to your session branch",
      command: sessionName ? `git switch ${sessionName}` : "git switch <session-branch>",
      emoji: ErrorEmojis.NEXT_STEP
    },
    {
      description: "List all branches to find your session branch",
      command: "git branch -a",
      emoji: ErrorEmojis.LIST
    },
    {
      description: "Check current session directory for branch name",
      command: "pwd | grep sessions",
      emoji: ErrorEmojis.INFO
    }
  ];

  const template: ErrorTemplate = {
    title: `${ErrorEmojis.BLOCKED} Cannot Run Session PR from PR Branch`,
    description: `You're currently on PR branch '${currentBranch}'. Session PR commands must be run from your session branch.`,
    sections: [
      {
        title: "How to fix this:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions(suggestions)
      }
    ]
  };

  return buildErrorMessage(template, context);
}

/**
 * Enhanced error message for task ID parsing failures
 * Requirement 2: Show supported formats (numeric vs alphanumeric) when parsing fails
 */
export function createTaskIdParsingErrorMessage(
  invalidTaskId: string,
  context?: ContextInfo[]
): string {
  const validExamples = [
    "123",
    "#123", 
    "077",
    "#077",
    "task#123",
    "ABC123",
    "#ABC123"
  ];

  const suggestions: CommandSuggestion[] = [
    {
      description: "Use numeric format",
      command: "minsky tasks get 123",
      emoji: ErrorEmojis.COMMAND
    },
    {
      description: "Use with hash prefix",
      command: "minsky tasks get #123",
      emoji: ErrorEmojis.COMMAND
    },
    {
      description: "Use alphanumeric format",
      command: "minsky tasks get ABC123",
      emoji: ErrorEmojis.COMMAND
    },
    {
      description: "List all tasks to see valid IDs",
      command: "minsky tasks list",
      emoji: ErrorEmojis.LIST
    }
  ];

  const template: ErrorTemplate = {
    title: `${ErrorEmojis.FAILED} Invalid Task ID Format`,
    description: `The task ID '${invalidTaskId}' is not in a valid format.`,
    sections: [
      {
        title: "Supported formats:",
        emoji: ErrorEmojis.INFO,
        content: validExamples.map(example => `• ${example}`).join("\n")
      },
      {
        title: "Try these commands:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions(suggestions)
      }
    ]
  };

  return buildErrorMessage(template, context);
}

/**
 * Enhanced error message for variable naming mismatches
 * Requirement 3: Point to specific declaration vs usage mismatches in error messages
 */
export function createVariableNamingErrorMessage(
  variableName: string,
  declarationType: "with_underscore" | "without_underscore",
  usageType: "with_underscore" | "without_underscore",
  filePath?: string,
  declarationLine?: number,
  usageLine?: number,
  context?: ContextInfo[]
): string {
  const isUnderscoreMismatch = declarationType !== usageType;
  
  let description: string;
  let fixSuggestion: CommandSuggestion;

  if (isUnderscoreMismatch) {
    if (declarationType === "with_underscore" && usageType === "without_underscore") {
      description = `Variable '${variableName}' is declared with underscore prefix but used without underscore.`;
      fixSuggestion = {
        description: `Remove underscore from declaration (line ${declarationLine})`,
        command: `const ${variableName} = ...  // instead of const _${variableName} = ...`,
        emoji: ErrorEmojis.CHECK
      };
    } else {
      description = `Variable '${variableName}' is declared without underscore but used with underscore prefix.`;
      fixSuggestion = {
        description: `Add underscore to declaration (line ${declarationLine}) or remove from usage (line ${usageLine})`,
        command: `const _${variableName} = ...  // or use ${variableName} consistently`,
        emoji: ErrorEmojis.CHECK
      };
    }
  } else {
    description = `Variable '${variableName}' naming inconsistency detected.`;
    fixSuggestion = {
      description: "Check variable declaration and usage consistency",
      command: `grep -n "\\b${variableName}\\b" ${filePath || "<file>"}`,
      emoji: ErrorEmojis.INFO
    };
  }

  const suggestions: CommandSuggestion[] = [
    fixSuggestion,
    {
      description: "Check variable naming protocol rule",
      command: "cursor rules variable-naming-protocol.mdc",
      emoji: ErrorEmojis.HELP
    },
    {
      description: "Run variable naming check script",
      command: "bun scripts/check-variable-naming.ts",
      emoji: ErrorEmojis.COMMAND
    }
  ];

  const contextInfo: ContextInfo[] = [
    ...(context || []),
    ...(filePath ? [{ label: "File", value: filePath }] : []),
    ...(declarationLine ? [{ label: "Declaration line", value: declarationLine.toString() }] : []),
    ...(usageLine ? [{ label: "Usage line", value: usageLine.toString() }] : [])
  ];

  const template: ErrorTemplate = {
    title: `${ErrorEmojis.FAILED} Variable Declaration/Usage Mismatch`,
    description,
    sections: [
      {
        title: "How to fix:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions(suggestions)
      }
    ]
  };

  return buildErrorMessage(template, contextInfo);
}

/**
 * Enhanced error message for git command timeouts
 * Requirement 4: Add timeout handling with helpful messages for hanging git commands
 */
export function createGitTimeoutErrorMessage(
  operation: string,
  timeoutMs: number,
  workdir?: string,
  context?: ContextInfo[]
): string {
  const timeoutSeconds = Math.round(timeoutMs / 1000);
  
  const suggestions: CommandSuggestion[] = [
    {
      description: "Check network connection",
      command: "ping -c 3 github.com",
      emoji: ErrorEmojis.INFO
    },
    {
      description: "Check git remote status",
      command: "git remote -v",
      emoji: ErrorEmojis.LIST
    },
    {
      description: "Try with increased timeout",
      command: "git config --global http.lowSpeedLimit 0",
      emoji: ErrorEmojis.COMMAND
    },
    {
      description: "Check repository size and consider shallow clone",
      command: "git count-objects -v",
      emoji: ErrorEmojis.INFO
    },
    {
      description: "Retry with verbose output",
      command: `git ${operation} --verbose`,
      emoji: ErrorEmojis.HELP
    }
  ];

  const contextInfo: ContextInfo[] = [
    ...(context || []),
    { label: "Operation", value: operation },
    { label: "Timeout", value: `${timeoutSeconds} seconds` },
    ...(workdir ? [{ label: "Working directory", value: workdir }] : [])
  ];

  const template: ErrorTemplate = {
    title: `${ErrorEmojis.WARNING} Git Operation Timeout`,
    description: `Git ${operation} operation timed out after ${timeoutSeconds} seconds.`,
    sections: [
      {
        title: "Troubleshooting steps:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions(suggestions)
      }
    ]
  };

  return buildErrorMessage(template, contextInfo);
}

/**
 * Enhanced error message for merge conflicts with specific file details
 * Requirement 5: Identify specific conflicting files and suggest resolution strategies
 */
export function createMergeConflictErrorMessage(
  operation: string,
  conflictingFiles: string[],
  conflictTypes: { [file: string]: "modify/modify" | "add/add" | "delete/modify" | "other" },
  workdir?: string,
  context?: ContextInfo[]
): string {
  const fileList = conflictingFiles.map(file => {
    const type = conflictTypes[file] || "other";
    const typeEmoji = {
      "modify/modify": "✏️",
      "add/add": "➕", 
      "delete/modify": "🗑️",
      "other": "⚠️"
    }[type];
    return `${typeEmoji} ${file} (${type} conflict)`;
  }).join("\n");

  const suggestions: CommandSuggestion[] = [
    {
      description: "View conflict status",
      command: "git status",
      emoji: ErrorEmojis.INFO
    },
    {
      description: "List conflicted files only",
      command: "git diff --name-only --diff-filter=U",
      emoji: ErrorEmojis.FILE
    },
    {
      description: "Edit conflicts in first file",
      command: conflictingFiles.length > 0 ? `code ${conflictingFiles[0]}` : "code <conflicted-file>",
      emoji: ErrorEmojis.FILE
    },
    {
      description: "Use merge tool",
      command: "git mergetool",
      emoji: ErrorEmojis.COMMAND
    },
    {
      description: "Accept all incoming changes",
      command: "git checkout --theirs .",
      emoji: ErrorEmojis.NEXT_STEP
    },
    {
      description: "Accept all current changes", 
      command: "git checkout --ours .",
      emoji: ErrorEmojis.NEXT_STEP
    },
    {
      description: "Mark conflicts as resolved",
      command: "git add .",
      emoji: ErrorEmojis.CHECK
    },
    {
      description: "Complete the merge",
      command: `git ${operation} --continue`,
      emoji: ErrorEmojis.NEXT_STEP
    }
  ];

  const contextInfo: ContextInfo[] = [
    ...(context || []),
    { label: "Operation", value: operation },
    { label: "Conflicted files", value: conflictingFiles.length.toString() },
    ...(workdir ? [{ label: "Working directory", value: workdir }] : [])
  ];

  const template: ErrorTemplate = {
    title: `${ErrorEmojis.CONFLICT} Merge Conflicts Detected`,
    description: `The ${operation} operation failed due to conflicts in ${conflictingFiles.length} file(s).`,
    sections: [
      {
        title: "Conflicted files:",
        emoji: ErrorEmojis.FILE,
        content: fileList
      },
      {
        title: "Resolution steps:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions(suggestions)
      }
    ]
  };

  return buildErrorMessage(template, contextInfo);
}

/**
 * Enhanced error message for backend detection failures
 * Requirement 6: Show available backends and configuration requirements when detection fails
 */
export function createBackendDetectionErrorMessage(
  attemptedBackend?: string,
  availableBackends: string[] = [],
  configurationRequirements: { [backend: string]: string[] } = {},
  workspacePath?: string,
  context?: ContextInfo[]
): string {
  const backendsList = availableBackends.length > 0 
    ? availableBackends.map(backend => {
      const requirements = configurationRequirements[backend] || [];
      const reqText = requirements.length > 0 ? ` (requires: ${requirements.join(", ")})` : "";
      return `• ${backend}${reqText}`;
    }).join("\n")
    : "• markdown (default)\n• json-file\n• github-issues (requires GitHub config)";

  const suggestions: CommandSuggestion[] = [
    {
      description: "Check current configuration",
      command: "minsky config show",
      emoji: ErrorEmojis.INFO
    },
    {
      description: "List available backends",
      command: "minsky config list",
      emoji: ErrorEmojis.LIST
    },
    {
      description: "Set backend explicitly",
      command: "minsky config set backend markdown",
      emoji: ErrorEmojis.COMMAND
    },
    {
      description: "Check workspace for task files",
      command: "find . -name 'tasks.md' -o -name 'tasks.json' -o -path '*/.minsky/*'",
      emoji: ErrorEmojis.FILE
    },
    {
      description: "Initialize workspace with backend",
      command: "minsky init --backend markdown",
      emoji: ErrorEmojis.CREATE
    }
  ];

  const contextInfo: ContextInfo[] = [
    ...(context || []),
    ...(attemptedBackend ? [{ label: "Attempted backend", value: attemptedBackend }] : []),
    { label: "Available backends", value: availableBackends.length.toString() },
    ...(workspacePath ? [{ label: "Workspace path", value: workspacePath }] : [])
  ];

  const template: ErrorTemplate = {
    title: `${ErrorEmojis.FAILED} Backend Detection Failed`,
    description: attemptedBackend 
      ? `Failed to configure or detect backend '${attemptedBackend}'.`
      : "Failed to automatically detect appropriate task backend for this workspace.",
    sections: [
      {
        title: "Available backends:",
        emoji: ErrorEmojis.LIST,
        content: backendsList
      },
      {
        title: "Configuration options:",
        emoji: ErrorEmojis.SUGGESTION,
        content: formatCommandSuggestions(suggestions)
      }
    ]
  };

  return buildErrorMessage(template, contextInfo);
} 
