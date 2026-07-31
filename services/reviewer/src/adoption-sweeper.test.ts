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
import { resetMcpClientSessions } from "./mcp-client";
import type { ReviewerConfig } from "./config";
import { silenceConsoleLogs } from "./test-helpers/log-capture";

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

// The sweeper emits structured log lines via the reviewer-local winston
// logger (routed to process.stdout). Per-test silencing keeps `bun test`
// output clean.
let stdoutSilencer: { restore: () => void } | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchHandler = null;
  // Reset MCP client session cache between tests so initialize replays for each.
  resetMcpClientSessions();

  // Install fake fetch. The wrapper transparently handles the MCP initialize
  // handshake (mt#1821) so existing per-tool fetchHandler implementations only
  // see tools/call requests.
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;

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

  stdoutSilencer = silenceConsoleLogs();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (stdoutSilencer) {
    stdoutSilencer.restore();
    stdoutSilencer = null;
  }
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
  updatedAt?: string;
  closedAt?: string;
}

function tasksListResponse(tasks: FakeTask[]): Response {
  return mcpResponse({ tasks });
}

function specResponse(content: string): Response {
  return mcpResponse({ success: true, content });
}

function repoSearchResponse(count: number): Response {
  // mt#2781: emit the REAL repo.search response shape — `{ success, output }`
  // where output is raw `git grep -n` text (`<path>:<line>:<content>` per
  // line). The previous fixture returned an imagined `{ matches: [...] }`
  // shape the tool never produces, so tests validated the wrong contract
  // while production always counted 0.
  const lines = Array.from(
    { length: count },
    (_, i) => `src/foo${i}.ts:${i + 1}:const x = someSignal();`
  );
  return mcpResponse({ success: true, output: lines.join("\n") });
}

/**
 * A repo.search response mixing production and test-file matches (mt#2781):
 * countCallsites must count only the production `.ts` lines.
 */
function repoSearchResponseWithTestFiles(prodCount: number, testCount: number): Response {
  const prod = Array.from(
    { length: prodCount },
    (_, i) => `src/prod${i}.ts:${i + 1}:const x = someSignal();`
  );
  const tests = Array.from(
    { length: testCount },
    (_, i) => `src/prod${i}.test.ts:${i + 1}:const x = someSignal();`
  );
  return mcpResponse({ success: true, output: [...prod, ...tests].join("\n") });
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
  it("returns tasksChecked=0 when tasks_list returns empty array", async () => {
    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { params: { name: string } };
      if (body.params.name === "tasks_list") {
        return tasksListResponse([]);
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

      if (toolName === "tasks_list") return tasksListResponse(tasks);
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

      if (toolName === "tasks_list") return tasksListResponse(tasks);
      if (toolName === "tasks_search") return tasksSearchEmptyResponse(); // dedup: no existing
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

      if (toolName === "tasks_list") return tasksListResponse(tasks);
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

  it("excludes test-file matches from the callsite count (mt#2781): test-only matches file a gap", async () => {
    const ADOPTION_TASK_ID_202 = "mt#202-adoption-1";
    const tasks: FakeTask[] = [{ id: "mt#202", status: "DONE" }];
    const createdTaskIds: string[] = [];
    let repoSearchArgs: Record<string, unknown> | undefined;

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;

      if (toolName === "tasks_list") return tasksListResponse(tasks);
      if (toolName === "tasks_search") return tasksSearchEmptyResponse();
      if (toolName === "tasks_spec_get") return specResponse(SPEC_WITH_FUNCTION_SIGNAL);
      if (toolName === "repo_search") {
        repoSearchArgs = body.params.arguments;
        // ONLY test-file matches — production count must be 0 → gap filed.
        return repoSearchResponseWithTestFiles(0, 3);
      }
      if (toolName === "tasks_create") {
        createdTaskIds.push(ADOPTION_TASK_ID_202);
        return tasksCreateResponse(ADOPTION_TASK_ID_202);
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runAdoptionSweep(BASE_DEPS);

    // Test-file matches do not count as adoption — the gap IS filed.
    expect(result.totalGapsFiled).toBe(1);
    expect(createdTaskIds).toContain(ADOPTION_TASK_ID_202);
    // The call sends only declared params (post-mt#2778 boundary). Repo-wide
    // grep (no path scoping) per PR #1947 R1 — production source spans
    // src/, packages/, services/.
    expect(repoSearchArgs).toBeDefined();
    expect(Object.keys(repoSearchArgs ?? {})).toEqual(["pattern"]);
  });

  it("counts production paths across repo roots; excludes .spec.ts, test dirs, and binary lines (mt#2781 R1)", async () => {
    const tasks: FakeTask[] = [{ id: "mt#204", status: "DONE" }];
    let tasksCreateCalled = false;

    // 3 production lines (src/, packages/, services/) + 5 excluded shapes.
    const output = [
      "src/foo.ts:10:const x = someSignal();",
      "packages/domain/src/bar.ts:20:const y = someSignal();",
      "services/reviewer/src/baz.ts:30:const z = someSignal();",
      "src/foo.spec.ts:1:const t = someSignal();", // .spec.ts excluded
      "tests/adapters/thing.ts:2:const t = someSignal();", // tests/ dir excluded
      "src/utils/test-utils/mocking.ts:3:const t = someSignal();", // test-utils/ excluded
      "docs/guide.md:4:someSignal usage", // non-.ts excluded
      "Binary file assets/blob.bin matches", // git-grep binary line ignored
    ].join("\n");

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;

      if (toolName === "tasks_list") return tasksListResponse(tasks);
      if (toolName === "tasks_spec_get") return specResponse(SPEC_WITH_FUNCTION_SIGNAL);
      if (toolName === "repo_search") return mcpResponse({ success: true, output });
      if (toolName === "tasks_create") {
        tasksCreateCalled = true;
        return tasksCreateResponse("should-not-be-created");
      }
      throw new Error(`Unexpected tool call: ${toolName}`);
    };

    const result = await runAdoptionSweep(BASE_DEPS);

    // 3 production callsites counted → adopted → no follow-up filed.
    expect(result.totalGapsFiled).toBe(0);
    expect(tasksCreateCalled).toBe(false);
  });

  it("counts mixed production+test matches by production lines only (mt#2781)", async () => {
    const tasks: FakeTask[] = [{ id: "mt#203", status: "DONE" }];
    let tasksCreateCalled = false;

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const toolName = body.params.name;

      if (toolName === "tasks_list") return tasksListResponse(tasks);
      if (toolName === "tasks_spec_get") return specResponse(SPEC_WITH_FUNCTION_SIGNAL);
      // 2 production + 5 test-file matches → count 2 → adopted, no follow-up.
      if (toolName === "repo_search") return repoSearchResponseWithTestFiles(2, 5);
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

      if (toolName === "tasks_list") return tasksListResponse(tasks);
      if (toolName === "tasks_search") {
        // Deduplication check: an adoption task already exists for this signal.
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

      if (toolName === "tasks_list") return tasksListResponse(tasks);
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

describe("runAdoptionSweep — lookback filter (PR #1034 R1 BLOCKING)", () => {
  it("passes `since` derived from lookbackDays to tasks_list", async () => {
    const tasks: FakeTask[] = [{ id: "mt#900", status: "DONE" }];
    let observedSince: string | undefined;

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      if (body.params.name === "tasks_list") {
        observedSince = body.params.arguments["since"] as string | undefined;
        return tasksListResponse(tasks);
      }
      if (body.params.name === "tasks_search") return tasksSearchEmptyResponse();
      if (body.params.name === "tasks_spec_get") return specResponse(SPEC_WITH_FUNCTION_SIGNAL);
      if (body.params.name === "repo_search") return repoSearchResponse(5);
      throw new Error(`Unexpected tool call: ${body.params.name}`);
    };

    await runAdoptionSweep({ ...BASE_DEPS, lookbackDays: 7 });

    expect(observedSince).toBeDefined();
    const sinceTs = Date.parse(observedSince as string);
    // eslint-disable-next-line custom/no-real-fs-in-tests -- timestamp comparison, not path
    const expectedTs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // Allow 60s slop for test execution time.
    expect(Math.abs(sinceTs - expectedTs)).toBeLessThan(60_000);
  });

  it("post-filters out tasks updated before the lookback window (backstop)", async () => {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- timestamp comparison, not path
    const oldUpdatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // eslint-disable-next-line custom/no-real-fs-in-tests -- timestamp comparison, not path
    const recentUpdatedAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const tasks: FakeTask[] = [
      { id: "mt#old", status: "DONE", updatedAt: oldUpdatedAt },
      { id: "mt#recent", status: "DONE", updatedAt: recentUpdatedAt },
    ];
    const processedTaskIds: string[] = [];

    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      if (body.params.name === "tasks_list") return tasksListResponse(tasks);
      if (body.params.name === "tasks_search") return tasksSearchEmptyResponse();
      if (body.params.name === "tasks_spec_get") {
        processedTaskIds.push(body.params.arguments["taskId"] as string);
        return specResponse(SPEC_NO_SIGNALS);
      }
      throw new Error(`Unexpected tool call: ${body.params.name}`);
    };

    const result = await runAdoptionSweep({ ...BASE_DEPS, lookbackDays: 14 });

    expect(result.tasksChecked).toBe(1); // only mt#recent survives post-filter
    expect(processedTaskIds).toContain("mt#recent");
    expect(processedTaskIds).not.toContain("mt#old");
  });
});

describe("runAdoptionSweep — error handling", () => {
  it("returns errors when tasks_list fails with no content", async () => {
    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string) as { params: { name: string } };
      if (body.params.name === "tasks_list") {
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

      if (toolName === "tasks_list") return tasksListResponse(tasks);
      if (toolName === "tasks_search") return tasksSearchEmptyResponse(); // dedup: no existing
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
