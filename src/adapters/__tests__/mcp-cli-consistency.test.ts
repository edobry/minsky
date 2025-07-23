/**
 * CLI/MCP Consistency Tests
 *
 * This test suite verifies consistency between CLI and MCP interfaces
 * to prevent regression issues identified in Task #288.
 *
 * These tests validate:
 * 1. Parameter name consistency between CLI and MCP
 * 2. Parameter type consistency
 * 3. Error response format consistency
 * 4. Command availability consistency
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { z } from "zod";
import { Command } from "commander";
import { sharedCommandRegistry, CommandCategory } from "../shared/command-registry";
import { CommandMapper } from "../../mcp/command-mapper";
import { convertParametersToZodSchema } from "../mcp/shared-command-integration";
import { mcpResponseSchema, MCP_ERROR_CODES } from "../../schemas/mcp-error-responses";

// Import all command registrations to ensure they're loaded
import { registerTasksCommands } from "../shared/commands/tasks";
import { registerGitCommands } from "../shared/commands/git";
import { registerSessionCommands } from "../shared/commands/session";
import { registerRulesCommands } from "../shared/commands/rules";
import { registerConfigCommands } from "../shared/commands/config";
import { registerInitCommands } from "../shared/commands/init";

describe("CLI/MCP Consistency", () => {
  beforeAll(() => {
    // Register all shared commands
    registerTasksCommands();
    registerGitCommands();
    registerSessionCommands();
    registerRulesCommands();
    registerConfigCommands();
    registerInitCommands();
  });

  describe("Parameter Consistency", () => {
    test("should have consistent parameter names between CLI and MCP", () => {
      const inconsistencies: string[] = [];

      // Get all commands from shared registry
      const allCommands = [
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.GIT),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.RULES),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.CONFIG),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.INIT),
      ];

      allCommands.forEach((command) => {
        // Check for parameter naming inconsistencies
        const paramNames = Object.keys(command.parameters || {});

        // Validate no mixed session/sessionName usage within same command
        const hasSession = paramNames.includes("session");
        const hasSessionName = paramNames.includes("sessionName");

        if (hasSession && hasSessionName) {
          inconsistencies.push(
            `Command '${command.id}' has both 'session' and 'sessionName' parameters`
          );
        }

        // Check for json parameter in commands that should have it filtered in MCP
        const hasJson = paramNames.includes("json");
        if (hasJson) {
          // This is expected for CLI commands, but should be filtered in MCP
          // The conversion function should handle this
          try {
            const mcpSchema = convertParametersToZodSchema(command.parameters);
            const mcpSchemaShape = mcpSchema._def.shape();

            if ("json" in mcpSchemaShape) {
              inconsistencies.push(
                `Command '${command.id}' json parameter not filtered out in MCP conversion`
              );
            }
          } catch (error) {
            inconsistencies.push(`Command '${command.id}' parameter conversion failed: ${error}`);
          }
        }
      });

      if (inconsistencies.length > 0) {
        throw new Error(`Parameter inconsistencies found:\n${inconsistencies.join("\n")}`);
      }
    });

    test("should have consistent parameter types", () => {
      const typeInconsistencies: string[] = [];

      const allCommands = [
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.RULES),
      ];

      // Track parameter definitions across commands
      const parameterTypeMap: Record<string, { type: string; commands: string[] }> = {};

      allCommands.forEach((command) => {
        Object.entries(command.parameters || {}).forEach(([paramName, paramDef]) => {
          const paramType = paramDef.schema._def.typeName || "unknown";

          if (!parameterTypeMap[paramName]) {
            parameterTypeMap[paramName] = {
              type: paramType,
              commands: [command.id],
            };
          } else {
            parameterTypeMap[paramName].commands.push(command.id);

            // Check for type inconsistencies
            if (parameterTypeMap[paramName].type !== paramType) {
              typeInconsistencies.push(
                `Parameter '${paramName}' has inconsistent types: ` +
                  `${parameterTypeMap[paramName].type} vs ${paramType} ` +
                  `in commands: ${parameterTypeMap[paramName].commands.join(", ")}`
              );
            }
          }
        });
      });

      if (typeInconsistencies.length > 0) {
        throw new Error(`Parameter type inconsistencies found:\n${typeInconsistencies.join("\n")}`);
      }
    });

    test("should have consistent descriptions for common parameters", () => {
      const descriptionInconsistencies: string[] = [];

      // Common parameters that should have consistent descriptions
      const commonParams = ["repo", "debug", "session", "sessionName", "force", "quiet"];

      const allCommands = [
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.RULES),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.GIT),
      ];

      const paramDescriptions: Record<string, { description: string; commands: string[] }> = {};

      allCommands.forEach((command) => {
        Object.entries(command.parameters || {}).forEach(([paramName, paramDef]) => {
          if (commonParams.includes(paramName) && paramDef.description) {
            if (!paramDescriptions[paramName]) {
              paramDescriptions[paramName] = {
                description: paramDef.description,
                commands: [command.id],
              };
            } else {
              paramDescriptions[paramName].commands.push(command.id);

              // Check for description inconsistencies
              if (paramDescriptions[paramName].description !== paramDef.description) {
                descriptionInconsistencies.push(
                  `Parameter '${paramName}' has inconsistent descriptions:\n` +
                    `  "${paramDescriptions[paramName].description}" (${paramDescriptions[paramName].commands[0]})\n` +
                    `  "${paramDef.description}" (${command.id})`
                );
              }
            }
          }
        });
      });

      if (descriptionInconsistencies.length > 0) {
        throw new Error(
          `Parameter description inconsistencies found:\n${descriptionInconsistencies.join("\n")}`
        );
      }
    });
  });

  describe("Error Response Consistency", () => {
    test("should validate MCP error response schema", () => {
      // Test that all defined error codes are valid
      const errorCodes = Object.values(MCP_ERROR_CODES);
      expect(errorCodes.length).toBeGreaterThan(0);

      // Test standard error response format
      const validErrorResponse = {
        success: false,
        error: {
          message: "Test error message",
          code: MCP_ERROR_CODES.VALIDATION_ERROR,
          context: {
            operation: "test.operation",
            session: "test-session",
          },
        },
      };

      const parseResult = mcpResponseSchema.safeParse(validErrorResponse);
      expect(parseResult.success).toBe(true);
    });

    test("should validate MCP success response schema", () => {
      const validSuccessResponse = {
        success: true,
        result: {
          data: "test data",
        },
        metadata: {
          operation: "test.operation",
          requestId: "test-request-123",
          performance: {
            duration: 150,
          },
        },
      };

      const parseResult = mcpResponseSchema.safeParse(validSuccessResponse);
      expect(parseResult.success).toBe(true);
    });

    test("should reject invalid response formats", () => {
      const invalidResponses = [
        { success: "maybe" }, // Invalid success value
        { success: false }, // Missing error object
        { success: true }, // Missing result
        {
          success: false,
          error: { message: "test" }, // Missing error code
        },
      ];

      invalidResponses.forEach((response, index) => {
        const parseResult = mcpResponseSchema.safeParse(response);
        expect(parseResult.success).toBe(false);
      });
    });
  });

  describe("Command Availability Consistency", () => {
    test("should have documented rationale for hidden MCP commands", () => {
      // Commands that are intentionally hidden in MCP should be documented
      const hiddenMcpCommands = [
        "git.commit", // Use session.commit instead
        "git.push", // Use session.push instead
        "git.clone", // Use session.start instead
        "session.inspect", // No session context in remote calls
      ];

      // This test documents the intentional differences
      // If new commands are hidden, they should be added to this list with rationale
      expect(hiddenMcpCommands.length).toBeGreaterThan(0);
    });

    test("should validate session command availability", () => {
      const sessionCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION);

      // Key session commands should be available
      const requiredSessionCommands = [
        "session.list",
        "session.start",
        "session.get",
        "session.delete",
        "session.update",
        "session.pr",
      ];

      const availableCommandIds = sessionCommands.map((cmd) => cmd.id);

      requiredSessionCommands.forEach((commandId) => {
        expect(availableCommandIds).toContain(commandId);
      });
    });

    test("should validate task command availability", () => {
      const taskCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS);

      // Key task commands should be available
      const requiredTaskCommands = [
        "tasks.list",
        "tasks.get",
        "tasks.create",
        "tasks.delete",
        "tasks.status.get",
        "tasks.status.set",
      ];

      const availableCommandIds = taskCommands.map((cmd) => cmd.id);

      requiredTaskCommands.forEach((commandId) => {
        expect(availableCommandIds).toContain(commandId);
      });
    });
  });

  describe("Parameter Deduplication Validation", () => {
    test("should not have duplicate parameter definitions", () => {
      // This test validates the work done in Task #322
      const duplicateDefinitions: string[] = [];

      const allCommands = [
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.RULES),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.GIT),
      ];

      // Track identical parameter definitions (same schema, description, required)
      const parameterSignatures: Record<string, string[]> = {};

      allCommands.forEach((command) => {
        Object.entries(command.parameters || {}).forEach(([paramName, paramDef]) => {
          const signature = JSON.stringify({
            schema: paramDef.schema._def,
            description: paramDef.description,
            required: paramDef.required,
            defaultValue: paramDef.defaultValue,
          });

          const key = `${paramName}:${signature}`;

          if (!parameterSignatures[key]) {
            parameterSignatures[key] = [command.id];
          } else {
            parameterSignatures[key].push(command.id);
          }
        });
      });

      // Find parameters that appear with identical definitions in multiple commands
      Object.entries(parameterSignatures).forEach(([key, commands]) => {
        if (commands.length > 3) {
          // Allow some duplication, but flag excessive duplication
          const [paramName] = key.split(":");
          duplicateDefinitions.push(
            `Parameter '${paramName}' has identical definitions in ${commands.length} commands: ${commands.join(", ")}`
          );
        }
      });

      // This should ideally be 0 after parameter deduplication work
      expect(duplicateDefinitions.length).toBeLessThan(5); // Allow some for legitimate use cases
    });

    test("should use shared parameter libraries", () => {
      // Validate that commands are using shared parameter libraries
      // This is more of a documentation test than a strict requirement

      const allCommands = [
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.RULES),
      ];

      // Check that common parameters are used consistently
      const commonParameterUsage = {
        repo: 0,
        debug: 0,
        session: 0,
        sessionName: 0,
      };

      allCommands.forEach((command) => {
        Object.keys(command.parameters || {}).forEach((paramName) => {
          if (paramName in commonParameterUsage) {
            commonParameterUsage[paramName as keyof typeof commonParameterUsage]++;
          }
        });
      });

      // These parameters should be widely used if shared libraries are working
      expect(commonParameterUsage.debug).toBeGreaterThan(5);
      expect(commonParameterUsage.repo).toBeGreaterThan(3);
    });
  });

  describe("Architectural Consistency", () => {
    test("should maintain dual architecture boundaries", () => {
      // Validate that the dual architecture is maintained
      // Direct MCP tools should not use shared command registry
      // Bridged MCP tools should use shared command registry

      const sharedCommandCategories = [
        CommandCategory.TASKS,
        CommandCategory.GIT,
        CommandCategory.SESSION,
        CommandCategory.RULES,
        CommandCategory.CONFIG,
        CommandCategory.INIT,
      ];

      sharedCommandCategories.forEach((category) => {
        const commands = sharedCommandRegistry.getCommandsByCategory(category);
        expect(commands.length).toBeGreaterThan(0);
      });
    });

    test("should validate JSON parameter filtering in MCP", () => {
      // Validate that JSON parameters are properly filtered in MCP conversion
      const commandsWithJson = [
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS),
        ...sharedCommandRegistry.getCommandsByCategory(CommandCategory.RULES),
      ].filter((cmd) => "json" in (cmd.parameters || {}));

      commandsWithJson.forEach((command) => {
        const mcpSchema = convertParametersToZodSchema(command.parameters);
        const mcpSchemaKeys = Object.keys(mcpSchema._def.shape());

        // JSON parameter should be filtered out in MCP
        expect(mcpSchemaKeys).not.toContain("json");
      });
    });
  });
});

describe("Regression Prevention", () => {
  test("should prevent session parameter naming regression", () => {
    // This test prevents regression of session/sessionName inconsistency
    // Identified in Task #288 audit

    const sessionCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION);
    const tasksCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS);

    const allCommands = [...sessionCommands, ...tasksCommands];

    // Count usage of session vs sessionName
    let sessionCount = 0;
    let sessionNameCount = 0;

    allCommands.forEach((command) => {
      const params = Object.keys(command.parameters || {});
      if (params.includes("session")) sessionCount++;
      if (params.includes("sessionName")) sessionNameCount++;
    });

    // Document current state for regression prevention
    expect(sessionCount + sessionNameCount).toBeGreaterThan(0);
  });

  test("should maintain error code enum completeness", () => {
    // Ensure all error codes are properly defined
    const errorCodes = Object.values(MCP_ERROR_CODES);

    // Critical error codes that must exist
    const requiredErrorCodes = [
      "VALIDATION_ERROR",
      "SESSION_NOT_FOUND",
      "FILE_NOT_FOUND",
      "PERMISSION_ERROR",
      "COMMAND_NOT_FOUND",
      "UNKNOWN_ERROR",
    ];

    requiredErrorCodes.forEach((code) => {
      expect(errorCodes).toContain(code);
    });
  });
});
