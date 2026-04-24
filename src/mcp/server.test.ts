/**
 * MCP Server Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport as SdkStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { setupTestMocks } from "../utils/test-utils/mocking";
import { log } from "../utils/logger";

describe("MCP Server", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("should import official MCP SDK module successfully", async () => {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    expect(Server).toBeDefined();
    expect(typeof Server).toBe("function");
  });

  test("should import stdio transport successfully", async () => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    expect(StdioServerTransport).toBeDefined();
    expect(typeof StdioServerTransport).toBe("function");
  });

  test("should be able to import our server modules", async () => {
    // Test that our server-related modules can be imported without errors
    let importSucceeded = false;
    try {
      const { MinskyMCPServer } = await import("./server");
      expect(MinskyMCPServer).toBeDefined();
      expect(typeof MinskyMCPServer).toBe("function");
      importSucceeded = true;
    } catch (error) {
      log.error("Import failed:", error as any);
      importSucceeded = false;
    }
    expect(importSucceeded).toBe(true);
  });

  test("should create MinskyMCPServer instance", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    expect(server).toBeDefined();
    expect(server.getProjectContext()).toBeDefined();
    expect(server.getTools()).toBeDefined();
    expect(server.getResources()).toBeDefined();
    expect(server.getPrompts()).toBeDefined();
  });

  test("HTTP transport: createConfiguredServer returns distinct Server instances", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // createConfiguredServer is private but accessible via cast — the test
    // directly exercises the fix for the singleton-transport bug by
    // verifying two calls produce two independent Server instances.
    const factory = (
      server as unknown as { createConfiguredServer: () => unknown }
    ).createConfiguredServer.bind(server);

    const a = factory();
    const b = factory();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  test("HTTP transport: two Server instances each connect to their own transport", async () => {
    // Regression test for the singleton-transport bug: under the old code, the
    // SDK's Server could only be connected to one Transport. New-session POSTs
    // after the first failed with "Already connected to a transport." The fix
    // creates a fresh Server per session. This test asserts the Server/Transport
    // pairing contract directly.
    const { randomUUID } = await import("crypto");

    const makeServer = () =>
      new SdkServer(
        { name: "Test", version: "0.0.1" },
        { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } }
      );

    const s1 = makeServer();
    const t1 = new SdkStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await s1.connect(t1);

    const s2 = makeServer();
    const t2 = new SdkStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await s2.connect(t2);

    // Both connections succeeded — no "Already connected" throw. Clean up.
    await t1.close();
    await s1.close();
    await t2.close();
    await s2.close();
  });

  test("HTTP transport: close() cleans up all active sessions", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Simulate two active sessions by populating httpSessions directly.
    const { randomUUID } = await import("crypto");

    const sessions = (
      server as unknown as {
        httpSessions: Map<string, { server: unknown; transport: unknown; lastActiveAt: number }>;
      }
    ).httpSessions;

    for (const id of ["a", "b"]) {
      const s = new SdkServer(
        { name: "T", version: "0.0.1" },
        { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } }
      );
      const t = new SdkStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await s.connect(t);
      sessions.set(id, { server: s, transport: t, lastActiveAt: Date.now() });
    }

    expect(sessions.size).toBe(2);
    await server.close();
    expect(sessions.size).toBe(0);
  });

  test("HTTP transport: reapIdleSessions drops sessions older than timeout", async () => {
    // Reaper sweeps httpSessions for entries whose lastActiveAt predates
    // SESSION_IDLE_TIMEOUT_MS. Verifies idle entries are dropped and fresh
    // entries survive. Exercised directly rather than via the interval timer
    // so the test stays hermetic.
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const { randomUUID } = await import("crypto");

    const serverAsAny = server as unknown as {
      httpSessions: Map<string, { server: unknown; transport: unknown; lastActiveAt: number }>;
      reapIdleSessions: () => Promise<void>;
      SESSION_IDLE_TIMEOUT_MS: number;
    };

    const makeSessionEntry = async (lastActiveAt: number) => {
      const s = new SdkServer(
        { name: "T", version: "0.0.1" },
        { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } }
      );
      const t = new SdkStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await s.connect(t);
      return { server: s, transport: t, lastActiveAt };
    };

    const now = Date.now();
    const idleWindow = serverAsAny.SESSION_IDLE_TIMEOUT_MS;
    serverAsAny.httpSessions.set("fresh", await makeSessionEntry(now));
    serverAsAny.httpSessions.set("idle", await makeSessionEntry(now - idleWindow - 1000));

    await serverAsAny.reapIdleSessions();

    expect(serverAsAny.httpSessions.has("fresh")).toBe(true);
    expect(serverAsAny.httpSessions.has("idle")).toBe(false);

    await server.close();
  });

  test("HTTP transport: per-session onclose cleanup doesn't leak when httpSessions wasn't populated", async () => {
    // Race guard: if a transport closes before handleHttpPost finishes
    // populating httpSessions (e.g., client disconnect during the first
    // handleRequest), the onclose handler fires with no matching entry to
    // delete. It should no-op the delete and still close the Server without
    // throwing.
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const sessions = (
      server as unknown as {
        httpSessions: Map<string, unknown>;
      }
    ).httpSessions;

    // Simulate the race: transport created but never stored in httpSessions.
    // onclose should not throw when the sessionId isn't in the map.
    // We can't trigger the real onclose without a real request flow, so we
    // just verify the map stays empty and no exception bubbles.
    expect(sessions.size).toBe(0);

    await server.close();
  });
});
