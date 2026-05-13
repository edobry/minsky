/**
 * Unit tests for the merge-state sweeper (mt#1614).
 *
 * Verifies:
 *   - runMergeStateSweep returns sessionsScanned=N when N sessions are listed.
 *   - Sessions with closed-merged PRs trigger apply_post_merge_state_sync.
 *   - Sessions with open PRs do NOT trigger sync.
 *   - Sessions without a pullRequest.number are skipped gracefully.
 *   - loadMergeStateSweeperConfig reads from env vars correctly.
 *   - startMergeStateSweeper returns null when disabled or credentials absent.
 *
 * All external I/O (fetch) is replaced with a synchronous fake via globalThis.fetch.
 * Tests restore the original fetch after each test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  runMergeStateSweep,
  loadMergeStateSweeperConfig,
  startMergeStateSweeper,
} from "./merge-state-sweeper";
import type { ReviewerConfig } from "./config";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MCP_URL = "http://localhost:9999/mcp";
const MCP_TOKEN = "test-token";
const ENV_SWEEPER_ENABLED = "MERGE_STATE_SWEEPER_ENABLED";
const ENV_SWEEPER_INTERVAL_MS = "MERGE_STATE_SWEEPER_INTERVAL_MS";

const BASE_REVIEWER_CONFIG: ReviewerConfig = {
  appId: 1,
  privateKey: "",
  installationId: 1,
  webhookSecret: "",
  provider: "openai",
  providerApiKey: "",
  providerModel: "gpt-5",
  tier2Enabled: false,
  mcpUrl: undefined,
  mcpToken: undefined,
  port: 3000,
  logLevel: "info",
  modelTimeoutMs: 120_000,
  githubTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Fake fetch infrastructure
// ---------------------------------------------------------------------------

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;

let originalFetch: typeof globalThis.fetch;
let fetchHandler: FetchHandler | null = null;

// Store original console methods to restore after each test.
// The sweeper calls console.warn and console.log internally. Replacing them
// per-test prevents cross-file contamination when bun test runs files in
// parallel with other tests that use spyOn(console, "warn").
let originalConsoleWarn: typeof console.warn;
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchHandler = null;

  // Install fake fetch — cast to typeof globalThis.fetch to satisfy Bun's
  // fetch type (which has methods like `preconnect` we don't model in the wrapper).
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;
    if (fetchHandler) {
      return fetchHandler(url, init ?? {});
    }
    throw new Error(`fetch called but no handler installed: ${url}`);
  }) as typeof globalThis.fetch;

  // Isolate console to prevent sweeper's internal console calls from
  // contaminating concurrent test files' console spies.
  originalConsoleWarn = console.warn;
  originalConsoleLog = console.log;
  originalConsoleError = console.error;
  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalConsoleWarn;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

/** Build a fake Response with given JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build an MCP tools/call response with the given data in result.content[0].text. */
function mcpResponse(data: unknown): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id: "test",
    result: {
      content: [{ type: "text", text: JSON.stringify(data) }],
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: build a session list MCP response
// ---------------------------------------------------------------------------

interface FakeSession {
  sessionId: string;
  taskId?: string;
  status?: string;
  pullRequest?: {
    number?: number;
    state?: string;
    mergedAt?: string;
    github?: { htmlUrl?: string };
  };
}

function sessionListResponse(sessions: FakeSession[]): Response {
  return mcpResponse({ sessions });
}

interface FakePrState {
  state?: string;
  merged?: boolean;
  mergedAt?: string;
  mergeSha?: string;
}

function prGetResponse(pr: FakePrState): Response {
  return mcpResponse({ pullRequest: pr });
}

function applySyncResponse(sessionId: string): Response {
  return mcpResponse({ success: true, sessionId, taskStatusUpdated: true });
}

// ---------------------------------------------------------------------------
// runMergeStateSweep — tests
// ---------------------------------------------------------------------------

describe("runMergeStateSweep — no sessions", () => {
  it("returns sessionsScanned=0 when session.list returns empty array", async () => {
    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { params: { name: string } };
      if (body.params.name === "session.list") {
        return sessionListResponse([]);
      }
      throw new Error(`Unexpected tool call: ${body.params.name}`);
    };

    const result = await runMergeStateSweep(MCP_URL, MCP_TOKEN);

    expect(result.sessionsScanned).toBe(0);
    expect(result.missedSyncs).toBe(0);
    expect(result.syncsTriggered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe("runMergeStateSweep — open PRs not synced", () => {
  it("skips a session whose PR is still open", async () => {
    const sessions: FakeSession[] = [
      { sessionId: "s1", taskId: "mt#100", status: "PR_OPEN", pullRequest: { number: 10 } },
    ];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;
      const args = body.params.arguments;

      if (toolName === "session.list") return sessionListResponse(sessions);
      if (toolName === "session.pr.get") {
        const sessionId = args["sessionId"] as string;
        if (sessionId === "s1") {
          return prGetResponse({ state: "open", merged: false });
        }
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runMergeStateSweep(MCP_URL, MCP_TOKEN);

    expect(result.sessionsScanned).toBe(1);
    expect(result.missedSyncs).toBe(0);
    expect(result.syncsTriggered).toBe(0);
  });
});

describe("runMergeStateSweep — merged PR triggers sync", () => {
  it("detects a closed-merged PR and calls apply_post_merge_state_sync", async () => {
    const sessions: FakeSession[] = [
      { sessionId: "s2", taskId: "mt#200", status: "PR_OPEN", pullRequest: { number: 20 } },
    ];

    const syncCalledFor: string[] = [];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;
      const args = body.params.arguments;

      if (toolName === "session.list") return sessionListResponse(sessions);
      if (toolName === "session.pr.get") {
        return prGetResponse({
          state: "closed",
          merged: true,
          mergedAt: "2026-05-06T10:00:00.000Z",
          mergeSha: "deadbeef",
        });
      }
      if (toolName === "session.apply_post_merge_state_sync") {
        const sessionId = args["sessionId"] as string;
        syncCalledFor.push(sessionId);
        return applySyncResponse(sessionId);
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runMergeStateSweep(MCP_URL, MCP_TOKEN);

    expect(result.sessionsScanned).toBe(1);
    expect(result.missedSyncs).toBe(1);
    expect(result.syncsTriggered).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(syncCalledFor).toContain("s2");
  });

  it("detects merge via state=closed + mergedAt (no merged=true field)", async () => {
    const sessions: FakeSession[] = [
      { sessionId: "s3", taskId: "mt#300", status: "PR_OPEN", pullRequest: { number: 30 } },
    ];

    const syncCalledFor: string[] = [];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;
      const args = body.params.arguments;

      if (toolName === "session.list") return sessionListResponse(sessions);
      if (toolName === "session.pr.get") {
        // state=closed + mergedAt set, no explicit merged=true
        return prGetResponse({
          state: "closed",
          mergedAt: "2026-05-06T10:00:00.000Z",
        });
      }
      if (toolName === "session.apply_post_merge_state_sync") {
        syncCalledFor.push(args["sessionId"] as string);
        return applySyncResponse(args["sessionId"] as string);
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runMergeStateSweep(MCP_URL, MCP_TOKEN);

    expect(result.missedSyncs).toBe(1);
    expect(result.syncsTriggered).toBe(1);
    expect(syncCalledFor).toContain("s3");
  });
});

describe("runMergeStateSweep — skips sessions without PR number", () => {
  it("skips a PR_OPEN session that has no pullRequest.number", async () => {
    const sessions: FakeSession[] = [
      // No pullRequest at all
      { sessionId: "s4", taskId: "mt#400", status: "PR_OPEN" },
      // Has pullRequest but no number
      { sessionId: "s5", taskId: "mt#500", status: "PR_OPEN", pullRequest: {} },
    ];

    let prGetCalled = false;

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string };
      };
      const toolName = body.params.name;

      if (toolName === "session.list") return sessionListResponse(sessions);
      if (toolName === "session.pr.get") {
        prGetCalled = true;
        return prGetResponse({ state: "open" });
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runMergeStateSweep(MCP_URL, MCP_TOKEN);

    expect(result.sessionsScanned).toBe(2);
    expect(result.missedSyncs).toBe(0);
    expect(prGetCalled).toBe(false); // should never call pr.get for these
  });
});

describe("runMergeStateSweep — handles multiple sessions", () => {
  it("processes multiple sessions in parallel, applies sync to all merged ones", async () => {
    const sessions: FakeSession[] = [
      { sessionId: "sa", taskId: "mt#1", status: "PR_OPEN", pullRequest: { number: 1 } },
      { sessionId: "sb", taskId: "mt#2", status: "PR_OPEN", pullRequest: { number: 2 } },
      { sessionId: "sc", taskId: "mt#3", status: "PR_OPEN", pullRequest: { number: 3 } },
    ];

    const syncCalledFor: string[] = [];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;
      const args = body.params.arguments;

      if (toolName === "session.list") return sessionListResponse(sessions);
      if (toolName === "session.pr.get") {
        const sessionId = args["sessionId"] as string;
        // sa and sc are merged; sb is still open
        if (sessionId === "sa" || sessionId === "sc") {
          return prGetResponse({ state: "closed", merged: true, mergedAt: "2026-05-06T10:00:00Z" });
        }
        return prGetResponse({ state: "open", merged: false });
      }
      if (toolName === "session.apply_post_merge_state_sync") {
        syncCalledFor.push(args["sessionId"] as string);
        return applySyncResponse(args["sessionId"] as string);
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runMergeStateSweep(MCP_URL, MCP_TOKEN);

    expect(result.sessionsScanned).toBe(3);
    expect(result.missedSyncs).toBe(2);
    expect(result.syncsTriggered).toBe(2);
    expect(syncCalledFor.sort()).toEqual(["sa", "sc"]);
  });
});

describe("runMergeStateSweep — error handling", () => {
  it("returns errors array and continues when session.list returns no content", async () => {
    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { params: { name: string } };
      if (body.params.name === "session.list") {
        // Simulate MCP error
        return jsonResponse({
          jsonrpc: "2.0",
          id: "test",
          error: { message: "DB unavailable" },
        });
      }
      throw new Error("Unexpected tool call");
    };

    const result = await runMergeStateSweep(MCP_URL, MCP_TOKEN);

    // Should surface the error gracefully
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.sessionsScanned).toBe(0);
  });

  it("continues sweep even when a single session's pr.get fails", async () => {
    const sessions: FakeSession[] = [
      { sessionId: "se1", status: "PR_OPEN", pullRequest: { number: 1 } },
      { sessionId: "se2", status: "PR_OPEN", pullRequest: { number: 2 } },
    ];

    const syncCalledFor: string[] = [];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;
      const args = body.params.arguments;

      if (toolName === "session.list") return sessionListResponse(sessions);
      if (toolName === "session.pr.get") {
        const sessionId = args["sessionId"] as string;
        if (sessionId === "se1") {
          // se1's pr.get fails
          return jsonResponse({}, 500);
        }
        // se2 is merged
        return prGetResponse({ state: "closed", merged: true, mergedAt: "2026-05-06T10:00:00Z" });
      }
      if (toolName === "session.apply_post_merge_state_sync") {
        syncCalledFor.push(args["sessionId"] as string);
        return applySyncResponse(args["sessionId"] as string);
      }
      throw new Error(`Unexpected: ${toolName}`);
    };

    const result = await runMergeStateSweep(MCP_URL, MCP_TOKEN);

    // se1 failed, se2 still synced
    expect(result.missedSyncs).toBe(1);
    expect(result.syncsTriggered).toBe(1);
    expect(syncCalledFor).toContain("se2");
  });
});

// ---------------------------------------------------------------------------
// loadMergeStateSweeperConfig — env-var tests
// ---------------------------------------------------------------------------

describe("loadMergeStateSweeperConfig", () => {
  it("defaults to enabled=true when env var not set (mt#1811)", () => {
    const saved = process.env[ENV_SWEEPER_ENABLED];
    delete process.env[ENV_SWEEPER_ENABLED];
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.enabled).toBe(true);
    } finally {
      if (saved !== undefined) process.env[ENV_SWEEPER_ENABLED] = saved;
    }
  });

  it("enabled=true when MERGE_STATE_SWEEPER_ENABLED=true", () => {
    const saved = process.env[ENV_SWEEPER_ENABLED];
    process.env[ENV_SWEEPER_ENABLED] = "true";
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.enabled).toBe(true);
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_ENABLED] = saved;
      } else {
        delete process.env[ENV_SWEEPER_ENABLED];
      }
    }
  });

  it("enabled=false when MERGE_STATE_SWEEPER_ENABLED=false (explicit opt-out)", () => {
    const saved = process.env[ENV_SWEEPER_ENABLED];
    process.env[ENV_SWEEPER_ENABLED] = "false";
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.enabled).toBe(false);
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_ENABLED] = saved;
      } else {
        delete process.env[ENV_SWEEPER_ENABLED];
      }
    }
  });

  it("defaults to 600000ms interval", () => {
    const saved = process.env[ENV_SWEEPER_INTERVAL_MS];
    delete process.env[ENV_SWEEPER_INTERVAL_MS];
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.intervalMs).toBe(600_000);
    } finally {
      if (saved !== undefined) process.env[ENV_SWEEPER_INTERVAL_MS] = saved;
    }
  });

  it("reads custom interval from env var", () => {
    const saved = process.env[ENV_SWEEPER_INTERVAL_MS];
    process.env[ENV_SWEEPER_INTERVAL_MS] = "30000";
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.intervalMs).toBe(30_000);
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_INTERVAL_MS] = saved;
      } else {
        delete process.env[ENV_SWEEPER_INTERVAL_MS];
      }
    }
  });

  it("throws on non-numeric MERGE_STATE_SWEEPER_INTERVAL_MS (mt#1811 R1 BLOCKING fix)", () => {
    const saved = process.env[ENV_SWEEPER_INTERVAL_MS];
    process.env[ENV_SWEEPER_INTERVAL_MS] = "ten_minutes";
    try {
      expect(() => loadMergeStateSweeperConfig()).toThrow(
        /MERGE_STATE_SWEEPER_INTERVAL_MS must be a positive integer/
      );
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_INTERVAL_MS] = saved;
      } else {
        delete process.env[ENV_SWEEPER_INTERVAL_MS];
      }
    }
  });

  it("throws on negative MERGE_STATE_SWEEPER_INTERVAL_MS (mt#1811 R1 BLOCKING fix)", () => {
    const saved = process.env[ENV_SWEEPER_INTERVAL_MS];
    process.env[ENV_SWEEPER_INTERVAL_MS] = "-5";
    try {
      expect(() => loadMergeStateSweeperConfig()).toThrow(
        /MERGE_STATE_SWEEPER_INTERVAL_MS must be a positive integer/
      );
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_INTERVAL_MS] = saved;
      } else {
        delete process.env[ENV_SWEEPER_INTERVAL_MS];
      }
    }
  });

  it("throws on zero MERGE_STATE_SWEEPER_INTERVAL_MS (mt#1811 R1 BLOCKING fix)", () => {
    const saved = process.env[ENV_SWEEPER_INTERVAL_MS];
    process.env[ENV_SWEEPER_INTERVAL_MS] = "0";
    try {
      expect(() => loadMergeStateSweeperConfig()).toThrow(
        /MERGE_STATE_SWEEPER_INTERVAL_MS must be a positive integer/
      );
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_INTERVAL_MS] = saved;
      } else {
        delete process.env[ENV_SWEEPER_INTERVAL_MS];
      }
    }
  });
});

// ---------------------------------------------------------------------------
// startMergeStateSweeper — lifecycle tests
// ---------------------------------------------------------------------------

describe("startMergeStateSweeper", () => {
  it("returns null when disabled", () => {
    const handle = startMergeStateSweeper(BASE_REVIEWER_CONFIG, {
      enabled: false,
      intervalMs: 600_000,
      mcpUrl: MCP_URL,
      mcpToken: MCP_TOKEN,
    });
    expect(handle).toBeNull();
  });

  it("returns null when enabled but missing mcpUrl", () => {
    const handle = startMergeStateSweeper(BASE_REVIEWER_CONFIG, {
      enabled: true,
      intervalMs: 600_000,
      mcpUrl: "", // Empty
      mcpToken: MCP_TOKEN,
    });
    expect(handle).toBeNull();
  });

  it("returns null when enabled but missing mcpToken", () => {
    const handle = startMergeStateSweeper(BASE_REVIEWER_CONFIG, {
      enabled: true,
      intervalMs: 600_000,
      mcpUrl: MCP_URL,
      mcpToken: "", // Empty
    });
    expect(handle).toBeNull();
  });

  it("returns an interval handle when properly configured", () => {
    const handle = startMergeStateSweeper(BASE_REVIEWER_CONFIG, {
      enabled: true,
      intervalMs: 600_000,
      mcpUrl: MCP_URL,
      mcpToken: MCP_TOKEN,
    });
    expect(handle).not.toBeNull();
    // Clean up the interval so the test process can exit cleanly.
    if (handle) clearInterval(handle);
  });
});
