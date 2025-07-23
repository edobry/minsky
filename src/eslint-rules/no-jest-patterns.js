/**
 * @fileoverview ESLint rule to prevent Jest patterns and enforce Bun test patterns
 * @author Task #300
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

export default {
  meta: {
    type: "problem",
    docs: {
      description: "prevent Jest patterns and enforce Bun test patterns",
      category: "Best Practices",
      recommended: true,
    },
    fixable: "code",
    schema: [],
    messages: {
      jestImport: "Use Bun test imports instead of Jest imports. Import from 'bun:test' instead.",
      jestFn: "Use Bun test patterns: import { mock } from 'bun:test'; const mockFn = mock();",
      jestMock: "Use centralized mockModule() from test-utils/mocking.ts instead of jest.mock()",
      jestSpyOn: "Use Bun test patterns: import { spyOn } from 'bun:test'; spyOn(obj, 'method');",
      mockImplementation:
        "Use Bun mock patterns: mock(() => returnValue) or mock().mockImplementation(() => returnValue)",
      mockReturnValue:
        "Use Bun mock patterns: mock(() => returnValue) instead of .mockReturnValue()",
      mockResolvedValue:
        "Use Bun mock patterns: mock(() => Promise.resolve(value)) instead of .mockResolvedValue()",
      mockRejectedValue:
        "Use Bun mock patterns: mock(() => Promise.reject(error)) instead of .mockRejectedValue()",
    },
  },

  create(context) {
    return {
      // Check import statements
      ImportDeclaration(node) {
        if (
          node.source.value === "jest" ||
          node.source.value.includes("@jest/") ||
          node.source.value === "@testing-library/jest-dom"
        ) {
          context.report({
            node,
            messageId: "jestImport",
            fix(fixer) {
              // Simple auto-fix for basic jest imports
              if (node.source.value === "jest") {
                const importText = context.getSourceCode().getText(node);

                // Convert jest imports to bun:test imports
                if (importText.includes("import jest")) {
                  const bunImport = importText.replace(
                    /import\s+.*?\s+from\s+['"']jest['"']/,
                    "import { mock, spyOn } from 'bun:test'"
                  );
                  return fixer.replaceText(node, bunImport);
                }
              }
              return null;
            },
          });
        }
      },

      // Check for jest.fn() calls
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.name === "jest" &&
          node.callee.property.name === "fn"
        ) {
          context.report({
            node,
            messageId: "jestFn",
            fix(fixer) {
              return fixer.replaceText(node, "mock()");
            },
          });
        }

        // Check for jest.mock() calls
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.name === "jest" &&
          node.callee.property.name === "mock"
        ) {
          context.report({
            node,
            messageId: "jestMock",
            fix(fixer) {
              // For simple cases, suggest using mockModule
              const args = node.arguments
                .map((arg) => context.getSourceCode().getText(arg))
                .join(", ");
              return fixer.replaceText(node, `mockModule(${args})`);
            },
          });
        }

        // Check for jest.spyOn() calls
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.name === "jest" &&
          node.callee.property.name === "spyOn"
        ) {
          context.report({
            node,
            messageId: "jestSpyOn",
            fix(fixer) {
              const args = node.arguments
                .map((arg) => context.getSourceCode().getText(arg))
                .join(", ");
              return fixer.replaceText(node, `spyOn(${args})`);
            },
          });
        }

        // Check for .mockImplementation() calls
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.name === "mockImplementation"
        ) {
          const object = context.getSourceCode().getText(node.callee.object);

          // ALLOW: spyOn().mockImplementation() - this is valid Bun pattern
          if (object.includes("spyOn")) {
            return; // Skip - this is a valid pattern
          }

          context.report({
            node,
            messageId: "mockImplementation",
            fix(fixer) {
              const arg = node.arguments[0]
                ? context.getSourceCode().getText(node.arguments[0])
                : "() => {}";

              // Handle createMock().mockImplementation() pattern
              if (object.includes("createMock()")) {
                return fixer.replaceText(node, `mock(${arg})`);
              }

              return fixer.replaceText(node, `${object} = mock(${arg})`);
            },
          });
        }

        // Check for .mockReturnValue() calls
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.name === "mockReturnValue"
        ) {
          context.report({
            node,
            messageId: "mockReturnValue",
            fix(fixer) {
              const object = context.getSourceCode().getText(node.callee.object);
              const arg = node.arguments[0]
                ? context.getSourceCode().getText(node.arguments[0])
                : "undefined";

              // Handle createMock().mockReturnValue() pattern
              if (object.includes("createMock()")) {
                return fixer.replaceText(node, `mock(() => ${arg})`);
              }

              return fixer.replaceText(node, `${object} = mock(() => ${arg})`);
            },
          });
        }

        // Check for .mockResolvedValue() calls
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.name === "mockResolvedValue"
        ) {
          context.report({
            node,
            messageId: "mockResolvedValue",
            fix(fixer) {
              const object = context.getSourceCode().getText(node.callee.object);
              const arg = node.arguments[0]
                ? context.getSourceCode().getText(node.arguments[0])
                : "undefined";

              // Handle createMock().mockResolvedValue() pattern
              if (object.includes("createMock()")) {
                return fixer.replaceText(node, `mock(() => Promise.resolve(${arg}))`);
              }

              return fixer.replaceText(node, `${object} = mock(() => Promise.resolve(${arg}))`);
            },
          });
        }

        // Check for .mockRejectedValue() calls
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.name === "mockRejectedValue"
        ) {
          context.report({
            node,
            messageId: "mockRejectedValue",
            fix(fixer) {
              const object = context.getSourceCode().getText(node.callee.object);
              const arg = node.arguments[0]
                ? context.getSourceCode().getText(node.arguments[0])
                : "new Error()";

              // Handle createMock().mockRejectedValue() pattern
              if (object.includes("createMock()")) {
                return fixer.replaceText(node, `mock(() => Promise.reject(${arg}))`);
              }

              return fixer.replaceText(node, `${object} = mock(() => Promise.reject(${arg}))`);
            },
          });
        }

        // Check for .mockResolvedValueOnce() calls (common in tests)
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.name === "mockResolvedValueOnce"
        ) {
          context.report({
            node,
            messageId: "mockResolvedValue",
            fix(fixer) {
              const object = context.getSourceCode().getText(node.callee.object);
              const arg = node.arguments[0]
                ? context.getSourceCode().getText(node.arguments[0])
                : "undefined";
              return fixer.replaceText(
                node,
                `${object}.mockImplementationOnce(() => Promise.resolve(${arg}))`
              );
            },
          });
        }

        // Check for .mockRejectedValueOnce() calls (common in tests)
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.name === "mockRejectedValueOnce"
        ) {
          context.report({
            node,
            messageId: "mockRejectedValue",
            fix(fixer) {
              const object = context.getSourceCode().getText(node.callee.object);
              const arg = node.arguments[0]
                ? context.getSourceCode().getText(node.arguments[0])
                : "new Error()";
              return fixer.replaceText(
                node,
                `${object}.mockImplementationOnce(() => Promise.reject(${arg}))`
              );
            },
          });
        }
      },

      // Check variable declarations that might be Jest mocks
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === "CallExpression" &&
          node.init.callee.type === "MemberExpression" &&
          node.init.callee.object.name === "jest" &&
          (node.init.callee.property.name === "fn" || node.init.callee.property.name === "mock")
        ) {
          context.report({
            node: node.init,
            messageId: node.init.callee.property.name === "fn" ? "jestFn" : "jestMock",
            fix(fixer) {
              if (node.init.callee.property.name === "fn") {
                return fixer.replaceText(node.init, "mock()");
              }
              return null; // Let the CallExpression handler deal with jest.mock
            },
          });
        }
      },
    };
  },
};
