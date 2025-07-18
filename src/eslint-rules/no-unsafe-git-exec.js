/**
 * ESLint rule to prevent unsafe git command execution without timeout handling
 *
 * This rule detects git commands executed through basic execAsync/exec calls that can hang
 * indefinitely without timeout protection. Based on the analysis from the session PR hanging
 * issue, it identifies patterns that should use timeout-aware git utilities instead.
 *
 * The rule categorizes git operations by hang risk:
 * - ERROR: Network operations (push, pull, fetch, clone) that commonly hang
 * - WARN: Remote queries (ls-remote) that can hang on network issues
 * - INFO: Local operations that are generally safe but should use consistent patterns
 */

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Prevent git commands that can hang indefinitely without timeout handling",
      category: "Performance",
      recommended: true,
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          allowInTests: {
            type: "boolean",
            default: false,
          },
          allowedLocalOperations: {
            type: "array",
            items: {
              type: "string",
            },
            default: ["status", "branch", "log", "diff", "show"],
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      networkGitOperation: "Critical: Git {{operation}} can hang indefinitely. Use {{suggestion}} instead.",
      remoteGitOperation: "Warning: Git {{operation}} may hang on network issues. Use {{suggestion}} instead.",
      unsafeGitExec: "Git command should use timeout-aware utilities. Consider {{suggestion}}.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowInTests = options.allowInTests || false;
    const allowedLocalOperations = options.allowedLocalOperations || ["status", "branch", "log", "diff", "show"];

    // Check if we're in a test file
    const filename = context.getFilename();
    const isTestFile = filename.includes(".test.") || filename.includes(".spec.") || filename.includes("/test/");

    if (allowInTests && isTestFile) {
      return {};
    }

    // High-risk network operations that commonly hang
    const networkOperations = ["push", "pull", "fetch", "clone"];

    // Medium-risk remote operations that can hang
    const remoteOperations = ["ls-remote", "remote"];

    function getGitOperation(commandString) {
      // Extract git operation from command string
      const gitMatch = commandString.match(/git\s+(?:-C\s+\S+\s+)?([a-z-]+)/);
      return gitMatch ? gitMatch[1] : null;
    }

    function getSuggestion(operation) {
      const suggestions = {
        "push": "gitPushWithTimeout() or execGitWithTimeout('push', ...)",
        "pull": "gitPullWithTimeout() or execGitWithTimeout('pull', ...)",
        "fetch": "gitFetchWithTimeout() or execGitWithTimeout('fetch', ...)",
        "clone": "gitCloneWithTimeout() or execGitWithTimeout('clone', ...)",
        "ls-remote": "execGitWithTimeout('ls-remote', ...)",
        "remote": "execGitWithTimeout('remote', ...)",
      };
      return suggestions[operation] || "execGitWithTimeout() with appropriate timeout";
    }

    function checkGitCommand(node, commandString) {
      const operation = getGitOperation(commandString);
      if (!operation) return;

      // Skip allowed local operations unless they're in a risky pattern
      if (allowedLocalOperations.includes(operation)) {
        return;
      }

      if (networkOperations.includes(operation)) {
        context.report({
          node,
          messageId: "networkGitOperation",
          data: {
            operation,
            suggestion: getSuggestion(operation),
          },
        });
      } else if (remoteOperations.includes(operation)) {
        context.report({
          node,
          messageId: "remoteGitOperation",
          data: {
            operation,
            suggestion: getSuggestion(operation),
          },
        });
      } else {
        // Any other git operation through basic exec
        context.report({
          node,
          messageId: "unsafeGitExec",
          data: {
            suggestion: getSuggestion(operation),
          },
        });
      }
    }

    return {
      CallExpression(node) {
        // Check for execAsync calls
        if (
          node.callee.name === "execAsync" ||
          (node.callee.type === "MemberExpression" &&
           node.callee.property.name === "execAsync")
        ) {
          const firstArg = node.arguments[0];
          if (firstArg && firstArg.type === "Literal" && typeof firstArg.value === "string") {
            const command = firstArg.value;
            if (command.includes("git")) {
              checkGitCommand(node, command);
            }
          } else if (firstArg && firstArg.type === "TemplateLiteral") {
            // Check template literals for git commands
            const hasGit = firstArg.quasis.some(quasi => quasi.value.raw.includes("git"));
            if (hasGit) {
              checkGitCommand(node, "git <dynamic>");
            }
          }
        }

        // Check for exec calls with git
        if (node.callee.name === "exec") {
          const firstArg = node.arguments[0];
          if (firstArg && firstArg.type === "Literal" && typeof firstArg.value === "string") {
            const command = firstArg.value;
            if (command.includes("git")) {
              checkGitCommand(node, command);
            }
          }
        }
      },
    };
  },
};
