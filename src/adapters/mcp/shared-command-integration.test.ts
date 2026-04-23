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
import { describe, test, expect } from "bun:test";
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

describe("MCP shared-command bridge", () => {
  test("forces params.json=true when the command declares a json parameter", async () => {
    const id = "tasks.__mcp_bridge_json_test__";
    const calls: CapturedCall[] = [];

    sharedCommandRegistry.registerCommand(
      {
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
      },
      { allowOverwrite: true }
    );

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

  test("sets ctx.format=json and ctx.interface=mcp for every command", async () => {
    const id = "tasks.__mcp_bridge_ctx_test__";
    const calls: CapturedCall[] = [];

    sharedCommandRegistry.registerCommand(
      {
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
      },
      { allowOverwrite: true }
    );

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

    sharedCommandRegistry.registerCommand(
      {
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
      },
      { allowOverwrite: true }
    );

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
});
