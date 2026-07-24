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
import { log } from "@minsky/shared/logger";

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

  // mt#1012 R2 / mt#1721 regression guards (MEMORY / DETECTORS dual-registration
  // hazard) were retired with mt#2010: `registerAllMainCommandsWithMcp` was
  // deleted (zero production callers), and `start-command.ts`'s discovery loop
  // bridges each `CommandCategory` exactly once. The "category in two places"
  // hazard those tests guarded against is now structurally impossible.

  // mt#1786: argDefaults — MCP-only per-argument defaults from commandOverrides
  describe("argDefaults (mt#1786)", () => {
    test("applies override.argDefaults when the caller omits the key", async () => {
      const id = "tasks.__mcp_bridge_argdefaults_omit__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults test: caller omits limit",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async (params, context) => {
          calls.push({ params: params as Record<string, unknown>, context });
          return { success: true };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, {
        categories: [CommandCategory.TASKS],
        commandOverrides: { [id]: { argDefaults: { limit: 50 } } },
      });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      await handler({});
      expect(calls[0]?.params.limit).toBe(50);
    });

    test("does NOT override an explicit caller value", async () => {
      const id = "tasks.__mcp_bridge_argdefaults_override__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults test: caller wins",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async (params, context) => {
          calls.push({ params: params as Record<string, unknown>, context });
          return { success: true };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, {
        categories: [CommandCategory.TASKS],
        commandOverrides: { [id]: { argDefaults: { limit: 50 } } },
      });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      await handler({ limit: 5 });
      expect(calls[0]?.params.limit).toBe(5);
    });

    test("preserves caller-set falsy values (0, false, '') against argDefaults", async () => {
      // Regression guard: the merge must use `=== undefined` rather than
      // falsy-check so callers can intentionally pass 0 / false / "" without
      // being silently overridden by the default.
      const id = "tasks.__mcp_bridge_argdefaults_falsy__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults test: falsy caller values",
        requiresSetup: false,
        parameters: {
          all: { schema: z.boolean(), description: "all", required: false },
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async (params, context) => {
          calls.push({ params: params as Record<string, unknown>, context });
          return { success: true };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, {
        categories: [CommandCategory.TASKS],
        commandOverrides: {
          [id]: { argDefaults: { all: true, limit: 50 } },
        },
      });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      await handler({ all: false, limit: 0 });
      expect(calls[0]?.params.all).toBe(false);
      expect(calls[0]?.params.limit).toBe(0);
    });

    test("merges argDefaults for multiple keys independently", async () => {
      const id = "tasks.__mcp_bridge_argdefaults_multi__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults test: multi-key",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
          status: { schema: z.string(), description: "status", required: false },
        },
        execute: async (params, context) => {
          calls.push({ params: params as Record<string, unknown>, context });
          return { success: true };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, {
        categories: [CommandCategory.TASKS],
        commandOverrides: {
          [id]: { argDefaults: { limit: 50, status: "TODO" } },
        },
      });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      await handler({ status: "DONE" });
      expect(calls[0]?.params.limit).toBe(50);
      expect(calls[0]?.params.status).toBe("DONE");
    });

    test("throws at registration time when an argDefault value fails its schema (PR R1)", () => {
      // Reviewer concern: argDefaults are merged AFTER the MCP framework's
      // Zod validation, so a misconfigured override (e.g., string for a
      // numeric param) would reach command.execute unvalidated. The fix
      // is registration-time safeParse — misconfiguration fails fast at
      // startup, before any tool call runs.
      const id = "tasks.__mcp_bridge_argdefaults_typecheck__";
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults registration-time validation",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async () => ({ success: true }),
      });
      const { mapper } = makeMockMapper(id);

      expect(() => {
        registerSharedCommandsWithMcp(mapper as never, {
          categories: [CommandCategory.TASKS],
          commandOverrides: {
            [id]: { argDefaults: { limit: "fifty" as unknown as number } },
          },
        });
      }).toThrow(/argDefaults misconfigured.*limit/i);
    });

    test("throws at registration time when an argDefault names an unknown parameter (PR R1)", () => {
      const id = "tasks.__mcp_bridge_argdefaults_unknown_key__";
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults registration-time validation: unknown key",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async () => ({ success: true }),
      });
      const { mapper } = makeMockMapper(id);

      expect(() => {
        registerSharedCommandsWithMcp(mapper as never, {
          categories: [CommandCategory.TASKS],
          commandOverrides: {
            [id]: { argDefaults: { not_a_param: 1 } },
          },
        });
      }).toThrow(/argDefaults misconfigured.*unknown parameter.*not_a_param/i);
    });

    test("does not throw at registration time for valid argDefault values (PR R1)", () => {
      // Regression guard: the validation check must not throw on the
      // happy path, including for parameters with optional/default-wrapped
      // schemas like the ones in real production overrides.
      const id = "tasks.__mcp_bridge_argdefaults_valid__";
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults registration-time validation: happy path",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
          all: { schema: z.boolean(), description: "all", required: false },
          status: { schema: z.string(), description: "status", required: false },
        },
        execute: async () => ({ success: true }),
      });
      const { mapper } = makeMockMapper(id);

      expect(() => {
        registerSharedCommandsWithMcp(mapper as never, {
          categories: [CommandCategory.TASKS],
          commandOverrides: {
            [id]: { argDefaults: { limit: 50, all: false, status: "TODO" } },
          },
        });
      }).not.toThrow();
    });

    test("function-form default returns a value → value is applied (PR R2)", async () => {
      const id = "tasks.__mcp_bridge_argdefaults_fn_value__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults function form: returns value",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async (params, context) => {
          calls.push({ params: params as Record<string, unknown>, context });
          return { success: true };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, {
        categories: [CommandCategory.TASKS],
        commandOverrides: {
          [id]: { argDefaults: { limit: (_args: Record<string, unknown>) => 50 } },
        },
      });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      await handler({});
      expect(calls[0]?.params.limit).toBe(50);
    });

    test("function-form default returns undefined → default is skipped (PR R2)", async () => {
      // The conditional pattern used by tasks.list: when `all: true` is set,
      // the limit default is skipped entirely so the historical full-history
      // view is uncapped (spec criterion #2).
      const id = "tasks.__mcp_bridge_argdefaults_fn_skip__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults function form: returns undefined",
        requiresSetup: false,
        parameters: {
          all: { schema: z.boolean(), description: "all", required: false },
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async (params, context) => {
          calls.push({ params: params as Record<string, unknown>, context });
          return { success: true };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, {
        categories: [CommandCategory.TASKS],
        commandOverrides: {
          [id]: {
            argDefaults: {
              limit: (args: Record<string, unknown>) => (args.all === true ? undefined : 50),
            },
          },
        },
      });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      // Without all: defaults to 50
      await handler({});
      expect(calls[0]?.params.limit).toBe(50);

      // With all: true — default is skipped, limit is NOT injected
      calls.length = 0;
      await handler({ all: true });
      expect(calls[0]?.params.limit).toBeUndefined();
      expect(calls[0]?.params.all).toBe(true);
    });

    test("function-form default is invoked with the caller's args (PR R2)", async () => {
      // Verify the function receives caller args so it can branch on them.
      const id = "tasks.__mcp_bridge_argdefaults_fn_sees_args__";
      let observedArgs: Record<string, unknown> | undefined;
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults function form: receives args",
        requiresSetup: false,
        parameters: {
          mode: { schema: z.string(), description: "mode", required: false },
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async (params, context) => {
          calls.push({ params: params as Record<string, unknown>, context });
          return { success: true };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, {
        categories: [CommandCategory.TASKS],
        commandOverrides: {
          [id]: {
            argDefaults: {
              limit: (args: Record<string, unknown>) => {
                observedArgs = args;
                return args.mode === "small" ? 5 : 50;
              },
            },
          },
        },
      });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      await handler({ mode: "small" });
      expect(calls[0]?.params.limit).toBe(5);
      expect(observedArgs?.mode).toBe("small");
    });

    test("throws at registration when function-form default returns a bad type (PR R2)", () => {
      // Probe-call at registration catches the most common misconfiguration:
      // function returns a wrong-type value on its empty-args branch.
      const id = "tasks.__mcp_bridge_argdefaults_fn_bad_type__";
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults function form: bad return type",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async () => ({ success: true }),
      });
      const { mapper } = makeMockMapper(id);

      expect(() => {
        registerSharedCommandsWithMcp(mapper as never, {
          categories: [CommandCategory.TASKS],
          commandOverrides: {
            [id]: {
              argDefaults: { limit: (_args: Record<string, unknown>) => "fifty" as unknown },
            },
          },
        });
      }).toThrow(/argDefaults misconfigured.*limit/i);
    });

    test("function-form default that returns undefined for both probes registers without error (PR R2)", () => {
      // The function may legitimately decline to provide a default for the
      // probed branches. That's not a misconfiguration — just register and
      // let the runtime see the actual caller args.
      const id = "tasks.__mcp_bridge_argdefaults_fn_undef_probes__";
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults function form: undefined for probes",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async () => ({ success: true }),
      });
      const { mapper } = makeMockMapper(id);

      expect(() => {
        registerSharedCommandsWithMcp(mapper as never, {
          categories: [CommandCategory.TASKS],
          commandOverrides: {
            [id]: { argDefaults: { limit: (_args: Record<string, unknown>) => undefined } },
          },
        });
      }).not.toThrow();
    });

    test("no-op when override has no argDefaults field", async () => {
      const id = "tasks.__mcp_bridge_argdefaults_absent__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "argDefaults test: absent",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async (params, context) => {
          calls.push({ params: params as Record<string, unknown>, context });
          return { success: true };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, {
        categories: [CommandCategory.TASKS],
        commandOverrides: { [id]: { description: "no argDefaults" } },
      });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      await handler({});
      // No default was specified, so limit stays absent (the converter only
      // copies values that are present or have a `defaultValue` on the param).
      expect(calls[0]?.params.limit).toBeUndefined();
    });
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

  // mt#2705: schema-level `.default(...)` is authoritative at the MCP
  // boundary (previously only the sibling `defaultValue` field was ever
  // consulted), and a missing `required: true` param is rejected before
  // execute() runs (closing the mt#3144 required-enforcement gap).
  describe("schema-level defaults + required enforcement (mt#2705)", () => {
    test("materializes a schema-only .default(...) when the caller omits the param (no sibling defaultValue)", async () => {
      const id = "tasks.__mcp_bridge_schema_default_only__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#2705: schema-only default",
        requiresSetup: false,
        parameters: {
          limit: {
            schema: z.number().default(20),
            description: "limit",
            required: false,
            // Deliberately no `defaultValue` field — the schema-level
            // default is the only source of truth exercised here.
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
      expect(calls[0]?.params.limit).toBe(20);
    });

    test("rejects a missing required parameter before execute() runs, naming the field", async () => {
      // Regression test for the mt#3144 memory.create incident: a
      // `required: true` param with no defensive handler guard used to
      // reach execute() as `undefined` and crash on first dereference
      // (checkDerivation's `content.trimStart()` TypeError).
      const id = "tasks.__mcp_bridge_required_missing__";
      let executed = false;
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#2705: required param missing",
        requiresSetup: false,
        parameters: {
          content: {
            schema: z.string(),
            description: "content",
            required: true,
          },
        },
        execute: async (params) => {
          executed = true;
          return { content: (params as { content: string }).content.trimStart() };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      await expect(handler({})).rejects.toThrow(/Required parameter 'content' is missing/);
      expect(executed).toBe(false);
    });

    test("leaves a genuinely optional parameter with no default omitted (unchanged behavior)", async () => {
      const id = "tasks.__mcp_bridge_optional_no_default__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#2705: optional, no default",
        requiresSetup: false,
        parameters: {
          status: {
            schema: z.string().optional(),
            description: "status",
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
      expect(calls[0]?.params.status).toBeUndefined();
    });

    test("required:false with a bare (non-.optional()) schema and no default stays omitted, not rejected", async () => {
      // Guards against a stricter-than-intended regression: some commands
      // declare `required: false` with a raw schema that has no `.optional()`
      // wrapper (e.g. deps-visualization-commands.ts's `status: z.string()`).
      // The `required` FLAG — not raw schema shape — must gate rejection.
      const id = "tasks.__mcp_bridge_optional_bare_schema__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#2705: required:false, bare schema",
        requiresSetup: false,
        parameters: {
          status: {
            schema: z.string(),
            description: "status",
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

      const result = await handler({});
      expect(result).toEqual({ success: true });
      expect(calls[0]?.params.status).toBeUndefined();
    });

    test("required parameter WITH a sibling defaultValue (no schema default) resolves without throwing (PR #2248 R1 lock-in)", async () => {
      // The reviewer treated this path as the correct reference when flagging
      // the CLI-side fall-through (parameter-mapper.test.ts has the failing
      // sibling case) — this test locks the reference behavior in: a resolved
      // sibling defaultValue short-circuits the required check, no throw.
      const id = "tasks.__mcp_bridge_required_with_sibling_default__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#2705: required + sibling defaultValue, no schema default",
        requiresSetup: false,
        parameters: {
          mode: {
            schema: z.string(), // deliberately NO .default(...) — sibling field only
            description: "mode",
            required: true,
            defaultValue: "fallback",
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
      expect(calls[0]?.params.mode).toBe("fallback");
    });

    test("existing paired schema.default() + sibling defaultValue resolves identically (no regression)", async () => {
      const id = "tasks.__mcp_bridge_paired_default__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#2705: paired default, no regression",
        requiresSetup: false,
        parameters: {
          format: {
            schema: z.enum(["yaml", "json"]).default("yaml"),
            description: "format",
            required: false,
            defaultValue: "yaml",
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
      expect(calls[0]?.params.format).toBe("yaml");
    });
  });

  // mt#3155: PROVIDED values are validated against the declared Zod schema.
  // mt#2705 (above) closed the OMITTED-value half (schema defaults + required
  // enforcement); this closes the PROVIDED-value half. The CLI path has always
  // done this — `normalizeCliParameters` runs `paramDef.schema.parse(value)`
  // on every provided value (parameter-mapper.ts) — so before this fix the two
  // boundaries disagreed about what they accept.
  describe("provided-value validation (mt#3155)", () => {
    test("rejects a wrong-typed provided value before execute() runs, naming the field", async () => {
      const id = "tasks.__mcp_bridge_provided_wrong_type__";
      let executed = false;
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#3155: wrong-typed provided value",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
        },
        execute: async () => {
          executed = true;
          return { success: true };
        },
      });
      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      await expect(handler({ limit: "fifty" })).rejects.toThrow(
        /Invalid value for parameter 'limit'/
      );
      // The rejection must happen at the boundary, not inside the handler.
      expect(executed).toBe(false);
    });

    test("passes a correctly-typed provided value through to execute()", async () => {
      const id = "tasks.__mcp_bridge_provided_right_type__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#3155: correctly-typed provided value",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number(), description: "limit", required: false },
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

      await handler({ limit: 50 });
      expect(calls[0]?.params.limit).toBe(50);
    });

    test("escape hatch MINSKY_MCP_ALLOW_INVALID_PARAM_VALUES=1 downgrades rejection to passthrough", async () => {
      // Mirrors the sibling key-set gate's MINSKY_MCP_ALLOW_UNKNOWN_PARAMS
      // (mt#2778). This gate tightens every MCP tool call at once, so an
      // in-band rollback is required: with the hatch set, the wrong-typed
      // value is passed through as-is instead of rejected.
      const ENV_KEY = "MINSKY_MCP_ALLOW_INVALID_PARAM_VALUES";
      const previous = process.env[ENV_KEY];
      process.env[ENV_KEY] = "1";
      try {
        const id = "tasks.__mcp_bridge_provided_escape_hatch__";
        const calls: CapturedCall[] = [];
        registerTestCommand({
          id,
          name: id,
          category: CommandCategory.TASKS,
          description: "mt#3155: escape hatch",
          requiresSetup: false,
          parameters: {
            limit: { schema: z.number(), description: "limit", required: false },
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

        await handler({ limit: "fifty" });
        expect(calls[0]?.params.limit).toBe("fifty");
      } finally {
        if (previous === undefined) {
          delete process.env[ENV_KEY];
        } else {
          process.env[ENV_KEY] = previous;
        }
      }
    });

    test("assigns the parse OUTPUT so schema coercions apply, mirroring the CLI path", async () => {
      // Decided semantics (spec SC2): assign `schema.parse(value)`'s RETURN,
      // not the raw value — matching `normalizeCliParameters`, which does
      // `result[paramName] = paramDef.schema.parse(valueToParse)`. Check-only
      // validation would leave MCP returning the raw value while CLI returns
      // the coerced one, re-creating the divergence this task removes.
      const id = "tasks.__mcp_bridge_provided_coercion__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#3155: coercion output is assigned",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.coerce.number(), description: "limit", required: false },
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

      await handler({ limit: "50" });
      expect(calls[0]?.params.limit).toBe(50);
      expect(typeof calls[0]?.params.limit).toBe("number");
    });

    test("leaves a plain-object (non-Zod) schema unvalidated (legacy tolerance)", async () => {
      // Mirrors convertParametersToZodSchema's existing tolerance for commands
      // registered with a plain { type: "string" } object instead of a Zod
      // schema — such a schema has no .parse(), so validation must be skipped
      // rather than crashing with "schema.parse is not a function".
      const id = "tasks.__mcp_bridge_provided_plain_schema__";
      const calls: CapturedCall[] = [];
      sharedCommandRegistry.registerCommand(
        {
          id,
          name: id,
          category: CommandCategory.TASKS,
          description: "mt#3155: plain-object schema tolerance",
          requiresSetup: false,
          parameters: {
            query: { schema: { type: "string" } as any, description: "query", required: false },
          },
          execute: async (params, context) => {
            calls.push({ params: params as Record<string, unknown>, context });
            return { success: true };
          },
        },
        { allowOverwrite: true }
      );
      registeredIds.add(id);

      const { mapper, captured } = makeMockMapper(id);
      registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.TASKS] });
      const handler = captured.handler;
      expect(handler).toBeDefined();
      if (!handler) return;

      // A value that would fail a z.string() is passed through untouched.
      await handler({ query: 123 });
      expect(calls[0]?.params.query).toBe(123);
    });

    test("does not regress the omitted-value branch: a schema default still materializes", async () => {
      // Explicit no-regression guard for mt#2705's branch: provided-value
      // validation must not run for an OMITTED value (schema.parse(undefined)
      // would reject a non-optional schema and break every default).
      const id = "tasks.__mcp_bridge_provided_omitted_unaffected__";
      const calls: CapturedCall[] = [];
      registerTestCommand({
        id,
        name: id,
        category: CommandCategory.TASKS,
        description: "mt#3155: omitted-value branch unaffected",
        requiresSetup: false,
        parameters: {
          limit: { schema: z.number().default(20), description: "limit", required: false },
          status: { schema: z.string(), description: "status", required: false },
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
      expect(calls[0]?.params.limit).toBe(20);
      expect(calls[0]?.params.status).toBeUndefined();
    });
  });
});
