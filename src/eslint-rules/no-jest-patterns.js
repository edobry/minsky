/**
 * ESLint rule to ban Jest testing patterns in favor of Bun test patterns
 * Part of Task #061 Phase 3: Implement ESLint enforcement for test pattern compliance
 */

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce Bun test patterns and ban Jest patterns",
      category: "Best Practices",
      recommended: true,
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          allowJestImports: {
            type: "boolean",
            default: false,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noJestFn: "Use Bun test patterns: import { mock } from 'bun:test'; const mockFn = mock(() => {})",
      noJestMock: "Use Bun test patterns: import { mock } from 'bun:test'; mock.module('module', () => ({}))",
      noMockReturnValue: "Use Bun test patterns: mockFn.mockImplementation(() => value)",
      noMockResolvedValue: "Use Bun test patterns: mockFn.mockImplementation(() => Promise.resolve(value))",
      noMockRejectedValue: "Use Bun test patterns: mockFn.mockImplementation(() => Promise.reject(error))",
      noMockImplementationOnce: "Use Bun test patterns: mockFn.mockImplementation() for consistent behavior",
      noMockReset: "Use Bun test patterns: mockFn.mockClear() instead of mockReset()",
      noToHaveBeenCalledTimes: "Use standard Bun test assertions: expect(mockFn).toHaveBeenCalledTimes(n)",
      noJestImports: "Use Bun test imports: import { describe, test, expect, mock } from 'bun:test'",
      noCentralizedFactories: "Use centralized mock factories: import { createMockSessionProvider } from '../utils/test-utils'",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowJestImports = options.allowJestImports || false;

    return {
      // Ban jest.fn() calls
      "CallExpression[callee.object.name='jest'][callee.property.name='fn']"(node) {
        context.report({
          node,
          messageId: "noJestFn",
          fix(fixer) {
            return fixer.replaceText(node, "mock(() => {})");
          },
        });
      },

      // Ban jest.mock() calls
      "CallExpression[callee.object.name='jest'][callee.property.name='mock']"(node) {
        context.report({
          node,
          messageId: "noJestMock",
          fix(fixer) {
            // This is more complex to auto-fix, so just report the error
            return null;
          },
        });
      },

      // Ban .mockReturnValue() calls
      "CallExpression[callee.property.name='mockReturnValue']"(node) {
        context.report({
          node,
          messageId: "noMockReturnValue",
          fix(fixer) {
            const args = node.arguments;
            if (args.length === 1) {
              const value = context.getSourceCode().getText(args[0]);
              return fixer.replaceText(node, `mockImplementation(() => ${value})`);
            }
            return null;
          },
        });
      },

      // Ban .mockResolvedValue() calls
      "CallExpression[callee.property.name='mockResolvedValue']"(node) {
        context.report({
          node,
          messageId: "noMockResolvedValue",
          fix(fixer) {
            const args = node.arguments;
            if (args.length === 1) {
              const value = context.getSourceCode().getText(args[0]);
              return fixer.replaceText(node, `mockImplementation(() => Promise.resolve(${value}))`);
            }
            return null;
          },
        });
      },

      // Ban .mockRejectedValue() calls
      "CallExpression[callee.property.name='mockRejectedValue']"(node) {
        context.report({
          node,
          messageId: "noMockRejectedValue",
          fix(fixer) {
            const args = node.arguments;
            if (args.length === 1) {
              const value = context.getSourceCode().getText(args[0]);
              return fixer.replaceText(node, `mockImplementation(() => Promise.reject(${value}))`);
            }
            return null;
          },
        });
      },

      // Ban .mockImplementationOnce() calls
      "CallExpression[callee.property.name='mockImplementationOnce']"(node) {
        context.report({
          node,
          messageId: "noMockImplementationOnce",
          fix(fixer) {
            return fixer.replaceText(node.callee.property, "mockImplementation");
          },
        });
      },

      // Ban .mockReset() calls
      "CallExpression[callee.property.name='mockReset']"(node) {
        context.report({
          node,
          messageId: "noMockReset",
          fix(fixer) {
            return fixer.replaceText(node.callee.property, "mockClear");
          },
        });
      },

      // Ban Jest imports
      "ImportDeclaration[source.value='@jest/globals']"(node) {
        if (!allowJestImports) {
          context.report({
            node,
            messageId: "noJestImports",
            fix(fixer) {
              return fixer.replaceText(node.source, "'bun:test'");
            },
          });
        }
      },

      "ImportDeclaration[source.value='jest']"(node) {
        if (!allowJestImports) {
          context.report({
            node,
            messageId: "noJestImports",
            fix(fixer) {
              return fixer.replaceText(node.source, "'bun:test'");
            },
          });
        }
      },

      // Encourage use of centralized factories - detect manual mock creation patterns
      "VariableDeclarator[id.name=/mock.*DB$/]"(node) {
        if (
          node.init &&
          node.init.type === "ObjectExpression" &&
          node.init.properties.length > 3 // Arbitrary threshold for "complex" manual mocks
        ) {
          // Check if this looks like a manual service mock
          const hasServiceMethods = node.init.properties.some(prop => 
            prop.key && 
            (prop.key.name === "getSession" || prop.key.name === "addSession" || prop.key.name === "listTasks")
          );
          
          if (hasServiceMethods) {
            context.report({
              node,
              messageId: "noCentralizedFactories",
            });
          }
        }
      },

      // Similar check for mockGitService, mockTaskService patterns
      "VariableDeclarator[id.name=/mock.*(Service|Provider)$/]"(node) {
        if (
          node.init &&
          node.init.type === "ObjectExpression" &&
          node.init.properties.length > 3
        ) {
          context.report({
            node,
            messageId: "noCentralizedFactories",
          });
        }
      },
    };
  },
}; 
