/**
 * Command Mapper Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { CommandMapper } from "./command-mapper";
import { z } from "zod";
import type { ProjectContext } from "../types/project";
import type { MinskyMCPServer, ToolDefinition } from "./server";
import { createMock, setupTestMocks } from "../utils/test-utils/mocking";
import { FileWriteSchema } from "../domain/schemas/file-schemas";
import { sessionCommitCommandParams } from "../adapters/shared/commands/session-parameters";
import { sessionStartCommandParams } from "../adapters/shared/commands/session/session-parameters";
import { convertParametersToZodSchema } from "../adapters/mcp/shared-command-integration";

// Mock MinskyMCPServer - using 'as any' for cleaner mock object creation
const mockServer = {
  addTool: createMock(),
  getProjectContext: createMock(() => ({
    repositoryPath: "/test/repo",
    gitBranch: "main",
  })),
  start: createMock(),
  getServer: createMock(),
} as any as MinskyMCPServer;

describe("CommandMapper", () => {
  let commandMapper: CommandMapper;
  let mockProjectContext: ProjectContext;

  beforeEach(() => {
    setupTestMocks();

    mockProjectContext = {
      repositoryPath: "/test/repo",
      gitBranch: "main",
    } as ProjectContext;

    commandMapper = new CommandMapper(mockServer, mockProjectContext);
  });

  test("should initialize with server and project context", () => {
    expect(commandMapper).toBeDefined();
  });

  test("should add tool to server when addCommand is called", () => {
    const command = {
      name: "test-command",
      description: "Test command description",
      parameters: z.object({ test: z.string() }),
      handler: async () => "test result",
    };

    commandMapper.addCommand(command);

    const addToolMock = (mockServer as any).addTool;
    expect(addToolMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const firstCall = addToolMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const toolDefinition = firstCall?.[0] as ToolDefinition;
    expect(toolDefinition).toBeDefined();
    expect(toolDefinition?.name).toBe("test-command");
    expect(toolDefinition?.description).toBe("Test command description");
    expect(toolDefinition?.inputSchema).toBeDefined();
    expect(typeof toolDefinition?.handler).toBe("function");
  });

  describe("Schema Conversion", () => {
    test("should convert simple object schema to flat JSON schema without $ref", () => {
      const zodSchema = z.object({
        name: z.string(),
        age: z.number().optional(),
      });

      const jsonSchema = commandMapper.zodToJsonSchema(zodSchema) as any;

      // Should be a flat object schema, not wrapped in $ref
      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toBeDefined();
      expect(jsonSchema.properties?.name).toEqual({ type: "string" });
      expect(jsonSchema.properties?.age).toEqual({ type: "number" });
      expect(jsonSchema.additionalProperties).toBe(false);
    });

    test("should handle empty object schema", () => {
      const zodSchema = z.object({});

      const jsonSchema = commandMapper.zodToJsonSchema(zodSchema);

      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toEqual({});
      expect(jsonSchema.additionalProperties).toBe(false);
    });

    test("should handle complex nested schemas", () => {
      const zodSchema = z.object({
        user: z.object({
          name: z.string(),
          email: z.string().email(),
        }),
        tags: z.array(z.string()),
        metadata: z.record(z.string(), z.string()),
      });

      const jsonSchema = commandMapper.zodToJsonSchema(zodSchema) as any;

      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toBeDefined();
      expect(jsonSchema.properties?.user).toBeDefined();
      expect(jsonSchema.properties?.tags).toBeDefined();
      expect(jsonSchema.properties?.metadata).toBeDefined();
    });

    test("should handle schema with validation rules", () => {
      const zodSchema = z.object({
        name: z.string().min(1).max(100),
        count: z.number().int().min(0),
        email: z.string().email(),
      });

      const jsonSchema = commandMapper.zodToJsonSchema(zodSchema) as any;

      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties?.name).toBeDefined();
      expect(jsonSchema.properties?.count).toBeDefined();
      expect(jsonSchema.properties?.email).toBeDefined();
    });

    test("should ensure schema is MCP-compatible", () => {
      const zodSchema = z.object({
        required: z.string(),
        optional: z.string().optional(),
      });

      const jsonSchema = commandMapper.zodToJsonSchema(zodSchema);

      // MCP expects these properties for valid tool schemas
      expect(jsonSchema).toHaveProperty("type");
      expect(jsonSchema).toHaveProperty("properties");
      expect(jsonSchema).toHaveProperty("additionalProperties");

      // MCP validation expects direct schema, not wrapped in $ref
      expect(typeof jsonSchema.type).toBe("string");
      expect(jsonSchema.type).toBe("object");
    });

    test("should produce schema that passes MCP server validation", () => {
      // This schema pattern was causing "Invalid literal value, expected 'object'" errors
      const zodSchema = z.object({
        path: z.string().describe("File path to analyze"),
        options: z
          .object({
            verbose: z.boolean().optional(),
          })
          .optional(),
      });

      const jsonSchema = commandMapper.zodToJsonSchema(zodSchema);

      // Verify the structure MCP server expects
      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.additionalProperties).toBe(false);
      expect(jsonSchema.required).toEqual(["path"]);
      const props = jsonSchema.properties as Record<string, Record<string, unknown>>;
      expect(props.path).toEqual({
        type: "string",
        description: "File path to analyze",
      });
      expect(props.options).toEqual({
        type: "object",
        properties: {
          verbose: {
            type: "boolean",
          },
        },
        additionalProperties: false,
      });
    });

    describe("default() field handling", () => {
      test("mixed schema: required field stays required, defaulted and optional fields omitted from required", () => {
        const zodSchema = z.object({
          a: z.string(),
          b: z.boolean().default(false),
          c: z.string().optional(),
        });

        const jsonSchema = commandMapper.zodToJsonSchema(zodSchema) as any;

        expect(jsonSchema.required).toEqual(["a"]);
      });

      test("regression: purely required schema preserves all fields in required", () => {
        const zodSchema = z.object({
          a: z.string(),
          b: z.number(),
        });

        const jsonSchema = commandMapper.zodToJsonSchema(zodSchema) as any;

        expect(jsonSchema.required).toEqual(["a", "b"]);
      });

      test("regression: purely optional/defaulted schema emits no required key", () => {
        const zodSchema = z.object({
          a: z.string().optional(),
          b: z.boolean().default(true),
        });

        const jsonSchema = commandMapper.zodToJsonSchema(zodSchema) as any;

        // required should be absent or empty
        const required = jsonSchema.required as string[] | undefined;
        expect(required == null || required.length === 0).toBe(true);
      });
    });

    describe("real tool schemas (spec acceptance tests)", () => {
      test("session.write_file: createDirs is not in required (it has a default)", () => {
        // FileWriteSchema is the real Zod schema used by session.write_file in
        // session-workspace.ts. createDirs has .default(true) so agents should
        // never have to pass it explicitly.
        const jsonSchema = commandMapper.zodToJsonSchema(FileWriteSchema) as any;

        const required: string[] = jsonSchema.required ?? [];
        expect(required).not.toContain("createDirs");
        // sessionId and path ARE required (no default, not optional)
        expect(required).toContain("sessionId");
        expect(required).toContain("path");
      });

      test("session.commit: optional/defaulted flags are not in required; message is required", () => {
        // sessionCommitCommandParams is the real CommandParameterMap registered for
        // session.commit. convertParametersToZodSchema is the actual transformation
        // from shared-command-integration.ts used by the MCP bridge.
        const zodSchema = convertParametersToZodSchema(sessionCommitCommandParams);
        const jsonSchema = commandMapper.zodToJsonSchema(zodSchema) as any;

        const required: string[] = jsonSchema.required ?? [];

        // Boolean flags with defaultValue: false must NOT appear in required
        expect(required).not.toContain("all");
        expect(required).not.toContain("amend");
        expect(required).not.toContain("noStage");
        expect(required).not.toContain("oneline");
        expect(required).not.toContain("noFiles");

        // message IS the only required field (required: true, no default)
        expect(required).toContain("message");
      });

      test("session.start: all defaulted boolean flags are not in required", () => {
        // sessionStartCommandParams is the real CommandParameterMap registered for
        // session.start. All parameters are optional or carry defaults, so
        // required should be absent or empty — agents are never forced to pass flags.
        const zodSchema = convertParametersToZodSchema(sessionStartCommandParams);
        const jsonSchema = commandMapper.zodToJsonSchema(zodSchema) as any;

        const required: string[] = jsonSchema.required ?? [];

        // Defaulted booleans declared in sessionStartCommandParams
        expect(required).not.toContain("quiet");
        expect(required).not.toContain("noStatusUpdate");
        expect(required).not.toContain("skipInstall");
        expect(required).not.toContain("recover");
      });
    });
  });
});
