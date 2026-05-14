/**
 * Unit tests for the merge-state sweeper (mt#1614, mt#1752).
 *
 * Verifies:
 *   - runMergeStateSweep returns sessionsScanned=N when N sessions are listed.
 *   - Sessions whose PRs are merged on GitHub (live state via Octokit, not
 *     stored session.pullRequest.state) trigger apply_post_merge_state_sync.
 *   - Sessions whose PRs are open on GitHub do NOT trigger sync, regardless
 *     of stored state — mt#1752.
 *   - Sessions without a pullRequest.number are skipped gracefully.
 *   - loadMergeStateSweeperConfig reads from env vars correctly.
 *   - startMergeStateSweeper returns null when disabled or credentials absent.
 *
 * fetch is mocked for MCP calls (session.list, session.apply_post_merge_state_sync).
 * Octokit is passed as a fake object directly to runMergeStateSweep (mt#1752
 * threaded it as a parameter).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  runMergeStateSweep,
  loadMergeStateSweeperConfig,
  startMergeStateSweeper,
} from "./merge-state-sweeper";
import { resetMcpClientSessions } from "./mcp-client";
import type { ReviewerConfig } from "./config";
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MCP_URL = "http://localhost:9999/mcp";
const MCP_TOKEN = "test-token";
const OWNER = "edobry";
const REPO = "minsky";
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
  // Reset MCP client session cache between tests so initialize replays for each.
  resetMcpClientSessions();

  // Install fake fetch — cast to typeof globalThis.fetch to satisfy Bun's
  // fetch type (which has methods like `preconnect` we don't model in the wrapper).
  // The wrapper transparently handles the MCP initialize handshake (mt#1821) so
  // existing per-tool fetchHandler implementations only see tools/call requests.
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;

    // Phase 1: initialize → 200 with Mcp-Session-Id header.
    // Phase 2: notifications/initialized → 202.
    // Phase 3 onward: delegate to per-test fetchHandler.
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let method: string | undefined;
    try {
      method = (JSON.parse(bodyText) as { method?: string }).method;
    } catch {
      // Non-JSON body — fall through to handler.
    }
    if (method === "initialize") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-03-26", capabilities: {} },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", "Mcp-Session-Id": "test-session-id" },
        }
      );
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
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

function applySyncResponse(sessionId: string): Response {
  return mcpResponse({ success: true, sessionId, taskStatusUpdated: true });
}

// ---------------------------------------------------------------------------
// Fake Octokit (mt#1752)
// ---------------------------------------------------------------------------

/**
 * Build a fake Octokit instance with a per-pr_number `pulls.get` responder.
 * The responder shape matches Octokit's `pulls.get` response: `{ data: PullRequest }`
 * where PullRequest has `merged`, `merged_at`, and `merge_commit_sha`.
 *
 * Pass `throwForPrNumber` to make a specific PR's lookup throw (simulates 4xx/5xx).
 */
function makeFakeOctokit(opts: {
  prResponses: Record<
    number,
    { merged: boolean; merged_at?: string | null; merge_commit_sha?: string | null }
  >;
  throwForPrNumber?: number;
  onCall?: (pr_number: number) => void;
}): Octokit {
  const fake = {
    rest: {
      pulls: {
        get: async (args: { owner: string; repo: string; pull_number: number }) => {
          opts.onCall?.(args.pull_number);
          if (opts.throwForPrNumber === args.pull_number) {
            throw new Error(`fake octokit: pulls.get failed for #${args.pull_number}`);
          }
          const data = opts.prResponses[args.pull_number];
          if (!data) {
            throw new Error(`fake octokit: no fixture for PR #${args.pull_number}`);
          }
          return { data };
        },
      },
    },
  };
  return fake as unknown as Octokit;
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

    const octokit = makeFakeOctokit({ prResponses: {} });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, MCP_URL, MCP_TOKEN);

    expect(result.sessionsScanned).toBe(0);
    expect(result.missedSyncs).toBe(0);
    expect(result.syncsTriggered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe("runMergeStateSweep — open PRs not synced", () => {
  it("skips a session whose PR is still open on GitHub", async () => {
    const sessions: FakeSession[] = [
      { sessionId: "s1", taskId: "mt#100", status: "PR_OPEN", pullRequest: { number: 10 } },
    ];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { params: { name: string } };
      if (body.params.name === "session.list") return sessionListResponse(sessions);
      throw new Error(`Unexpected tool call: ${body.params.name}`);
    };

    const octokit = makeFakeOctokit({
      prResponses: { 10: { merged: false } },
    });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, MCP_URL, MCP_TOKEN);

    expect(result.sessionsScanned).toBe(1);
    expect(result.missedSyncs).toBe(0);
    expect(result.syncsTriggered).toBe(0);
  });

  it("skips a session whose PR is closed but unmerged on GitHub (mt#1752: trust live state)", async () => {
    // Regression guard for mt#1752: even if some other source said the PR was merged,
    // if GitHub says `merged: false` (e.g., the PR was closed without merge), do nothing.
    const sessions: FakeSession[] = [
      // Stored state claims merged, but live GitHub state is the source of truth.
      {
        sessionId: "s1b",
        taskId: "mt#100b",
        status: "PR_OPEN",
        pullRequest: {
          number: 11,
          state: "closed",
          mergedAt: "stale-stored-value",
        },
      },
    ];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { params: { name: string } };
      if (body.params.name === "session.list") return sessionListResponse(sessions);
      throw new Error(`Unexpected tool call: ${body.params.name}`);
    };

    const octokit = makeFakeOctokit({
      prResponses: { 11: { merged: false, merged_at: null, merge_commit_sha: null } },
    });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, MCP_URL, MCP_TOKEN);

    expect(result.missedSyncs).toBe(0);
    expect(result.syncsTriggered).toBe(0);
  });
});

describe("runMergeStateSweep — merged PR triggers sync", () => {
  it("detects a merged PR on GitHub and calls apply_post_merge_state_sync", async () => {
    const sessions: FakeSession[] = [
      { sessionId: "s2", taskId: "mt#200", status: "PR_OPEN", pullRequest: { number: 20 } },
    ];

    const syncCalledFor: { sessionId: string; mergeSha?: string; mergedAt?: string }[] = [];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;
      const args = body.params.arguments;

      if (toolName === "session.list") return sessionListResponse(sessions);
      if (toolName === "session.apply_post_merge_state_sync") {
        syncCalledFor.push({
          sessionId: args["sessionId"] as string,
          mergeSha: args["mergeSha"] as string | undefined,
          mergedAt: args["mergedAt"] as string | undefined,
        });
        return applySyncResponse(args["sessionId"] as string);
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const octokit = makeFakeOctokit({
      prResponses: {
        20: {
          merged: true,
          merged_at: "2026-05-06T10:00:00.000Z",
          merge_commit_sha: "deadbeef",
        },
      },
    });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, MCP_URL, MCP_TOKEN);

    expect(result.sessionsScanned).toBe(1);
    expect(result.missedSyncs).toBe(1);
    expect(result.syncsTriggered).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(syncCalledFor).toEqual([
      {
        sessionId: "s2",
        mergeSha: "deadbeef",
        mergedAt: "2026-05-06T10:00:00.000Z",
      },
    ]);
  });

  it("mt#1752 regression: detects merge from LIVE GitHub state even when stored state says open", async () => {
    // This is the central mt#1752 regression: the sweeper must detect merge via
    // Octokit's live `pulls.get`, NOT via the stored session.pullRequest.state.
    // Six historical drift incidents (mt#1772, mt#1773, mt#1774, mt#1777,
    // mt#1742, mt#1787) had session.pullRequest.state="open" stored despite
    // their PRs being merged on GitHub for hours. The sweeper would miss them
    // under the prior `session.pr.get`-based predicate.
    const sessions: FakeSession[] = [
      {
        sessionId: "s_stale_open",
        taskId: "mt#1787",
        status: "PR_OPEN",
        pullRequest: { number: 1083, state: "open" }, // stored state is stale
      },
    ];

    let prGetCallCount = 0;
    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;
      // Critical: the sweeper must NOT call session.pr.get anymore.
      if (toolName === "session.pr.get") {
        prGetCallCount++;
        throw new Error("regression: sweeper should NOT call session.pr.get (mt#1752)");
      }
      if (toolName === "session.list") return sessionListResponse(sessions);
      if (toolName === "session.apply_post_merge_state_sync") {
        return applySyncResponse(body.params.arguments["sessionId"] as string);
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const octokit = makeFakeOctokit({
      prResponses: {
        1083: {
          merged: true,
          merged_at: "2026-05-13T00:29:35Z",
          merge_commit_sha: "6c53e872c",
        },
      },
    });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, MCP_URL, MCP_TOKEN);

    expect(prGetCallCount).toBe(0);
    expect(result.missedSyncs).toBe(1);
    expect(result.syncsTriggered).toBe(1);
  });

  it("forwards owner/repo and pull_number to Octokit correctly", async () => {
    const sessions: FakeSession[] = [
      { sessionId: "s_pr_42", status: "PR_OPEN", pullRequest: { number: 42 } },
    ];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { params: { name: string } };
      if (body.params.name === "session.list") return sessionListResponse(sessions);
      if (body.params.name === "session.apply_post_merge_state_sync") {
        return applySyncResponse("s_pr_42");
      }
      throw new Error(`Unexpected tool call: ${body.params.name}`);
    };

    const calledPrNumbers: number[] = [];
    const octokit = makeFakeOctokit({
      prResponses: { 42: { merged: true, merged_at: "2026-05-14T00:00:00Z" } },
      onCall: (n) => {
        calledPrNumbers.push(n);
      },
    });
    await runMergeStateSweep(octokit, OWNER, REPO, MCP_URL, MCP_TOKEN);

    expect(calledPrNumbers).toEqual([42]);
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

    let octokitCalls = 0;

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { params: { name: string } };
      if (body.params.name === "session.list") return sessionListResponse(sessions);
      throw new Error(`Unexpected tool call: ${body.params.name}`);
    };

    const octokit = makeFakeOctokit({
      prResponses: {},
      onCall: () => {
        octokitCalls++;
      },
    });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, MCP_URL, MCP_TOKEN);

    expect(result.sessionsScanned).toBe(2);
    expect(result.missedSyncs).toBe(0);
    expect(octokitCalls).toBe(0); // never call Octokit when PR number is missing
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
      if (toolName === "session.apply_post_merge_state_sync") {
        syncCalledFor.push(args["sessionId"] as string);
        return applySyncResponse(args["sessionId"] as string);
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const octokit = makeFakeOctokit({
      prResponses: {
        1: { merged: true, merged_at: "2026-05-06T10:00:00Z", merge_commit_sha: "aaa" },
        2: { merged: false },
        3: { merged: true, merged_at: "2026-05-06T11:00:00Z", merge_commit_sha: "ccc" },
      },
    });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, MCP_URL, MCP_TOKEN);

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

    const octokit = makeFakeOctokit({ prResponses: {} });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, MCP_URL, MCP_TOKEN);

    // Should surface the error gracefully
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.sessionsScanned).toBe(0);
  });

  it("continues sweep even when a single session's Octokit lookup fails", async () => {
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
      if (toolName === "session.apply_post_merge_state_sync") {
        syncCalledFor.push(args["sessionId"] as string);
        return applySyncResponse(args["sessionId"] as string);
      }
      throw new Error(`Unexpected: ${toolName}`);
    };

    const octokit = makeFakeOctokit({
      // se1's Octokit lookup throws; se2 is merged.
      prResponses: { 2: { merged: true, merged_at: "2026-05-06T10:00:00Z" } },
      throwForPrNumber: 1,
    });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, MCP_URL, MCP_TOKEN);

    // se1 failed (recorded as error), se2 still synced
    expect(result.errors.length).toBeGreaterThan(0);
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
      owner: OWNER,
      repo: REPO,
    });
    expect(handle).toBeNull();
  });

  it("returns null when enabled but missing mcpUrl", () => {
    const handle = startMergeStateSweeper(BASE_REVIEWER_CONFIG, {
      enabled: true,
      intervalMs: 600_000,
      mcpUrl: "", // Empty
      mcpToken: MCP_TOKEN,
      owner: OWNER,
      repo: REPO,
    });
    expect(handle).toBeNull();
  });

  it("returns null when enabled but missing mcpToken", () => {
    const handle = startMergeStateSweeper(BASE_REVIEWER_CONFIG, {
      enabled: true,
      intervalMs: 600_000,
      mcpUrl: MCP_URL,
      mcpToken: "", // Empty
      owner: OWNER,
      repo: REPO,
    });
    expect(handle).toBeNull();
  });

  it("returns an interval handle when properly configured", () => {
    const handle = startMergeStateSweeper(BASE_REVIEWER_CONFIG, {
      enabled: true,
      intervalMs: 600_000,
      mcpUrl: MCP_URL,
      mcpToken: MCP_TOKEN,
      owner: OWNER,
      repo: REPO,
    });
    expect(handle).not.toBeNull();
    // Clean up the interval so the test process can exit cleanly.
    if (handle) clearInterval(handle);
  });
});
