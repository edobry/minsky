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
import { FileWriteSchema } from "@minsky/domain/schemas/file-schemas";
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
    // The module-level mock accumulates calls across tests (setupTestMocks
    // resets registries, not createMock call history) — find this test's
    // registration by name rather than assuming position (mt#2778).
    const matchingCall = addToolMock.mock.calls.find(
      (c: unknown[]) => (c?.[0] as ToolDefinition)?.name === "test-command"
    );
    expect(matchingCall).toBeDefined();
    const toolDefinition = matchingCall?.[0] as ToolDefinition;
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

  // ---------------------------------------------------------------------------
  // Undeclared-param rejection at the MCP dispatch boundary (mt#2778)
  //
  // The CallTool dispatch passes arguments to handlers without runtime schema
  // validation; before mt#2778, an undeclared key (e.g. `taskId` where the
  // command declares `task`) was silently dropped by the bridge, producing
  // undefined-downstream behavior (the mt#2737 incident class). These tests
  // drive the WRAPPED handler captured from addCommand — the same path the
  // server dispatch invokes.
  // ---------------------------------------------------------------------------
  describe("undeclared-param rejection (mt#2778)", () => {
    /** Register a command and return the wrapped ToolDefinition captured by the mock server. */
    function registerAndCapture(
      command: Parameters<CommandMapper["addCommand"]>[0]
    ): ToolDefinition {
      const addToolMock = (mockServer as any).addTool;
      const callsBefore = addToolMock.mock.calls.length;
      commandMapper.addCommand(command);
      const call = addToolMock.mock.calls[callsBefore];
      expect(call).toBeDefined();
      return call?.[0] as ToolDefinition;
    }

    /** Register an eager command and return its wrapped handler, narrowed for direct calls. */
    function captureEagerHandler(
      command: Parameters<CommandMapper["addCommand"]>[0]
    ): NonNullable<ToolDefinition["handler"]> {
      const tool = registerAndCapture(command);
      const handler = tool.handler;
      if (!handler) throw new Error("expected an eager handler on the captured tool");
      return handler;
    }

    const ENV_KEY = "MINSKY_MCP_ALLOW_UNKNOWN_PARAMS";

    test("rejects an undeclared key, naming it and listing known parameters (AT1)", async () => {
      const handler = captureEagerHandler({
        name: "test.reject",
        description: "rejects unknown keys",
        parameters: z.object({ taskId: z.string() }),
        handler: async () => "ok",
      });

      await expect(handler({ taskId: "mt#1", bogus: 1 })).rejects.toThrow(
        /Unknown parameter "bogus" for "test.reject". Known parameters: taskId/
      );
    });

    test("declared canonical+alias params both pass (post-mt#2737 alias pattern)", async () => {
      const handler = captureEagerHandler({
        name: "test.alias",
        description: "canonical + alias declared",
        parameters: z.object({
          taskId: z.string().optional(),
          task: z.string().optional(),
        }),
        handler: async (args) => ({ got: args }),
      });

      const result = await handler({ task: "mt#2" });
      expect(result).toEqual({ got: { task: "mt#2" } });
    });

    test("allowlisted cross-cutting keys debug and json are accepted when undeclared (AT3)", async () => {
      const handler = captureEagerHandler({
        name: "test.allowlist",
        description: "debug/json allowlisted",
        parameters: z.object({ name: z.string() }),
        handler: async () => "ok",
      });

      await expect(handler({ name: "x", debug: true, json: true })).resolves.toBe("ok");
    });

    test("escape hatch MINSKY_MCP_ALLOW_UNKNOWN_PARAMS=1 downgrades rejection to a warning (AT2)", async () => {
      const handler = captureEagerHandler({
        name: "test.escape",
        description: "escape hatch",
        parameters: z.object({ name: z.string() }),
        handler: async () => "ok",
      });

      const prior = process.env[ENV_KEY];
      process.env[ENV_KEY] = "1";
      try {
        await expect(handler({ name: "x", bogus: true })).resolves.toBe("ok");
      } finally {
        if (prior === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = prior;
      }
    });

    test("optional-wrapped object schema still enforces (PR #1911 R1)", async () => {
      const handler = captureEagerHandler({
        name: "test.wrapped.optional",
        description: "optional-wrapped object schema",
        parameters: z.object({ id: z.string() }).optional() as unknown as z.ZodType,
        handler: async () => "ok",
      });

      await expect(handler({ id: "a", nope: 1 })).rejects.toThrow(
        /Unknown parameter "nope" for "test.wrapped.optional". Known parameters: id/
      );
      await expect(handler({ id: "a" })).resolves.toBe("ok");
    });

    test("default-wrapped object schema still enforces (PR #1911 R1)", async () => {
      const handler = captureEagerHandler({
        name: "test.wrapped.default",
        description: "default-wrapped object schema",
        parameters: z.object({ id: z.string() }).default({ id: "d" }) as unknown as z.ZodType,
        handler: async () => "ok",
      });

      await expect(handler({ id: "a", nope: 1 })).rejects.toThrow(
        /Unknown parameter "nope" for "test.wrapped.default"/
      );
    });

    test("preprocess-wrapped object schema still enforces (PR #1911 R1)", async () => {
      const handler = captureEagerHandler({
        name: "test.wrapped.preprocess",
        description: "preprocess-wrapped object schema",
        parameters: z.preprocess((v) => v, z.object({ id: z.string() })) as unknown as z.ZodType,
        handler: async () => "ok",
      });

      await expect(handler({ id: "a", nope: 1 })).rejects.toThrow(
        /Unknown parameter "nope" for "test.wrapped.preprocess"/
      );
    });

    test("transform-piped object schema still enforces (PR #1911 R1)", async () => {
      const handler = captureEagerHandler({
        name: "test.wrapped.transform",
        description: "transform-piped object schema",
        parameters: z.object({ id: z.string() }).transform((v) => v) as unknown as z.ZodType,
        handler: async () => "ok",
      });

      await expect(handler({ id: "a", nope: 1 })).rejects.toThrow(
        /Unknown parameter "nope" for "test.wrapped.transform"/
      );
    });

    test("non-object Zod schema (no derivable shape) is skipped with a registration warning", async () => {
      const handler = captureEagerHandler({
        name: "test.nonobject",
        description: "non-object zod schema",
        // No object shape anywhere — enforcement must disable (fail-open),
        // with the mcp.param_enforcement_disabled warn emitted at registration.
        parameters: z.string() as unknown as z.ZodType,
        handler: async () => "ok",
      });

      await expect(handler({ anything: "goes" })).resolves.toBe("ok");
    });

    test("plain-object (non-Zod) legacy schemas are skipped, not broken (AT4, mt#1200)", async () => {
      const handler = captureEagerHandler({
        name: "test.plain",
        description: "plain-object schema",
        // Legacy plain-object schema: no safeParse — the check must skip it.
        parameters: { type: "object", properties: {} } as unknown as z.ZodType,
        handler: async () => "ok",
      });

      await expect(handler({ anything: "goes" })).resolves.toBe("ok");
    });

    test("enforcement applies on the lazy getHandler path too (mt#1792 parity)", async () => {
      const tool = registerAndCapture({
        name: "test.lazy",
        description: "lazy handler",
        parameters: z.object({ id: z.string() }),
        getHandler: async () => async () => "lazy-ok",
      });

      // Lazy tools expose getHandler; resolve it the way server dispatch does.
      expect(tool.handler).toBeUndefined();
      const getHandler = tool.getHandler;
      if (!getHandler) throw new Error("expected getHandler on the lazy tool");
      const resolved = await getHandler();
      await expect(resolved({ id: "a" })).resolves.toBe("lazy-ok");
      await expect(resolved({ id: "a", nope: 1 })).rejects.toThrow(
        /Unknown parameter "nope" for "test.lazy"/
      );
    });

    test("bridge-generated schema (convertParametersToZodSchema) enforces the same way", async () => {
      // Bind the mapper-level check to the real bridge conversion: a shared
      // command's CommandParameterMap converted by the bridge yields a schema
      // whose shape drives the same rejection.
      const zodSchema = convertParametersToZodSchema(sessionStartCommandParams);
      const handler = captureEagerHandler({
        name: "test.bridge",
        description: "bridge-converted schema",
        parameters: zodSchema,
        handler: async () => "ok",
      });

      await expect(handler({ task: "mt#1", totallyBogus: 1 })).rejects.toThrow(
        /Unknown parameter "totallyBogus" for "test.bridge"/
      );
      await expect(handler({ task: "mt#1" })).resolves.toBe("ok");
    });
  });
});
