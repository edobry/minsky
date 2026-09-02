/**
 * mt#3973 AT2 — the server names the tool that is actually running.
 *
 * Kept in its own file rather than appended to `server.test.ts`, which already
 * sits near the 1500-line ceiling.
 *
 * This is the link the whole task exists for. A resident-memory capture that
 * says "this process was at 40 GB" is an observation; one that says "...90
 * seconds into <tool>" is the lead mt#3885 needs. The assertion that matters is
 * that the name is visible WHILE the call is in flight — reading it after the
 * call resolves would be trivially true and useless.
 */

import { describe, expect, test } from "bun:test";
import { getToolsCallHandler } from "./test-support/tools-call-handler";

/** Stands in for an allocation-heavy path of the kind mt#3885 is hunting. */
const SLOW_TOOL = "slow_allocating_tool";

const TOOL_RESPONSE = { content: [{ type: "text" as const, text: "ok" }] };

describe("MinskyMCPServer.getInFlightToolCalls (mt#3973)", () => {
  test("names the running tool while the call is in flight, and clears after", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    let releaseTool: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolveStarted) => {
      server.addTool({
        name: SLOW_TOOL,
        description: "Blocks until released",
        handler: async () => {
          resolveStarted();
          await new Promise<void>((release) => {
            releaseTool = release;
          });
          return TOOL_RESPONSE;
        },
      });
    });

    const sdkServer = (server as unknown as { server: unknown }).server;
    const toolsCallHandler = getToolsCallHandler(sdkServer);
    if (!toolsCallHandler) throw new Error("Expected tools/call handler to be registered");

    expect(server.getInFlightToolCalls()).toEqual([]);

    const callPromise = toolsCallHandler(
      { method: "tools/call", params: { name: SLOW_TOOL, arguments: {} } },
      {}
    );
    await toolStarted;

    const inFlight = server.getInFlightToolCalls();
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]?.toolName).toBe(SLOW_TOOL);
    expect(inFlight[0]?.elapsedMs).toBeGreaterThanOrEqual(0);

    releaseTool?.();
    await callPromise;

    // Clears once the call completes, so a capture taken later cannot accuse a
    // tool that had already finished.
    expect(server.getInFlightToolCalls()).toEqual([]);
    await server.close();
  });
});
