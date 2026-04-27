/**
 * Regression tests for the MCP shared-command bridge.
 *
 * Covers mt#1174: MCP handlers must pass structured data back to callers.
 * Commands built for both CLI and MCP gate their output on `params.json` /
 * `ctx.format` — if either is missing, formatResult() collapses structured
 * results into a human-readable message string. The bridge must force JSON
 * mode so MCP clients never receive a bare confirmation string in place of
 * the payload they asked for.
 */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { z } from "zod";
import { registerSharedCommandsWithMcp } from "./shared-command-integration";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
} from "../shared/command-registry";
import { log } from "../../utils/logger";

type CapturedCall = {
  params: Record<string, unknown>;
  context: CommandExecutionContext;
};

function makeMockMapper(nameFilter: string) {
  const captured: { handler?: (args: Record<string, unknown>) => Promise<unknown> } = {};
  const mapper = {
    addCommand: (cmd: {
      name: string;
      handler: (args: Record<string, unknown>) => Promise<unknown>;
    }) => {
      if (cmd.name === nameFilter) {
        captured.handler = cmd.handler;
      }
    },
  };
  return { mapper, captured };
}

// Track every test-registered command ID so we can tear down after each test
// and avoid polluting the global shared command registry.
const registeredIds = new Set<string>();

function registerTestCommand<T extends Parameters<typeof sharedCommandRegistry.registerCommand>[0]>(
  def: T
): void {
  sharedCommandRegistry.registerCommand(def, { allowOverwrite: true });
  registeredIds.add(def.id);
}

afterEach(() => {
  for (const id of registeredIds) {
    sharedCommandRegistry.unregisterCommand(id);
  }
  registeredIds.clear();
});

describe("MCP shared-command bridge", () => {
  test("forces params.json=true when the command declares a boolean json parameter", async () => {
    const id = "tasks.__mcp_bridge_json_test__";
    const calls: CapturedCall[] = [];

    registerTestCommand({
      id,
      name: id,
      category: CommandCategory.TASKS,
      description: "bridge test",
      requiresSetup: false,
      parameters: {
        json: {
          schema: z.boolean(),
          description: "JSON output",
          required: false,
          defaultValue: false,
        },
      },
      execute: async (params, context) => {
        calls.push({ params: params as Record<string, unknown>, context });
        return { success: true };
      },
    });

    const { mapper, captured } = makeMockMapper(id);
    registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
    const handler = captured.handler;
    expect(handler).toBeDefined();
    if (!handler) return;

    await handler({});

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toBeDefined();
    expect(call?.params.json).toBe(true);
  });

  test("forces params.json=true when the json schema is wrapped in z.optional()", async () => {
    // migrate-backend-command.ts ships a json parameter declared as
    // `z.boolean().optional().default(false)`. The bridge must recognize
    // wrapped boolean schemas or the override silently skips those commands.
    const id = "tasks.__mcp_bridge_json_optional__";
    const calls: CapturedCall[] = [];

    registerTestCommand({
      id,
      name: id,
      category: CommandCategory.TASKS,
      description: "bridge test: optional boolean",
      requiresSetup: false,
      parameters: {
        json: {
          schema: z.boolean().optional(),
          description: "JSON output",
          required: false,
        },
      },
      execute: async (params, context) => {
        calls.push({ params: params as Record<string, unknown>, context });
        return { success: true };
      },
    });

    const { mapper, captured } = makeMockMapper(id);
    registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
    const handler = captured.handler;
    expect(handler).toBeDefined();
    if (!handler) return;

    await handler({});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.json).toBe(true);
  });

  test("forces params.json=true when the json schema is wrapped in z.default()", async () => {
    const id = "tasks.__mcp_bridge_json_default__";
    const calls: CapturedCall[] = [];

    registerTestCommand({
      id,
      name: id,
      category: CommandCategory.TASKS,
      description: "bridge test: default boolean",
      requiresSetup: false,
      parameters: {
        json: {
          schema: z.boolean().optional().default(false),
          description: "JSON output",
          required: false,
        },
      },
      execute: async (params, context) => {
        calls.push({ params: params as Record<string, unknown>, context });
        return { success: true };
      },
    });

    const { mapper, captured } = makeMockMapper(id);
    registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
    const handler = captured.handler;
    expect(handler).toBeDefined();
    if (!handler) return;

    await handler({});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.json).toBe(true);
  });

  test("sets ctx.format=json and ctx.interface=mcp for every command", async () => {
    const id = "tasks.__mcp_bridge_ctx_test__";
    const calls: CapturedCall[] = [];

    registerTestCommand({
      id,
      name: id,
      category: CommandCategory.TASKS,
      description: "bridge test",
      requiresSetup: false,
      parameters: {},
      execute: async (params, context) => {
        calls.push({ params: params as Record<string, unknown>, context });
        return { success: true };
      },
    });

    const { mapper, captured } = makeMockMapper(id);
    registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
    const handler = captured.handler;
    expect(handler).toBeDefined();
    if (!handler) return;

    await handler({});

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toBeDefined();
    expect(call?.context.interface).toBe("mcp");
    expect(call?.context.format).toBe("json");
  });

  test("does not add json to parameters if command does not declare one", async () => {
    const id = "tasks.__mcp_bridge_no_json_param__";
    const calls: CapturedCall[] = [];

    registerTestCommand({
      id,
      name: id,
      category: CommandCategory.TASKS,
      description: "bridge test",
      requiresSetup: false,
      parameters: {
        taskId: {
          schema: z.string(),
          description: "Task ID",
          required: true,
        },
      },
      execute: async (params, context) => {
        calls.push({ params: params as Record<string, unknown>, context });
        return { success: true };
      },
    });

    const { mapper, captured } = makeMockMapper(id);
    registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
    const handler = captured.handler;
    expect(handler).toBeDefined();
    if (!handler) return;

    await handler({ taskId: "mt#1" });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toBeDefined();
    if (!call) return;
    expect("json" in call.params).toBe(false);
  });

  test("does not override json parameter when its schema is not boolean-compatible", async () => {
    // Reviewer concern on PR #732: a command that happens to name a
    // non-formatting parameter `json` (e.g., a JSON payload string) should
    // not have its value silently overridden by the bridge.
    const id = "tasks.__mcp_bridge_non_boolean_json__";
    const calls: CapturedCall[] = [];

    registerTestCommand({
      id,
      name: id,
      category: CommandCategory.TASKS,
      description: "bridge test with non-boolean json param",
      requiresSetup: false,
      parameters: {
        json: {
          schema: z.string(),
          description: "Raw JSON payload",
          required: false,
        },
      },
      execute: async (params, context) => {
        calls.push({ params: params as Record<string, unknown>, context });
        return { success: true };
      },
    });

    const { mapper, captured } = makeMockMapper(id);
    registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
    const handler = captured.handler;
    expect(handler).toBeDefined();
    if (!handler) return;

    await handler({ json: '{"some":"payload"}' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toBeDefined();
    expect(call?.params.json).toBe('{"some":"payload"}');
  });

  test("returns structured data to MCP clients, not a bare message string", async () => {
    // Models what a CLI/MCP shared command does in its execute handler:
    // calls a formatResult-equivalent that collapses to the message string
    // when json mode is off. With the bridge forcing json=true, the handler's
    // return must be the full structured object, not the collapsed string.
    const id = "tasks.__mcp_bridge_return_shape__";
    const structured = {
      task: { id: "mt#1", title: "t", status: "READY" },
      message: "Task mt#1 retrieved",
    };

    registerTestCommand({
      id,
      name: id,
      category: CommandCategory.TASKS,
      description: "bridge test: return-value shape",
      requiresSetup: false,
      parameters: {
        json: {
          schema: z.boolean(),
          description: "JSON output",
          required: false,
          defaultValue: false,
        },
      },
      execute: async (params) => {
        return (params as { json?: boolean }).json === true ? structured : structured.message;
      },
    });

    const { mapper, captured } = makeMockMapper(id);
    registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
    const handler = captured.handler;
    expect(handler).toBeDefined();
    if (!handler) return;

    const result = await handler({});

    // The handler must return the structured object — not the "Task mt#1
    // retrieved" confirmation string that formatResult falls back to when
    // params.json is unset.
    expect(result).toEqual(structured);
    expect(typeof result).toBe("object");
    expect(result).not.toBe(structured.message);
  });

  test("ctx.format=json propagates to commands that gate output on ctx.format alone", async () => {
    // Covers the branch where a command reads ctx.format rather than
    // params.json (pattern used in several tasks list/search commands).
    const id = "tasks.__mcp_bridge_ctx_format_gate__";
    const structuredBody = { count: 3, items: ["a", "b", "c"], message: "3 items" };

    registerTestCommand({
      id,
      name: id,
      category: CommandCategory.TASKS,
      description: "bridge test: ctx.format gating",
      requiresSetup: false,
      parameters: {},
      execute: async (_params, context) => {
        return context.format === "json" ? structuredBody : structuredBody.message;
      },
    });

    const { mapper, captured } = makeMockMapper(id);
    registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
    const handler = captured.handler;
    expect(handler).toBeDefined();
    if (!handler) return;

    const result = await handler({});
    expect(result).toEqual(structuredBody);
  });

  test("does not throw when a TASKS command has a non-Zod plain-object schema", () => {
    // Regression guard for the CI-only failure where schema.optional() threw
    // "TypeError: schema.optional is not a function" because a command was
    // registered with a plain { type: "string" } object instead of a z.string()
    // schema. The functional z.optional(schema) form used in
    // convertParametersToZodSchema is immune to this.
    const id = "tasks.__mcp_bridge_plain_schema__";

    // Bypass registerTestCommand type-checking to inject a plain-object schema,
    // simulating a command registered by legacy code or an external module.
    sharedCommandRegistry.registerCommand(
      {
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "bridge test: plain-object schema regression",
        requiresSetup: false,
        parameters: {
          query: { schema: { type: "string" } as any, description: "query", required: false },
        },
        execute: async () => ({ success: true }),
      },
      { allowOverwrite: true }
    );
    registeredIds.add(id);

    const { mapper } = makeMockMapper(id);

    // Must not throw — previously crashed with TypeError: schema.optional is not a function
    expect(() => {
      registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
    }).not.toThrow();
  });

  // mt#1181 hardening: debug flag string-truthy coercion + sensitive param log redaction
  describe("mt#1181 hardening", () => {
    async function captureContextForDebugArg(
      debugValue: unknown
    ): Promise<CommandExecutionContext | undefined> {
      const id = `tasks.__mcp_bridge_debug_${Math.random().toString(36).slice(2)}__`;
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#1181 debug coercion test",
        requiresSetup: false,
        parameters: {},
        execute: async (params, context) => {
          calls.push({ params: params as Record<string, unknown>, context });
          return { success: true };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return undefined;
      await handler({ debug: debugValue });
      return calls[0]?.context;
    }

    test("debug: 'false' (string) does NOT enable debug (fix: Boolean('false') was true)", async () => {
      const context = await captureContextForDebugArg("false");
      expect(context?.debug).toBe(false);
    });

    test("debug: true (real boolean) enables debug", async () => {
      const context = await captureContextForDebugArg(true);
      expect(context?.debug).toBe(true);
    });

    test("debug: 'true' (literal string) enables debug", async () => {
      const context = await captureContextForDebugArg("true");
      expect(context?.debug).toBe(true);
    });

    test("sensitive keys in args are redacted across all debug logs", async () => {
      const id = "tasks.__mcp_bridge_redact_sensitive__";
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#1181 redaction test",
        requiresSetup: false,
        parameters: {},
        execute: async () => ({ success: true }),
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      const spy = spyOn(log, "debug");
      try {
        await handler({ token: "secret-xyz", apiKey: "key-abc", normal: "visible" });
        const allCallsJson = spy.mock.calls.map((args) => JSON.stringify(args)).join("\n");
        expect(allCallsJson).not.toContain("secret-xyz");
        expect(allCallsJson).not.toContain("key-abc");
        expect(allCallsJson).toContain("visible");
      } finally {
        spy.mockRestore();
      }
    });

    test("non-sensitive values are still logged (regression guard)", async () => {
      const id = "tasks.__mcp_bridge_redact_regression__";
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#1181 redaction regression test",
        requiresSetup: false,
        parameters: {},
        execute: async () => ({ success: true }),
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      const spy = spyOn(log, "debug");
      try {
        await handler({ foo: "bar", count: 42 });
        const allCallsJson = spy.mock.calls.map((args) => JSON.stringify(args)).join("\n");
        expect(allCallsJson).toContain("bar");
        expect(allCallsJson).toContain("42");
      } finally {
        spy.mockRestore();
      }
    });

    // mt#1181 Finding 3: DI container must not appear in debug logs
    test("DI container is not included in debug log context", async () => {
      const id = "tasks.__mcp_bridge_no_container_log__";
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#1181 Finding 3: container omission test",
        requiresSetup: false,
        parameters: {},
        execute: async () => ({ success: true }),
      });

      // Simulate a config with a container (the sentinel value lets us verify
      // the container field does not bleed into the serialised log output).
      const fakeContainer = { _containerSentinel: "SHOULD_NOT_APPEAR_IN_LOGS" };

      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, {
        categories: [CommandCategory.TASKS],
        container: fakeContainer as never,
      });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      const spy = spyOn(log, "debug");
      try {
        await handler({});
        const allCallsJson = spy.mock.calls.map((args) => JSON.stringify(args)).join("\n");
        // The sentinel inside fakeContainer must never appear in logs
        expect(allCallsJson).not.toContain("SHOULD_NOT_APPEAR_IN_LOGS");
        // The "container" key itself must not appear in the logged context
        expect(allCallsJson).not.toContain('"container"');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
