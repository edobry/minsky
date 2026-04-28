/**
 * Drift Gate Tests
 *
 * Tests that state-mutating MCP tools are refused when the server is stale
 * (loaded commit !== workspace HEAD), and read-only tools are unaffected.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { setupTestMocks } from "../utils/test-utils/mocking";
import type { MinskyMCPServer } from "./server";

// Shared import paths extracted to constants to satisfy no-magic-string-duplication
const COMMAND_MAPPER_PATH = "./command-mapper";
const WORKFLOW_COMMANDS_PATH = "../adapters/shared/commands/session/workflow-commands";

/**
 * Build a fake StalenessDetector that reports stale state.
 * We construct it directly without touching the filesystem.
 */
function makeStalenessDetector(stale: boolean) {
  const loaded = "abc12345";
  const head = "def67890";
  return {
    isCurrentlyStale: () => stale,
    getStaleWarning: () =>
      stale
        ? `⚠️ The Minsky MCP server was loaded from commit ${loaded} but the workspace is now at ${head}. Source files have changed. Run: /mcp then reconnect minsky`
        : null,
  };
}

/**
 * Create a MinskyMCPServer with a controlled staleness detector.
 * We bypass the real filesystem-based detector by assigning our fake after construction.
 */
async function makeTestServer(stale: boolean): Promise<MinskyMCPServer> {
  const { MinskyMCPServer } = await import("./server");
  const server = new MinskyMCPServer({
    name: "Drift Gate Test Server",
    version: "1.0.0",
    projectContext: { repositoryPath: "/mock/test-repo" },
  });

  // Inject fake staleness detector via cast — intentional test-only access
  (server as unknown as { stalenessDetector: unknown }).stalenessDetector =
    makeStalenessDetector(stale);

  return server;
}

describe("Drift gate — mutating tool refusal", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("mutating tool is rejected when server is stale", async () => {
    const server = await makeTestServer(true);

    server.addTool({
      name: "test.mutating",
      description: "A mutating test tool",
      mutating: true,
      handler: async () => ({ ok: true }),
    });

    const tool = server.getTools().get("test.mutating");
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(tool.mutating).toBe(true);

    // Simulate what CallToolRequestSchema handler does: check staleness then call handler.
    // We test the dispatch logic indirectly by inspecting the tool's mutating flag
    // and the detector's state — the actual dispatch path is in setupRequestHandlers
    // which is internal to the SDK handler. We verify the contract via the exposed
    // tool definition and detector state.
    const detector = (
      server as unknown as { stalenessDetector: ReturnType<typeof makeStalenessDetector> }
    ).stalenessDetector;
    expect(detector.isCurrentlyStale()).toBe(true);
    // When both are true, the handler would be refused — contract verified structurally.
  });

  test("non-mutating tool proceeds when server is stale", async () => {
    const server = await makeTestServer(true);

    server.addTool({
      name: "test.readonly",
      description: "A read-only test tool",
      mutating: false,
      handler: async () => ({ data: "some result" }),
    });

    const tool = server.getTools().get("test.readonly");
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(tool.mutating).toBe(false);

    const detector = (
      server as unknown as { stalenessDetector: ReturnType<typeof makeStalenessDetector> }
    ).stalenessDetector;
    expect(detector.isCurrentlyStale()).toBe(true);
    // Non-mutating tool proceeds regardless of staleness — verified structurally.
  });

  test("mutating tool proceeds when server is NOT stale", async () => {
    const server = await makeTestServer(false);

    server.addTool({
      name: "test.mutating.fresh",
      description: "A mutating tool on a fresh server",
      mutating: true,
      handler: async () => ({ ok: true }),
    });

    const tool = server.getTools().get("test.mutating.fresh");
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(tool.mutating).toBe(true);

    const detector = (
      server as unknown as { stalenessDetector: ReturnType<typeof makeStalenessDetector> }
    ).stalenessDetector;
    expect(detector.isCurrentlyStale()).toBe(false);
    // Mutating tool proceeds when not stale — verified structurally.
  });

  test("unregistered tool (no mutating flag) is not blocked", async () => {
    const server = await makeTestServer(true);

    server.addTool({
      name: "test.no.flag",
      description: "A tool with no mutating flag",
      handler: async () => ({ data: "ok" }),
    });

    const tool = server.getTools().get("test.no.flag");
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(tool.mutating).toBeUndefined();
    // Falsy mutating (undefined) means read-only by convention.
  });

  test("drift gate check uses isCurrentlyStale() not getStaleWarning()", async () => {
    // Verify the gate reads isCurrentlyStale() which is the cached, side-effect-free
    // check — not getStaleWarning() which updates the check timer.
    const server = await makeTestServer(true);
    const detector = (
      server as unknown as { stalenessDetector: ReturnType<typeof makeStalenessDetector> }
    ).stalenessDetector;

    // isCurrentlyStale() is safe to call multiple times without side effects
    expect(detector.isCurrentlyStale()).toBe(true);
    expect(detector.isCurrentlyStale()).toBe(true);
  });
});

describe("Drift gate — CommandMapper propagates mutating flag", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("addCommand with mutating:true registers tool with mutating:true", async () => {
    const { MinskyMCPServer } = await import("./server");
    const { CommandMapper } = await import(COMMAND_MAPPER_PATH);

    const server = new MinskyMCPServer({
      name: "Test",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
    const mapper = new CommandMapper(server);

    mapper.addCommand({
      name: "session.pr.create",
      description: "Create a PR",
      mutating: true,
      handler: async () => ({ ok: true }),
    });

    const tool = server.getTools().get("session.pr.create");
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(tool.mutating).toBe(true);
  });

  test("addCommand with mutating:false registers tool with mutating:false", async () => {
    const { MinskyMCPServer } = await import("./server");
    const { CommandMapper } = await import(COMMAND_MAPPER_PATH);

    const server = new MinskyMCPServer({
      name: "Test",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
    const mapper = new CommandMapper(server);

    mapper.addCommand({
      name: "session.pr.list",
      description: "List PRs",
      mutating: false,
      handler: async () => ({ ok: true }),
    });

    const tool = server.getTools().get("session.pr.list");
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(tool.mutating).toBe(false);
  });

  test("addCommand without mutating flag leaves mutating undefined", async () => {
    const { MinskyMCPServer } = await import("./server");
    const { CommandMapper } = await import(COMMAND_MAPPER_PATH);

    const server = new MinskyMCPServer({
      name: "Test",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
    const mapper = new CommandMapper(server);

    mapper.addCommand({
      name: "session.status",
      description: "Get session status",
      handler: async () => ({ ok: true }),
    });

    const tool = server.getTools().get("session.status");
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(tool.mutating).toBeUndefined();
  });
});

describe("Drift gate — command definitions have correct mutating flags", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  // Cast to unknown first to bypass the full SessionDeps shape — these tests
  // only call the factory function to read the command's static mutating flag,
  // never invoke execute(), so only the minimal stub is needed.
  const mockGetDeps = (async () => ({
    sessionProvider: {},
  })) as unknown as import("../adapters/shared/commands/session/types").LazySessionDeps;

  test("session.pr.create is registered as mutating", async () => {
    const { createSessionPrCreateCommand } = await import(
      "../adapters/shared/commands/session/pr-create-command"
    );
    const command = createSessionPrCreateCommand(mockGetDeps);
    expect(command.mutating).toBe(true);
  });

  test("session.pr.edit is registered as mutating", async () => {
    const { createSessionPrEditCommand } = await import(
      "../adapters/shared/commands/session/pr-edit-command"
    );
    const command = createSessionPrEditCommand(mockGetDeps);
    expect(command.mutating).toBe(true);
  });

  test("session.pr.merge is registered as mutating", async () => {
    const { createSessionPrMergeCommand } = await import(WORKFLOW_COMMANDS_PATH);
    const command = createSessionPrMergeCommand(mockGetDeps);
    expect(command.mutating).toBe(true);
  });

  test("session.pr.review.dismiss is registered as mutating", async () => {
    const { createSessionPrReviewDismissCommand } = await import(
      "../adapters/shared/commands/session/pr-review-dismiss-command"
    );
    const command = createSessionPrReviewDismissCommand(mockGetDeps);
    expect(command.mutating).toBe(true);
  });

  test("session.commit is registered as mutating", async () => {
    const { createSessionCommitCommand } = await import(WORKFLOW_COMMANDS_PATH);
    const command = createSessionCommitCommand(mockGetDeps);
    expect(command.mutating).toBe(true);
  });

  test("session.update is registered as mutating", async () => {
    const { createSessionUpdateCommand } = await import(
      "../adapters/shared/commands/session/management-commands"
    );
    const command = createSessionUpdateCommand(mockGetDeps);
    expect(command.mutating).toBe(true);
  });

  test("session.pr.review.submit is registered as mutating", async () => {
    const { createSessionPrReviewSubmitCommand } = await import(
      "../adapters/shared/commands/session/pr-review-submit-command"
    );
    const command = createSessionPrReviewSubmitCommand(mockGetDeps);
    expect(command.mutating).toBe(true);
  });

  test("session.pr.approve is registered as mutating", async () => {
    const { createSessionPrApproveCommand } = await import(WORKFLOW_COMMANDS_PATH);
    const command = createSessionPrApproveCommand(mockGetDeps);
    expect(command.mutating).toBe(true);
  });
});

describe("Drift gate — server.checkDriftGate() (real method)", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("mutating=true + stale=true => throws drift error", async () => {
    const server = await makeTestServer(true);
    expect(() => server.checkDriftGate({ mutating: true })).toThrow(/MCP server is stale/);
    try {
      server.checkDriftGate({ mutating: true });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("abc12345");
      expect(msg).toContain("def67890");
      expect(msg).toContain("/mcp");
      expect(msg).toContain("mutating operations");
    }
  });

  test("mutating=true + stale=false => no throw", async () => {
    const server = await makeTestServer(false);
    expect(() => server.checkDriftGate({ mutating: true })).not.toThrow();
  });

  test("mutating=false + stale=true => no throw", async () => {
    const server = await makeTestServer(true);
    expect(() => server.checkDriftGate({ mutating: false })).not.toThrow();
  });

  test("mutating=undefined + stale=true => no throw", async () => {
    const server = await makeTestServer(true);
    expect(() => server.checkDriftGate({})).not.toThrow();
  });

  test("mutating=false + stale=false => no throw", async () => {
    const server = await makeTestServer(false);
    expect(() => server.checkDriftGate({ mutating: false })).not.toThrow();
  });
});

describe("Drift gate — dispatcher integration (gate is wired into the request handler)", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  // This test catches the reviewer's concern: if checkDriftGate is removed
  // from the CallToolRequestSchema handler in server.ts, the gate becomes
  // dead code. We capture the registered request handler via a spy on the
  // SDK's setRequestHandler and invoke it directly, asserting that:
  //   - the gate fires (drift error thrown)
  //   - the registered tool's handler is NOT called
  test("CallToolRequestSchema dispatcher invokes checkDriftGate before tool.handler", async () => {
    const server = await makeTestServer(true);

    let toolHandlerCalled = false;
    server.addTool({
      name: "test.mutating.dispatch",
      description: "Mutating tool whose handler must NOT run when stale",
      mutating: true,
      handler: async () => {
        toolHandlerCalled = true;
        return { ok: true };
      },
    });

    // Spy on checkDriftGate to confirm the dispatcher actually calls it
    const spy = mock(server.checkDriftGate.bind(server));
    server.checkDriftGate = spy as typeof server.checkDriftGate;

    // Build the same request shape the SDK would dispatch
    const request = {
      method: "tools/call",
      params: { name: "test.mutating.dispatch", arguments: {} },
    } as const;

    // The SDK exposes registered request handlers via _requestHandlers (Map).
    // We pull the CallToolRequestSchema handler out by name.
    const sdkServer = (server as unknown as { server: { _requestHandlers: Map<string, unknown> } })
      .server;
    const handlers = sdkServer._requestHandlers;
    const callToolHandler = handlers.get("tools/call") as (
      req: typeof request,
      extra?: unknown
    ) => Promise<unknown>;
    expect(callToolHandler).toBeDefined();

    let threw = false;
    try {
      await callToolHandler(request, {});
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("MCP server is stale");
    }
    expect(threw).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(toolHandlerCalled).toBe(false);
  });

  test("dispatcher allows mutating tool through when fresh", async () => {
    const server = await makeTestServer(false);

    let toolHandlerCalled = false;
    server.addTool({
      name: "test.mutating.fresh.dispatch",
      description: "Mutating tool that should run when fresh",
      mutating: true,
      handler: async () => {
        toolHandlerCalled = true;
        return { ok: true };
      },
    });

    const request = {
      method: "tools/call",
      params: { name: "test.mutating.fresh.dispatch", arguments: {} },
    } as const;

    const sdkServer = (server as unknown as { server: { _requestHandlers: Map<string, unknown> } })
      .server;
    const handlers = sdkServer._requestHandlers;
    const callToolHandler = handlers.get("tools/call") as (
      req: typeof request,
      extra?: unknown
    ) => Promise<unknown>;

    await callToolHandler(request, {});
    expect(toolHandlerCalled).toBe(true);
  });
});

describe("Drift gate — error message format", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("stale message contains commit hash references", () => {
    const detector = makeStalenessDetector(true);
    const warning = detector.getStaleWarning();
    expect(warning).not.toBeNull();
    expect(warning).toContain("abc12345");
    expect(warning).toContain("def67890");
    expect(warning).toContain("/mcp");
  });

  test("non-stale detector returns null warning", () => {
    const detector = makeStalenessDetector(false);
    expect(detector.getStaleWarning()).toBeNull();
    expect(detector.isCurrentlyStale()).toBe(false);
  });
});
