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
import { describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";
import { registerSharedCommandsWithMcp } from "./shared-command-integration";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
} from "../shared/command-registry";

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
    expect(call ? "json" in call.params : true).toBe(false);
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
});
