/**
 * @fileoverview ESLint rule to prevent unreliable async factory mock patterns
 * @author Task #332 - Refactored from no-jest-patterns for proper separation of concerns
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

export default {
  meta: {
    type: "problem",
    docs: {
      description: "prevent unreliable async factory mock patterns that cause race conditions",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      unreliableFactoryMock:
        "Unreliable factory mock pattern '{{pattern}}' detected. Use explicit mock patterns with fixed return values instead.",
    },
  },

  create(context) {
    // Check if current file is a test file
    const filename = context.getFilename();
    const isTestFile =
      /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(filename) ||
      /\/(tests?|__tests__|spec)\//i.test(filename);

    if (!isTestFile) {
      return {}; // Only apply to test files
    }

    return {
      // Check for unreliable factory mock patterns
      CallExpression(node) {
        // Check for createMock* patterns with async functions
        if (
          node.callee.type === "Identifier" &&
          /^createMock.*$/.test(node.callee.name) &&
          node.arguments.length > 0 &&
          node.arguments[0].type === "ArrowFunctionExpression"
        ) {
          const firstArg = context.getSourceCode().getText(node.arguments[0]);
          if (firstArg.includes("async") || firstArg.includes("await")) {
            context.report({
              node,
              messageId: "unreliableFactoryMock",
              data: { pattern: `${node.callee.name}(${firstArg.substring(0, 30)}...)` },
            });
          }
        }

        // Check for createMock() with async functions (general pattern)
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "createMock" &&
          node.arguments.length > 0 &&
          node.arguments[0].type === "ArrowFunctionExpression"
        ) {
          const firstArg = context.getSourceCode().getText(node.arguments[0]);
          if (
            firstArg.includes("async") ||
            firstArg.includes("await") ||
            firstArg.includes("Promise")
          ) {
            context.report({
              node,
              messageId: "unreliableFactoryMock",
              data: { pattern: `createMock(${firstArg.substring(0, 30)}...)` },
            });
          }
        }
      },
    };
  },
};
