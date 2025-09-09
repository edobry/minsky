/**
 * @fileoverview ESLint rule to prevent unsafe git network operations
 *
 * This rule prevents git network operations (push, pull, fetch, clone) from being
 * executed without timeout protection, which was the root cause of hanging issues
 * identified in Task #294 Phase 1 audit.
 *
 * @author Minsky Concurrency Audit Task #294
 */

"use strict";

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

const UNSAFE_GIT_COMMANDS = ["push", "pull", "fetch", "clone", "ls-remote"];
const SAFE_TIMEOUT_FUNCTIONS = [
  "gitPushWithTimeout",
  "gitPullWithTimeout",
  "gitFetchWithTimeout",
  "gitCloneWithTimeout",
  "execGitWithTimeout",
];

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "prevent unsafe git network operations without timeout protection",
      category: "Possible Errors",
      recommended: true,
      url: "https://github.com/minsky/eslint-rules/no-unsafe-git-network-operations",
    },
    fixable: "code",
    schema: [],
    messages: {
      unsafeGitNetworkOp:
        "Git network operation '{{command}}' without timeout protection. Use {{suggestion}} instead of execAsync/exec.",
      unsafeExecAsync:
        "execAsync with git {{command}} command detected. Use {{suggestion}} for timeout protection.",
      missingAwait: "Git timeout function {{functionName}} should be awaited.",
    },
  },

  create(context) {
    return {
      // Check execAsync/exec calls with git commands
      CallExpression(node) {
        const callee = node.callee;

        // Check for execAsync or exec calls
        if (
          callee.type === "Identifier" &&
          (callee.name === "execAsync" || callee.name === "exec")
        ) {
          const firstArg = node.arguments[0];

          if (firstArg && firstArg.type === "Literal" && typeof firstArg.value === "string") {
            const command = firstArg.value;

            // Check if it's a git command with unsafe network operations
            const gitMatch = command.match(/git\s+(-C\s+\S+\s+)?([\w-]+)/);
            if (gitMatch) {
              const gitCommand = gitMatch[2];

              if (UNSAFE_GIT_COMMANDS.includes(gitCommand)) {
                const suggestion = getSafeAlternative(gitCommand);

                context.report({
                  node,
                  messageId: "unsafeExecAsync",
                  data: {
                    command: gitCommand,
                    suggestion,
                  },
                  fix(fixer) {
                    return generateAutoFix(fixer, node, gitCommand, command);
                  },
                });
              }
            }
          }

          // Check template literals with git commands
          if (firstArg && firstArg.type === "TemplateLiteral") {
            // Check all template parts for git commands
            const hasGitCommand = firstArg.quasis.some(
              (quasi) => quasi.value.cooked && quasi.value.cooked.includes("git ")
            );

            if (hasGitCommand) {
              // Find which specific unsafe command is in the template
              let foundCommand = null;

              // Get all text parts from the template
              const allTextParts = firstArg.quasis.map((q) => q.value.cooked || "").join(" ");

              for (const unsafeCmd of UNSAFE_GIT_COMMANDS) {
                // Check if the command appears anywhere in the template
                if (
                  allTextParts.includes(` ${unsafeCmd} `) ||
                  allTextParts.includes(`git ${unsafeCmd}`) ||
                  allTextParts.match(new RegExp(`\\b${unsafeCmd}\\b`))
                ) {
                  foundCommand = unsafeCmd;
                  break;
                }
              }

              if (foundCommand) {
                const suggestion = getSafeAlternative(foundCommand);

                context.report({
                  node,
                  messageId: "unsafeGitNetworkOp",
                  data: {
                    command: foundCommand,
                    suggestion,
                  },
                  // Template literals with variables can't be auto-fixed
                  fix: null,
                });
              }
            }
          }
        }

        // Check for proper await usage of timeout functions
        if (callee.type === "Identifier" && SAFE_TIMEOUT_FUNCTIONS.includes(callee.name)) {
          const parent = node.parent;
          if (parent.type !== "AwaitExpression") {
            context.report({
              node,
              messageId: "missingAwait",
              data: {
                functionName: callee.name,
              },
              fix(fixer) {
                return fixer.insertTextBefore(node, "await ");
              },
            });
          }
        }
      },
    };
  },
};

//------------------------------------------------------------------------------
// Helper Functions
//------------------------------------------------------------------------------

function getSafeAlternative(gitCommand) {
  const alternatives = {
    push: "gitPushWithTimeout",
    pull: "gitPullWithTimeout",
    fetch: "gitFetchWithTimeout",
    clone: "gitCloneWithTimeout",
    "ls-remote": "execGitWithTimeout",
  };

  return alternatives[gitCommand] || "execGitWithTimeout";
}

function generateAutoFix(fixer, node, gitCommand, originalCommand) {
  // All unsafe git commands should use execGitWithTimeout
  // Extract git arguments for conversion
  const gitMatch = originalCommand.match(/git\s+(-C\s+(\S+)\s+)?(.+)/);
  if (!gitMatch) return null;

  const workdir = gitMatch[2];
  const args = gitMatch[3];

  // For execGitWithTimeout: execGitWithTimeout("operation", "command", { workdir })
  const operation = gitCommand;
  const command = args;
  const options = workdir ? `{ workdir: "${workdir}" }` : "{}";

  // Check if we need to preserve the await
  const parent = node.parent;
  const isAwaited = parent && parent.type === "AwaitExpression";

  // Build the replacement text
  const replacementText = `execGitWithTimeout("${operation}", "${command}", ${options})`;

  if (isAwaited) {
    // Replace the entire await expression with our new await expression
    return fixer.replaceText(parent, `await ${replacementText}`);
  } else {
    // Just replace the call expression
    return fixer.replaceText(node, replacementText);
  }
}

function getTemplateLiteralValue(node) {
  if (node.quasis.length === 1 && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}
