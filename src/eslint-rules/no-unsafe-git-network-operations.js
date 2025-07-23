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
  "execGitWithTimeout"
];

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "prevent unsafe git network operations without timeout protection",
      category: "Possible Errors",
      recommended: true,
      url: "https://github.com/minsky/eslint-rules/no-unsafe-git-network-operations"
    },
    fixable: "code",
    schema: [],
    messages: {
      unsafeGitNetworkOp: "Git network operation '{{command}}' without timeout protection. Use {{suggestion}} instead of execAsync/exec.",
      unsafeExecAsync: "execAsync with git {{command}} command detected. Use {{suggestion}} for timeout protection.",
      missingAwait: "Git timeout function {{functionName}} should be awaited."
    }
  },

  create(context) {
    return {
      // Check execAsync/exec calls with git commands
      CallExpression(node) {
        const callee = node.callee;
        
        // Check for execAsync or exec calls
        if (callee.type === "Identifier" && (callee.name === "execAsync" || callee.name === "exec")) {
          const firstArg = node.arguments[0];
          
          if (firstArg && firstArg.type === "Literal" && typeof firstArg.value === "string") {
            const command = firstArg.value;
            
            // Check if it's a git command with unsafe network operations
            const gitMatch = command.match(/git\s+(-C\s+\S+\s+)?(\w+)/);
            if (gitMatch) {
              const gitCommand = gitMatch[2];
              
              if (UNSAFE_GIT_COMMANDS.includes(gitCommand)) {
                const suggestion = getSafeAlternative(gitCommand);
                
                context.report({
                  node,
                  messageId: "unsafeExecAsync",
                  data: {
                    command: gitCommand,
                    suggestion
                  },
                  fix(fixer) {
                    return generateAutoFix(fixer, node, gitCommand, command);
                  }
                });
              }
            }
          }
          
          // Check template literals with git commands
          if (firstArg && firstArg.type === "TemplateLiteral") {
            const templateValue = getTemplateLiteralValue(firstArg);
            if (templateValue && templateValue.includes("git ")) {
              for (const unsafeCmd of UNSAFE_GIT_COMMANDS) {
                if (templateValue.includes(`git ${unsafeCmd}`) || templateValue.includes("git -C") && templateValue.includes(unsafeCmd)) {
                  const suggestion = getSafeAlternative(unsafeCmd);
                  
                  context.report({
                    node,
                    messageId: "unsafeGitNetworkOp", 
                    data: {
                      command: unsafeCmd,
                      suggestion
                    }
                  });
                }
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
                functionName: callee.name
              },
              fix(fixer) {
                return fixer.insertTextBefore(node, "await ");
              }
            });
          }
        }
      }
    };
  }
};

//------------------------------------------------------------------------------
// Helper Functions
//------------------------------------------------------------------------------

function getSafeAlternative(gitCommand) {
  const alternatives = {
    "push": "gitPushWithTimeout",
    "pull": "gitPullWithTimeout", 
    "fetch": "gitFetchWithTimeout",
    "clone": "gitCloneWithTimeout",
    "ls-remote": "execGitWithTimeout"
  };
  
  return alternatives[gitCommand] || "execGitWithTimeout";
}

function generateAutoFix(fixer, node, gitCommand, originalCommand) {
  // Extract workdir from git -C option
  const workdirMatch = originalCommand.match(/git\s+-C\s+(\S+)/);
  const workdir = workdirMatch ? workdirMatch[1] : null;
  
  // Create options object
  const options = workdir ? `{ workdir: "${workdir}" }` : "{}";
  
  // For all cases, use execGitWithTimeout consistently
  return fixer.replaceText(
    node,
    `await execGitWithTimeout("${gitCommand}", "${originalCommand}", ${options})`
  );
}

function getTemplateLiteralValue(node) {
  if (node.quasis.length === 1 && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
} 
