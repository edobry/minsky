/**
 * Unit tests for the adoption sweeper (mt#1630).
 *
 * Verifies:
 *   - runAdoptionSweep returns tasksChecked=N when N tasks are found.
 *   - Tasks with signals and no callsites get adoption follow-up tasks filed.
 *   - Tasks with signals and existing callsites do NOT get follow-ups.
 *   - Idempotent: existing adoption task is not duplicated.
 *   - Tasks with no spec produce no signals and no follow-ups.
 *   - loadAdoptionSweeperConfig reads env vars correctly.
 *   - startAdoptionSweeper returns null when disabled or credentials absent.
 *   - startAdoptionSweeper returns a handle with stop() when properly configured.
 *   - MCP errors are non-fatal: sweep continues after per-task errors.
 *
 * All external I/O (fetch) is replaced with a synchronous fake via globalThis.fetch.
 * Tests restore the original fetch after each test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  runAdoptionSweep,
  loadAdoptionSweeperConfig,
  startAdoptionSweeper,
} from "./adoption-sweeper";
import type { AdoptionSweepDeps } from "./adoption-sweeper";
import type { ReviewerConfig } from "./config";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MCP_URL = "http://localhost:9999/mcp";
const MCP_TOKEN = "test-token";

const ENV_ENABLED = "ADOPTION_SWEEPER_ENABLED";
const ENV_INTERVAL_MS = "ADOPTION_SWEEPER_INTERVAL_MS";
const ENV_LOOKBACK_DAYS = "ADOPTION_SWEEPER_LOOKBACK_DAYS";

const BASE_DEPS: AdoptionSweepDeps = {
  mcpUrl: MCP_URL,
  mcpToken: MCP_TOKEN,
  lookbackDays: 14,
};

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

let originalConsoleWarn: typeof console.warn;
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchHandler = null;

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

// ---------------------------------------------------------------------------
// MCP response builders
// ---------------------------------------------------------------------------

/** Build a fake JSON Response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a Minsky MCP tools/call response wrapping data in result.content[0].text. */
function mcpResponse(data: unknown): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id: "test",
    result: {
      content: [{ type: "text", text: JSON.stringify(data) }],
    },
  });
}

interface FakeTask {
  id: string;
  title?: string;
  status?: string;
}

function tasksSearchResponse(tasks: FakeTask[]): Response {
  return mcpResponse({ tasks });
}

function specResponse(content: string): Response {
  return mcpResponse({ success: true, content });
}

function repoSearchResponse(count: number): Response {
  // Return `count` fake match objects
  const matches = Array.from({ length: count }, (_, i) => ({ file: `src/foo${i}.ts`, line: i }));
  return mcpResponse({ matches });
}

function tasksSearchEmptyResponse(): Response {
  return mcpResponse({ tasks: [] });
}

function tasksCreateResponse(newId: string): Response {
  return mcpResponse({ success: true, taskId: newId });
}

// ---------------------------------------------------------------------------
// Helper: spec text with signals
// ---------------------------------------------------------------------------

// A spec snippet that will produce exactly one "function" signal: "myExportedFn"
const SPEC_WITH_FUNCTION_SIGNAL = [
  "## Success Criteria",
  "",
  "```typescript",
  "export function myExportedFn() {}",
  "```",
].join("\n");

// A spec snippet with no code patterns (produces zero signals)
const SPEC_NO_SIGNALS = [
  "## Summary",
  "This task adds a general improvement.",
  "## Acceptance Tests",
  "- The feature works.",
].join("\n");

// ---------------------------------------------------------------------------
// runAdoptionSweep — no tasks
// ---------------------------------------------------------------------------

describe("runAdoptionSweep — no tasks", () => {
  it("returns tasksChecked=0 when tasks_search returns empty array", async () => {
    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { params: { name: string } };
      if (body.params.name === "tasks_search") {
        return tasksSearchResponse([]);
      }
      throw new Error(`Unexpected tool call: ${body.params.name}`);
    };

    const result = await runAdoptionSweep(BASE_DEPS);

    expect(result.tasksChecked).toBe(0);
    expect(result.tasksWithSignals).toBe(0);
    expect(result.totalGapsFiled).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runAdoptionSweep — task with no spec
// ---------------------------------------------------------------------------

describe("runAdoptionSweep — task with no spec", () => {
  it("skips a task gracefully when tasks_spec_get returns no content", async () => {
    const tasks: FakeTask[] = [{ id: "mt#100", status: "DONE" }];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;

      if (toolName === "tasks_search") return tasksSearchResponse(tasks);
      if (toolName === "tasks_spec_get") {
        // Simulate spec not found — return null-content response
        return mcpResponse({ success: false, content: "" });
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runAdoptionSweep(BASE_DEPS);

    expect(result.tasksChecked).toBe(1);
    expect(result.tasksWithSignals).toBe(0);
    expect(result.totalGapsFiled).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runAdoptionSweep — task with signals, no callsites → gap filed
// ---------------------------------------------------------------------------

const ADOPTION_TASK_ID_200 = "mt#200-adoption-1";

describe("runAdoptionSweep — gap detection", () => {
  it("files an adoption follow-up when signal has zero callsites", async () => {
    const tasks: FakeTask[] = [{ id: "mt#200", status: "DONE" }];
    const createdTaskIds: string[] = [];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;

      if (toolName === "tasks_search") {
        const args = body.params.arguments;
        // First call: list DONE tasks. Subsequent calls: search for existing adoption task.
        if (args["status"] === "DONE") return tasksSearchResponse(tasks);
        // Deduplication check: no existing adoption task
        return tasksSearchEmptyResponse();
      }
      if (toolName === "tasks_spec_get") return specResponse(SPEC_WITH_FUNCTION_SIGNAL);
      if (toolName === "repo_search") return repoSearchResponse(0); // No callsites
      if (toolName === "tasks_create") {
        createdTaskIds.push(ADOPTION_TASK_ID_200);
        return tasksCreateResponse(ADOPTION_TASK_ID_200);
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runAdoptionSweep(BASE_DEPS);

    expect(result.tasksChecked).toBe(1);
    expect(result.tasksWithSignals).toBe(1);
    expect(result.totalGapsFiled).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(createdTaskIds).toContain(ADOPTION_TASK_ID_200);
  });

  it("does NOT file a follow-up when signal has existing callsites", async () => {
    const tasks: FakeTask[] = [{ id: "mt#201", status: "DONE" }];
    let tasksCreateCalled = false;

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;

      if (toolName === "tasks_search") return tasksSearchResponse(tasks);
      if (toolName === "tasks_spec_get") return specResponse(SPEC_WITH_FUNCTION_SIGNAL);
      if (toolName === "repo_search") return repoSearchResponse(3); // 3 callsites found
      if (toolName === "tasks_create") {
        tasksCreateCalled = true;
        return tasksCreateResponse("should-not-be-created");
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runAdoptionSweep(BASE_DEPS);

    expect(result.totalGapsFiled).toBe(0);
    expect(tasksCreateCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAdoptionSweep — idempotent: no duplicate follow-up tasks
// ---------------------------------------------------------------------------

describe("runAdoptionSweep — idempotent task creation", () => {
  it("does NOT file a duplicate when an adoption task already exists", async () => {
    const tasks: FakeTask[] = [{ id: "mt#300", status: "DONE" }];
    let tasksCreateCalled = false;

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;

      if (toolName === "tasks_search") {
        const args = body.params.arguments;
        if (args["status"] === "DONE") return tasksSearchResponse(tasks);
        // Deduplication check: return existing adoption task
        return mcpResponse({
          tasks: [{ id: "mt#300-adoption-existing", title: "mt#300 adoption: myExportedFn" }],
        });
      }
      if (toolName === "tasks_spec_get") return specResponse(SPEC_WITH_FUNCTION_SIGNAL);
      if (toolName === "repo_search") return repoSearchResponse(0); // No callsites
      if (toolName === "tasks_create") {
        tasksCreateCalled = true;
        return tasksCreateResponse("should-not-create");
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runAdoptionSweep(BASE_DEPS);

    expect(result.totalGapsFiled).toBe(0);
    expect(tasksCreateCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAdoptionSweep — task with no signals
// ---------------------------------------------------------------------------

describe("runAdoptionSweep — task with no signals", () => {
  it("skips filing for a task whose spec has no adoption signals", async () => {
    const tasks: FakeTask[] = [{ id: "mt#400", status: "DONE" }];
    let repoSearchCalled = false;

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;

      if (toolName === "tasks_search") return tasksSearchResponse(tasks);
      if (toolName === "tasks_spec_get") return specResponse(SPEC_NO_SIGNALS);
      if (toolName === "repo_search") {
        repoSearchCalled = true;
        return repoSearchResponse(0);
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runAdoptionSweep(BASE_DEPS);

    expect(result.tasksWithSignals).toBe(0);
    expect(result.totalGapsFiled).toBe(0);
    expect(repoSearchCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAdoptionSweep — error handling
// ---------------------------------------------------------------------------

describe("runAdoptionSweep — error handling", () => {
  it("returns errors when tasks_search fails with no content", async () => {
    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { params: { name: string } };
      if (body.params.name === "tasks_search") {
        return jsonResponse({ jsonrpc: "2.0", id: "test", error: { message: "DB unavailable" } });
      }
      throw new Error("Unexpected tool call");
    };

    const result = await runAdoptionSweep(BASE_DEPS);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.tasksChecked).toBe(0);
  });

  it("continues sweep when a single task's spec fetch fails", async () => {
    const tasks: FakeTask[] = [
      { id: "mt#501", status: "DONE" },
      { id: "mt#502", status: "DONE" },
    ];
    const processedTaskIds: string[] = [];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;

      if (toolName === "tasks_search") {
        const args = body.params.arguments;
        if (args["status"] === "DONE") return tasksSearchResponse(tasks);
        return tasksSearchEmptyResponse();
      }
      if (toolName === "tasks_spec_get") {
        const taskId = body.params.arguments["taskId"] as string;
        if (taskId === "mt#501") {
          // mt#501's spec fetch fails
          return jsonResponse({}, 500);
        }
        // mt#502 has a signal
        processedTaskIds.push(taskId);
        return specResponse(SPEC_WITH_FUNCTION_SIGNAL);
      }
      if (toolName === "repo_search") return repoSearchResponse(2); // callsites present
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runAdoptionSweep(BASE_DEPS);

    // mt#501 failed but mt#502 was still processed
    expect(result.tasksChecked).toBe(2);
    expect(processedTaskIds).toContain("mt#502");
    // mt#502 has callsites, so no gap filed
    expect(result.totalGapsFiled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadAdoptionSweeperConfig — env-var tests
// ---------------------------------------------------------------------------

describe("loadAdoptionSweeperConfig", () => {
  it("defaults to enabled=false when env var not set", () => {
    const saved = process.env[ENV_ENABLED];
    delete process.env[ENV_ENABLED];
    try {
      const cfg = loadAdoptionSweeperConfig();
      expect(cfg.enabled).toBe(false);
    } finally {
      if (saved !== undefined) process.env[ENV_ENABLED] = saved;
    }
  });

  it("enabled=true when ADOPTION_SWEEPER_ENABLED=true", () => {
    const saved = process.env[ENV_ENABLED];
    process.env[ENV_ENABLED] = "true";
    try {
      const cfg = loadAdoptionSweeperConfig();
      expect(cfg.enabled).toBe(true);
    } finally {
      if (saved !== undefined) {
        process.env[ENV_ENABLED] = saved;
      } else {
        delete process.env[ENV_ENABLED];
      }
    }
  });

  it("defaults to 86400000ms (24h) interval", () => {
    const saved = process.env[ENV_INTERVAL_MS];
    delete process.env[ENV_INTERVAL_MS];
    try {
      const cfg = loadAdoptionSweeperConfig();
      expect(cfg.intervalMs).toBe(86_400_000);
    } finally {
      if (saved !== undefined) process.env[ENV_INTERVAL_MS] = saved;
    }
  });

  it("reads custom interval from env var", () => {
    const saved = process.env[ENV_INTERVAL_MS];
    process.env[ENV_INTERVAL_MS] = "3600000";
    try {
      const cfg = loadAdoptionSweeperConfig();
      expect(cfg.intervalMs).toBe(3_600_000);
    } finally {
      if (saved !== undefined) {
        process.env[ENV_INTERVAL_MS] = saved;
      } else {
        delete process.env[ENV_INTERVAL_MS];
      }
    }
  });

  it("defaults to lookbackDays=14", () => {
    const saved = process.env[ENV_LOOKBACK_DAYS];
    delete process.env[ENV_LOOKBACK_DAYS];
    try {
      const cfg = loadAdoptionSweeperConfig();
      expect(cfg.lookbackDays).toBe(14);
    } finally {
      if (saved !== undefined) process.env[ENV_LOOKBACK_DAYS] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// startAdoptionSweeper — lifecycle tests
// ---------------------------------------------------------------------------

describe("startAdoptionSweeper", () => {
  it("returns null when disabled", () => {
    const handle = startAdoptionSweeper(BASE_REVIEWER_CONFIG, {
      enabled: false,
      intervalMs: 86_400_000,
      mcpUrl: MCP_URL,
      mcpToken: MCP_TOKEN,
      lookbackDays: 14,
    });
    expect(handle).toBeNull();
  });

  it("returns null when enabled but missing mcpUrl", () => {
    const handle = startAdoptionSweeper(BASE_REVIEWER_CONFIG, {
      enabled: true,
      intervalMs: 86_400_000,
      mcpUrl: "",
      mcpToken: MCP_TOKEN,
      lookbackDays: 14,
    });
    expect(handle).toBeNull();
  });

  it("returns null when enabled but missing mcpToken", () => {
    const handle = startAdoptionSweeper(BASE_REVIEWER_CONFIG, {
      enabled: true,
      intervalMs: 86_400_000,
      mcpUrl: MCP_URL,
      mcpToken: "",
      lookbackDays: 14,
    });
    expect(handle).toBeNull();
  });

  it("returns a handle with stop() when properly configured", () => {
    const handle = startAdoptionSweeper(BASE_REVIEWER_CONFIG, {
      enabled: true,
      intervalMs: 86_400_000,
      mcpUrl: MCP_URL,
      mcpToken: MCP_TOKEN,
      lookbackDays: 14,
    });
    expect(handle).not.toBeNull();
    expect(typeof handle?.stop).toBe("function");
    // Clean up the interval so the test process can exit cleanly.
    handle?.stop();
  });
});
