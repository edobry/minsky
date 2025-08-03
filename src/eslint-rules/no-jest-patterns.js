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

      // NEW: Test Anti-Pattern Messages (Task #332 extension)
      globalModuleMock:
        "Global mock.module() detected. Use test-scoped mocking in test-utils or within describe blocks to prevent cross-test interference.",
      unreliableFactoryMock:
        "Unreliable factory mock pattern '{{pattern}}' detected. Use explicit mock patterns with fixed return values instead.",
      cliExecutionInTest:
        "CLI execution '{{pattern}}' detected in test file. Tests should call domain functions directly, not CLI interfaces.",
      magicStringDuplication:
        "Magic string '{{value}}' appears to be duplicated. Extract to shared constants or test-utils to prevent inconsistencies.",
    },
  },

  create(context) {
    // Track magic strings for duplication detection
    const magicStrings = new Map(); // string -> array of locations

    // Check if current file is a test file
    const filename = context.getFilename();
    const isTestFile =
      /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(filename) ||
      /\/(tests?|__tests__|spec)\//i.test(filename);

    if (!isTestFile) {
      return {}; // Only apply anti-pattern detection to test files
    }

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

        // NEW: Global mock.module() detection (Task #332 extension)
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

        // NEW: Unreliable factory mock patterns (Task #332 extension)
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

        // NEW: CLI execution pattern detection (Task #332 extension)
        if (
          node.callee.type === "Identifier" &&
          (node.callee.name === "execAsync" ||
            node.callee.name === "spawn" ||
            node.callee.name === "exec")
        ) {
          const args = node.arguments;
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
        }

        // NEW: CLI execution via template literals (Task #332 extension)
        if (
          node.callee.type === "Identifier" &&
          (node.callee.name === "execAsync" || node.callee.name === "spawn") &&
          node.arguments.length > 0 &&
          node.arguments[0].type === "TemplateLiteral"
        ) {
          const templateLiteral = node.arguments[0];
          const templateText = context.getSourceCode().getText(templateLiteral);
          if (templateText.includes("cli.ts") || templateText.includes("bun run")) {
            context.report({
              node,
              messageId: "cliExecutionInTest",
              data: { pattern: `${node.callee.name}(\`${templateText.substring(0, 30)}...\`)` },
            });
          }
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

      // NEW: Magic string duplication detection (Task #332 extension)
      Literal(node) {
        if (typeof node.value === "string" && node.value.length > 15) {
          // Only track longer strings (15+ chars) to reduce noise
          // Skip common test strings that are expected to be duplicated
          const skipPatterns = [
            /^test.*$/i,
            /^should.*$/i,
            /^expect.*$/i,
            /^describe.*$/i,
            /^it .*$/i,
            /^Error.*$/i,
            /^Mock.*$/i,
            /^\/.*\/$/, // paths
            /^http.*$/i, // URLs
            /^TODO$/i,
            /^IN-PROGRESS$/i,
            /^DONE$/i,
            /^BLOCKED$/i,
            /^IN_PROGRESS$/i,
            /^\/test\/workspace$/i,
            /^\/mock\/.*$/i,
            /^minsky:.*$/i,
            /^github-issues$/i,
            /^session\..*$/i,
            /^custom-session$/i,
            /^local-minsky$/i,
            /^task-.*$/i,
            /^md#.*$/i,
            /^gh#.*$/i,
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*$/i, // ISO dates
            /^#\d+$/i, // ID patterns
          ];

          const shouldSkip = skipPatterns.some((pattern) => pattern.test(node.value));
          if (shouldSkip) return;

          if (!magicStrings.has(node.value)) {
            magicStrings.set(node.value, []);
          }

          magicStrings.get(node.value).push({
            node,
            line: node.loc.start.line,
            column: node.loc.start.column,
          });
        }
      },

      // NEW: Report magic string duplications at end of file (Task #332 extension)
      "Program:exit"() {
        for (const [stringValue, locations] of magicStrings.entries()) {
          // Only report if there are 3+ duplicates to reduce noise
          if (locations.length > 2) {
            // Report all but the first occurrence as duplications
            for (let i = 1; i < locations.length; i++) {
              context.report({
                node: locations[i].node,
                messageId: "magicStringDuplication",
                data: {
                  value: stringValue.substring(0, 50) + (stringValue.length > 50 ? "..." : ""),
                },
              });
            }
          }
        }
      },
    };
  },
};
