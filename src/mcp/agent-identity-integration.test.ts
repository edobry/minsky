/**
 * Integration tests for agent identity wiring in the MCP server (ADR-006).
 *
 * Verifies that:
 * 1. resolveCallerAgentId() returns a well-formed agentId string
 * 2. Layer 2 (_meta declared) overrides Layer 1 (ascribed) when present
 * 3. writeAgentIdToSession() calls sessionProvider.updateSession() with the
 *    resolved agentId when a container is set (last-touched-by semantics)
 * 4. writeAgentIdToSession() is a no-op when no container is set
 * 5. Task-ID-based session lookup path calls updateSession on the matched record
 */
import { describe, test, expect, mock } from "bun:test";
import { MinskyMCPServer } from "./server";
import { AGENT_ID_META_KEY } from "../domain/agent-identity/layer2";
import type { AppContainerInterface, ServiceKey } from "../composition/types";
import type { SessionProviderInterface, SessionRecord } from "../domain/session/types";

// Used in tests where writeAgentIdToSession is expected to short-circuit
// before the agentId value is observed (no container, no session match).
const PLACEHOLDER_AGENT_ID = "unknown:hash:abc";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeSessionRecord(sessionId: string, taskId?: string): SessionRecord {
  return {
    sessionId,
    repoPath: "/fake/repo",
    createdAt: new Date().toISOString(),
    taskId,
  } as unknown as SessionRecord;
}

/** Build a minimal fake SessionProviderInterface with a tracked updateSession. */
function makeSessionProvider(records: SessionRecord[] = []): {
  provider: SessionProviderInterface;
  updates: Array<{ session: string; updates: Partial<SessionRecord> }>;
} {
  const updates: Array<{ session: string; updates: Partial<SessionRecord> }> = [];

  const provider: SessionProviderInterface = {
    getSession: mock(async (name: string) => records.find((r) => r.sessionId === name) ?? null),
    listSessions: mock(async () => records),
    createSession: mock(async (record) => record as SessionRecord),
    updateSession: mock(async (session: string, patch: Partial<SessionRecord>) => {
      updates.push({ session, updates: patch });
    }),
    deleteSession: mock(async () => {}),
    getSessionByTaskId: mock(
      async (taskId: string) => records.find((r) => r.taskId === taskId) ?? null
    ),
  } as unknown as SessionProviderInterface;

  return { provider, updates };
}

/** Build a minimal fake AppContainerInterface. */
function makeContainer(provider: SessionProviderInterface | null): AppContainerInterface {
  const services = new Map<string, unknown>();
  if (provider) {
    services.set("sessionProvider", provider);
  }

  return {
    register: mock(() => ({}) as AppContainerInterface),
    set: mock(() => ({}) as AppContainerInterface),
    get: mock((key: ServiceKey) => {
      const val = services.get(key);
      if (val === undefined) throw new Error(`Service '${key}' not registered`);
      return val as any;
    }),
    has: mock((key: ServiceKey) => services.has(key)),
    initialize: mock(async () => {}),
    close: mock(async () => {}),
  } as unknown as AppContainerInterface;
}

/** Construct a server instance with no real project context needed. */
function makeServer(): MinskyMCPServer {
  return new MinskyMCPServer({
    name: "test-server",
    version: "0.0.1",
    projectContext: { repositoryPath: "/fake/repo" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP server — agent identity integration (ADR-006)", () => {
  // -------------------------------------------------------------------------
  // resolveCallerAgentId
  // -------------------------------------------------------------------------

  describe("resolveCallerAgentId()", () => {
    test("returns a non-empty agentId when no extras provided", () => {
      const server = makeServer();
      // Pass undefined as the Server instance — getClientVersion() is caught
      // defensively, so clientInfoName stays undefined (no connected transport
      // in these unit tests, which matches the original test intent).
      const agentId = (server as any).resolveCallerAgentId(undefined, undefined) as string;
      expect(agentId).toBeTruthy();
      expect(typeof agentId).toBe("string");
    });

    test("returns a valid format: kind:scope:id", () => {
      const server = makeServer();
      const agentId = (server as any).resolveCallerAgentId(undefined, {}) as string;
      expect(agentId).toMatch(/^[^:@]+:[^:@]+:[^@]+/);
    });

    test("Layer 2 wins when _meta declares a valid agentId", () => {
      const server = makeServer();
      const declaredId =
        "minsky.native-subagent:run:task-mt999@com.anthropic.claude-code:proc:a1b2";
      const extras = { _meta: { [AGENT_ID_META_KEY]: declaredId } };
      const agentId = (server as any).resolveCallerAgentId(undefined, extras) as string;
      expect(agentId).toBe(declaredId);
    });

    test("falls back to Layer 1 when _meta value is malformed", () => {
      const server = makeServer();
      const extras = { _meta: { [AGENT_ID_META_KEY]: "not-valid-format" } };
      const agentId = (server as any).resolveCallerAgentId(undefined, extras) as string;
      // Must not return the malformed string
      expect(agentId).not.toBe("not-valid-format");
      // Must still be a valid format
      expect(agentId).toMatch(/^[^:@]+:[^:@]+:[^@]+/);
    });
  });

  // -------------------------------------------------------------------------
  // writeAgentIdToSession — no container
  // -------------------------------------------------------------------------

  describe("writeAgentIdToSession() without container", () => {
    test("is a no-op when container is not set", async () => {
      const server = makeServer();
      // No container — should resolve without throwing
      await expect(
        (server as any).writeAgentIdToSession({ session: "test-session" }, "unknown:hash:abc")
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // writeAgentIdToSession — direct session name path
  // -------------------------------------------------------------------------

  describe("writeAgentIdToSession() — session name path", () => {
    test("calls updateSession with agentId when args.sessionId is provided", async () => {
      const record = makeSessionRecord("my-session");
      const { provider, updates } = makeSessionProvider([record]);
      const container = makeContainer(provider);

      const server = makeServer();
      server.setContainer(container);

      const agentId = "com.anthropic.claude-code:proc:deadbeef12345678";
      await (server as any).writeAgentIdToSession({ session: "my-session" }, agentId);

      expect(updates).toHaveLength(1);
      const update0 = updates[0];
      if (!update0) throw new Error("Expected update[0] to exist");
      expect(update0.session).toBe("my-session");
      expect(update0.updates.agentId).toBe(agentId);
    });

    test("calls updateSession when args.sessionId is provided", async () => {
      const record = makeSessionRecord("sid-session");
      const { provider, updates } = makeSessionProvider([record]);
      const container = makeContainer(provider);

      const server = makeServer();
      server.setContainer(container);

      const agentId = "com.anthropic.claude-code:proc:c0ffee00c0ffee00";
      await (server as any).writeAgentIdToSession({ sessionId: "sid-session" }, agentId);

      expect(updates).toHaveLength(1);
      const update0sid = updates[0];
      if (!update0sid) throw new Error("Expected update[0] to exist");
      expect(update0sid.session).toBe("sid-session");
      expect(update0sid.updates.agentId).toBe(agentId);
    });

    test("does not call updateSession when no session identifier in args", async () => {
      const { provider, updates } = makeSessionProvider([]);
      const container = makeContainer(provider);

      const server = makeServer();
      server.setContainer(container);

      await (server as any).writeAgentIdToSession({ title: "some-task" }, PLACEHOLDER_AGENT_ID);

      expect(updates).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // writeAgentIdToSession — task-based session lookup path
  // -------------------------------------------------------------------------

  describe("writeAgentIdToSession() — task ID path", () => {
    test("looks up session by taskId and calls updateSession", async () => {
      const record = makeSessionRecord("task-session", "1078");
      const { provider, updates } = makeSessionProvider([record]);
      const container = makeContainer(provider);

      const server = makeServer();
      server.setContainer(container);

      const agentId = "com.anthropic.claude-code:proc:f00df00df00df00d";
      await (server as any).writeAgentIdToSession({ task: "mt#1078" }, agentId);

      expect(updates).toHaveLength(1);
      const update0task = updates[0];
      if (!update0task) throw new Error("Expected update[0] to exist");
      expect(update0task.session).toBe("task-session");
      expect(update0task.updates.agentId).toBe(agentId);
    });

    test("strips 'mt#' prefix when calling getSessionByTaskId", async () => {
      const record = makeSessionRecord("normalized-session", "42");
      const { provider, updates } = makeSessionProvider([record]);
      const container = makeContainer(provider);

      const server = makeServer();
      server.setContainer(container);

      await (server as any).writeAgentIdToSession(
        { taskId: "mt#42" },
        "com.openai.codex:proc:aabbccdd11223344"
      );

      // getSessionByTaskId was called with the normalized ID (no prefix)
      expect(provider.getSessionByTaskId).toHaveBeenCalledWith("42");
      expect(updates).toHaveLength(1);
      const update0norm = updates[0];
      if (!update0norm) throw new Error("Expected update[0] to exist");
      expect(update0norm.session).toBe("normalized-session");
    });

    test("does nothing when no session found for taskId", async () => {
      const { provider, updates } = makeSessionProvider([]); // empty — no match
      const container = makeContainer(provider);

      const server = makeServer();
      server.setContainer(container);

      await (server as any).writeAgentIdToSession({ task: "mt#9999" }, PLACEHOLDER_AGENT_ID);

      expect(updates).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // setContainer()
  // -------------------------------------------------------------------------

  describe("setContainer()", () => {
    test("enables agentId writes after being called post-construction", async () => {
      const record = makeSessionRecord("late-set-session");
      const { provider, updates } = makeSessionProvider([record]);
      const container = makeContainer(provider);

      const server = makeServer();
      // Container set AFTER construction (mirrors start-command.ts pattern)
      server.setContainer(container);

      await (server as any).writeAgentIdToSession(
        { session: "late-set-session" },
        "unknown:hash:0"
      );

      expect(updates).toHaveLength(1);
    });
  });
});
