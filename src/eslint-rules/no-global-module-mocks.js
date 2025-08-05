/**
 * @fileoverview ESLint rule to prevent global mock.module() usage that causes cross-test interference
 * @author Task #332 - Refactored from no-jest-patterns for proper separation of concerns
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

export default {
  meta: {
    type: "problem",
    docs: {
      description: "prevent global mock.module() usage outside test blocks",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      globalModuleMock:
        "Global mock.module() detected. Use test-scoped mocking in test-utils or within describe blocks to prevent cross-test interference.",
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
      // Check for mock.module() calls
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.name === "mock" &&
          node.callee.property.name === "module"
        ) {
          // Check if this is at module level (not within describe/test blocks)
          let parent = node.parent;
          let isInTestBlock = false;

          while (parent) {
            if (
              parent.type === "CallExpression" &&
              parent.callee &&
              parent.callee.name &&
              ["describe", "it", "test", "beforeEach", "afterEach"].includes(parent.callee.name)
            ) {
              isInTestBlock = true;
              break;
            }
            parent = parent.parent;
          }

          if (!isInTestBlock) {
            context.report({
              node,
              messageId: "globalModuleMock",
            });
          }
        }
      },
    };
  },
};
