/**
 * mt#4749 AT2 at the server layer — kept in its own file rather than appended
 * to `server.test.ts`, which already sits near the 1500-line ceiling (same
 * convention as `server-in-flight-tool-calls.test.ts`).
 *
 * `CallToolRequestSchema`'s handler in `server.ts` is the single point BOTH
 * transports funnel through: the stdio-direct `mcp start` process serves
 * requests straight off this handler, and the ADR-038 shared daemon runs the
 * same handler behind an HTTP transport before forwarding its response to
 * `minsky mcp shim` for the final stdio hop (that leg's own, independent
 * backstop is covered separately by `src/mcp/shim/response-bound.test.ts`).
 * Bounding here — via `response-size-guard.ts`'s `boundToolResponseText` —
 * catches an oversized tool result regardless of which transport carries it
 * onward, including the direct-stdio path the shim never sees at all.
 *
 * Filesystem fully injected via instance-field DI (`responseSizeGuardDeps`,
 * same pattern as `emitDispatchEvent` in `server.test.ts`), never touching a
 * real tmpdir (custom/no-real-fs-in-tests).
 */

import { describe, test, expect } from "bun:test";
import { getToolsCallHandler } from "./test-support/tools-call-handler";

const GREET_RESPONSE = "hello from greet2";

/** An in-memory fs fake standing in for the real spool seam. */
function fakeResponseSizeGuardDeps(): {
  deps: {
    mkdirSync: (dir: string) => void;
    writeFileSync: (p: string, c: string) => void;
    stateDir: string;
  };
  filesWritten: Record<string, string>;
} {
  const filesWritten: Record<string, string> = {};
  return {
    filesWritten,
    deps: {
      stateDir: "/fake-state",
      mkdirSync: () => {},
      writeFileSync: (p: string, c: string) => {
        filesWritten[p] = c;
      },
    },
  };
}

describe("tools/call response size cap (mt#4749)", () => {
  test("an oversized tool result is bounded, not forwarded whole", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
    const fake = fakeResponseSizeGuardDeps();
    (server as unknown as { responseSizeGuardDeps: unknown }).responseSizeGuardDeps = fake.deps;

    const hugeText = "x".repeat(3 * 1024 * 1024); // past the 2MB cap
    server.addTool({
      name: "huge_tool",
      description: "Returns an oversized result",
      handler: async () => hugeText,
    });

    const sdkServer = (server as unknown as { server: unknown }).server;
    const toolsCallHandler = getToolsCallHandler(sdkServer);
    if (!toolsCallHandler) throw new Error("Expected tools/call handler to be registered");

    const result = (await toolsCallHandler(
      { method: "tools/call", params: { name: "huge_tool", arguments: {} } },
      {}
    )) as { content: Array<{ type: string; text: string }> };

    const text = result.content[0]?.text ?? "";
    expect(text.length).toBeLessThan(hugeText.length);
    expect(text).toContain("TRUNCATED");
    expect(text).toContain("mt#4749");
    expect(Object.keys(fake.filesWritten)).toHaveLength(1);
    // The full content was spooled, not dropped.
    expect(Object.values(fake.filesWritten)[0]).toBe(hugeText);

    await server.close();
  });

  test("the NEXT tool call on the same server still succeeds", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
    const fake = fakeResponseSizeGuardDeps();
    (server as unknown as { responseSizeGuardDeps: unknown }).responseSizeGuardDeps = fake.deps;

    server.addTool({
      name: "huge_tool",
      description: "Returns an oversized result",
      handler: async () => "y".repeat(3 * 1024 * 1024),
    });
    server.addTool({
      name: "quick",
      description: "Returns a small result",
      handler: async () => "ok",
    });

    const sdkServer = (server as unknown as { server: unknown }).server;
    const toolsCallHandler = getToolsCallHandler(sdkServer);
    if (!toolsCallHandler) throw new Error("Expected tools/call handler to be registered");

    await toolsCallHandler(
      { method: "tools/call", params: { name: "huge_tool", arguments: {} } },
      {}
    );

    const second = (await toolsCallHandler(
      { method: "tools/call", params: { name: "quick", arguments: {} } },
      {}
    )) as { content: Array<{ type: string; text: string }> };

    expect(second.content[0]?.text).toBe("ok");

    await server.close();
  });

  test("an ordinary-sized tool result passes through unchanged", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
    server.addTool({
      name: "greet2",
      description: "Returns a small greeting",
      handler: async () => GREET_RESPONSE,
    });

    const sdkServer = (server as unknown as { server: unknown }).server;
    const toolsCallHandler = getToolsCallHandler(sdkServer);
    if (!toolsCallHandler) throw new Error("Expected tools/call handler to be registered");

    const result = (await toolsCallHandler(
      { method: "tools/call", params: { name: "greet2", arguments: {} } },
      {}
    )) as { content: Array<{ type: string; text: string }> };

    expect(result.content[0]?.text).toBe(GREET_RESPONSE);

    await server.close();
  });
});
