/**
 * AST Codemod: Session Edit Tools CommandMapper Signature Fixer
 *
 * SYSTEMATIC AST CODEMOD - Session Edit Tools Mock Infrastructure
 *
 * Problem: Session Edit Tools tests have mock setup with wrong CommandMapper.addCommand signature
 * - Mock expects: (name, description, schema, handler) - old signature
 * - Actual method expects: ({name, description, parameters, handler}) - object parameter
 *
 * This codemod:
 * 1. Updates mock implementation to match actual CommandMapper.addCommand signature
 * 2. Fixes mock data extraction to use object properties correctly
 * 3. Ensures mock captures the correct parameters for test verification
 *
 * Target Files:
 * - tests/adapters/mcp/session-edit-tools.test.ts
 *
 * Expected Impact: +7 passing tests (Session Edit Tools test failures)
 */

import { CodemodBase } from "../src/utils/test-utils/codemods/codemod-framework";
import type { CallExpression, ArrowFunctionExpression, FunctionExpression } from "@babel/types";

export class SessionEditToolsCommandMapperSignatureFixer extends CodemodBase {
  protected transformCallExpression(path: any): void {
    const node = path.node as CallExpression;

    // Target: commandMapper.addCommand.mockImplementation(...)
    if (
      node.callee?.type === "MemberExpression" &&
      node.callee.object?.type === "MemberExpression" &&
      node.callee.object.property?.type === "Identifier" &&
      node.callee.object.property.name === "addCommand" &&
      node.callee.property?.type === "Identifier" &&
      node.callee.property.name === "mockImplementation"
    ) {
      const mockFunction = node.arguments[0];

      if (
        mockFunction &&
        (mockFunction.type === "ArrowFunctionExpression" ||
          mockFunction.type === "FunctionExpression")
      ) {
        // Check if it has the old signature: (name, description, schema, handler)
        const params = mockFunction.params;
        if (params.length === 4 && params.every((param: any) => param.type === "Identifier")) {
          this.addTransformation(path, () => {
            // Update to new signature: (command: {name, description, parameters, handler})
            const newMockFunction = {
              ...mockFunction,
              params: [
                {
                  type: "Identifier",
                  name: "command",
                },
              ],
              body: {
                type: "BlockStatement",
                body: [
                  {
                    type: "ExpressionStatement",
                    expression: {
                      type: "AssignmentExpression",
                      operator: "=",
                      left: {
                        type: "MemberExpression",
                        object: {
                          type: "Identifier",
                          name: "registeredTools",
                        },
                        property: {
                          type: "MemberExpression",
                          object: {
                            type: "Identifier",
                            name: "command",
                          },
                          property: {
                            type: "Identifier",
                            name: "name",
                          },
                          computed: false,
                        },
                        computed: true,
                      },
                      right: {
                        type: "ObjectExpression",
                        properties: [
                          {
                            type: "ObjectProperty",
                            key: {
                              type: "Identifier",
                              name: "name",
                            },
                            value: {
                              type: "MemberExpression",
                              object: {
                                type: "Identifier",
                                name: "command",
                              },
                              property: {
                                type: "Identifier",
                                name: "name",
                              },
                              computed: false,
                            },
                          },
                          {
                            type: "ObjectProperty",
                            key: {
                              type: "Identifier",
                              name: "description",
                            },
                            value: {
                              type: "MemberExpression",
                              object: {
                                type: "Identifier",
                                name: "command",
                              },
                              property: {
                                type: "Identifier",
                                name: "description",
                              },
                              computed: false,
                            },
                          },
                          {
                            type: "ObjectProperty",
                            key: {
                              type: "Identifier",
                              name: "schema",
                            },
                            value: {
                              type: "MemberExpression",
                              object: {
                                type: "Identifier",
                                name: "command",
                              },
                              property: {
                                type: "Identifier",
                                name: "parameters",
                              },
                              computed: false,
                            },
                          },
                          {
                            type: "ObjectProperty",
                            key: {
                              type: "Identifier",
                              name: "handler",
                            },
                            value: {
                              type: "MemberExpression",
                              object: {
                                type: "Identifier",
                                name: "command",
                              },
                              property: {
                                type: "Identifier",
                                name: "handler",
                              },
                              computed: false,
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            };

            return {
              ...node,
              arguments: [newMockFunction],
            };
          });
        }
      }
    }
  }

  protected getTargetFiles(): string[] {
    return ["tests/adapters/mcp/session-edit-tools.test.ts"];
  }

  protected getExpectedChanges(): string {
    return "Fixed CommandMapper.addCommand mock signature to match actual object-based API, enabling Session Edit Tools tests to properly register and verify tool functionality (+7 passing tests expected)";
  }
}

// Export for use in test automation
export const sessionEditToolsCommandMapperSignatureFixer =
  new SessionEditToolsCommandMapperSignatureFixer();
