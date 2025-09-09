/**
 * @fileoverview ESLint rule to prevent CLI execution in tests (architectural violation)
 * @author Task #332 - Refactored from no-jest-patterns for proper separation of concerns
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

export default {
  meta: {
    type: "problem",
    docs: {
      description: "prevent CLI execution in tests - tests should call domain functions directly",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      cliExecutionInTest:
        "CLI execution '{{pattern}}' detected in test file. Tests should call domain functions directly, not CLI interfaces.",
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
      // Check for CLI execution patterns
      CallExpression(node) {
        // Check for execAsync, spawn, exec calls with CLI commands
        if (
          node.callee.type === "Identifier" &&
          (node.callee.name === "execAsync" ||
            node.callee.name === "spawn" ||
            node.callee.name === "exec")
        ) {
          const args = node.arguments;

          // Check string literals
          if (args.length > 0 && args[0].type === "Literal") {
            const command = args[0].value;
            if (typeof command === "string" && command.includes("cli.ts")) {
              context.report({
                node,
                messageId: "cliExecutionInTest",
                data: { pattern: `${node.callee.name}("${command}")` },
              });
            }
          }

          // Check template literals
          if (args.length > 0 && args[0].type === "TemplateLiteral") {
            const templateLiteral = args[0];
            const templateText = context.getSourceCode().getText(templateLiteral);
            if (templateText.includes("cli.ts") || templateText.includes("bun run")) {
              context.report({
                node,
                messageId: "cliExecutionInTest",
                data: { pattern: `${node.callee.name}(\`${templateText.substring(0, 30)}...\`)` },
              });
            }
          }
        }
      },
    };
  },
};
