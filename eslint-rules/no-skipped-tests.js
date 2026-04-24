/**
 * @fileoverview ESLint rule to prevent skipped and todo tests in test files
 * @author Task mt#1151
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "prevent skipped tests (describe.skip, it.skip, test.skip) and todo placeholders (test.todo, it.todo, describe.todo)",
      category: "Best Practices",
      recommended: true,
    },
    schema: [],
    messages: {
      skippedTest:
        "'{{object}}.skip()' skips tests silently. Either fix and enable the test, or remove it. Use eslint-disable with a justification if skipping is genuinely required.",
      todoTest:
        "'{{object}}.todo()' leaves unimplemented test placeholders. Implement the test or remove the placeholder. Use eslint-disable with a justification if deferral is genuinely required.",
    },
  },

  create(context) {
    // Only apply to test files
    const filename = context.getFilename();
    const isTestFile = /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(filename);

    if (!isTestFile) {
      return {};
    }

    // Objects that can carry .skip() / .todo()
    const TEST_OBJECTS = new Set(["describe", "it", "test"]);

    return {
      CallExpression(node) {
        const callee = node.callee;

        // Match: describe.skip(...), it.skip(...), test.skip(...),
        //        describe.todo(...), it.todo(...), test.todo(...)
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          TEST_OBJECTS.has(callee.object.name) &&
          callee.property.type === "Identifier" &&
          (callee.property.name === "skip" || callee.property.name === "todo")
        ) {
          const objectName = callee.object.name;
          const methodName = callee.property.name;

          context.report({
            node,
            messageId: methodName === "skip" ? "skippedTest" : "todoTest",
            data: { object: objectName },
          });
        }
      },
    };
  },
};
