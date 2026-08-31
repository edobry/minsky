/**
 * Regression suite for mt#4827 — name-keyed gates on the CallTool path must match the
 * RESOLVED `tool.name`, never `request.params.name` (the raw wire name).
 *
 * Lives in its own file rather than in `server.test.ts`, which is already at the
 * 1500-line `max-lines` ceiling.
 */

import { describe, expect, test } from "bun:test";

describe("CallTool name-keyed gates match the RESOLVED name, not the wire name (mt#4827)", () => {
  // The defect: `WAKE_ENRICHMENT_ALLOWLIST` and `ENRICHMENT_ALLOWLIST` hold DOTTED
  // names, and the dispatch handler fed them `request.params.name` — the raw wire
  // name, which is UNDERSCORED for every client because `tools/list` advertises the
  // Claude-Desktop alias by default. So the session-keyed wake leg never fired.
  //
  // These tests assert the WIRING, not the allowlist. `shouldEnrichWake` keeps a
  // dotted-only Set on purpose (that is the chosen idiom — resolve at the call site,
  // never teach every Set two spellings), so a unit test of the predicate alone would
  // pass both before and after the fix and prove nothing.

  function buildToolDef(name: string): {
    name: string;
    description: string;
    inputSchema: object;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  } {
    return {
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      handler: async () => ({ ok: true, name }),
    };
  }

  // Same pattern as the mt#1779 suite's `callToolsListHandler` above: reach the SDK
  // Server's private `_requestHandlers` map so the real dispatch path runs without a
  // transport round-trip.
  async function callToolCallHandler(
    server: import("./server").MinskyMCPServer,
    params: { name: string; arguments?: Record<string, unknown> }
  ): Promise<unknown> {
    const sdkServer = (
      server as unknown as { createConfiguredServer: (k: string) => unknown }
    ).createConfiguredServer("test-session-key") as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    };
    const handler = sdkServer._requestHandlers.get("tools/call");
    if (!handler) throw new Error("SDK did not register tools/call handler");
    return handler({ method: "tools/call", params }, {});
  }

  /** Records every `drainedForTool` the middleware passes down. */
  function recordingWakeService(seen: string[]) {
    return {
      drainBySession: async (_sessionId: string, drainedForTool: string) => {
        seen.push(drainedForTool);
        return [];
      },
      drainByAgent: async (_agentId: string, drainedForTool: string) => {
        seen.push(drainedForTool);
        return [];
      },
    };
  }

  async function buildServer() {
    const { MinskyMCPServer: MMS } = await import("./server");
    return new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
  }

  test("invoking an allowlisted tool via its UNDERSCORED alias reaches wake enrichment under the canonical name", async () => {
    const server = await buildServer();
    const seen: string[] = [];
    server.addTool(buildToolDef("tasks.get"));
    server.setWakeService(
      recordingWakeService(seen) as never,
      {
        resolveParentSessionId: async () => "session-uuid",
      } as never
    );

    await callToolCallHandler(server, {
      name: "tasks_get",
      arguments: { session: "some-session" },
    });

    // The session-keyed leg is gated by `shouldEnrichWake(toolName)`, whose Set holds
    // "tasks.get". On the pre-fix code `toolName` was "tasks_get", the gate returned
    // false, and this array stayed EMPTY — that is the negative control.
    expect(seen).toContain("tasks.get");
    expect(seen).not.toContain("tasks_get");

    await server.close();
  });

  test("invoking the same tool via its DOTTED canonical name still works (no regression)", async () => {
    const server = await buildServer();
    const seen: string[] = [];
    server.addTool(buildToolDef("tasks.get"));
    server.setWakeService(
      recordingWakeService(seen) as never,
      {
        resolveParentSessionId: async () => "session-uuid",
      } as never
    );

    await callToolCallHandler(server, {
      name: "tasks.get",
      arguments: { session: "some-session" },
    });

    expect(seen).toContain("tasks.get");

    await server.close();
  });

  test("widening the match does not widen the allowlist: a non-allowlisted tool still drains nothing", async () => {
    const server = await buildServer();
    const seen: string[] = [];
    server.addTool(buildToolDef("tasks.search"));
    server.setWakeService(
      recordingWakeService(seen) as never,
      {
        resolveParentSessionId: async () => "session-uuid",
      } as never
    );

    await callToolCallHandler(server, {
      name: "tasks_search",
      arguments: { session: "some-session" },
    });

    // Neither spelling is on the allowlist, so the session leg must stay closed.
    expect(seen).toEqual([]);

    await server.close();
  });
});
