/**
 * Tests for asks-reconcile-scheduler.ts.
 *
 * Strategy:
 *   - loadAsksReconcileSchedulerConfig() reflects process.env correctly.
 *   - startAsksReconcileScheduler() logs disabled/enabled events.
 *   - Reentrancy guard: a second interval tick is skipped while the first is running.
 *   - Timer is returned as a clearable handle when enabled.
 *
 * All tests avoid calling the real fetch (no HTTP calls) by patching the global
 * fetch. The scheduler's setInterval handle is cleared after each test to
 * prevent timer leaks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReviewerConfig } from "./config";
import {
  loadAsksReconcileSchedulerConfig,
  startAsksReconcileScheduler,
  type AsksReconcileSchedulerConfig,
} from "./asks-reconcile-scheduler";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const BASE_REVIEWER_CONFIG: ReviewerConfig = {
  appId: 1,
  privateKey: "",
  installationId: 1,
  webhookSecret: "test-secret",
  provider: "openai",
  providerApiKey: "sk-fake",
  providerModel: "gpt-5",
  tier2Enabled: false,
  mcpUrl: "http://localhost:4000",
  mcpToken: "test-token",
  port: 0,
  logLevel: "info",
  modelTimeoutMs: 120_000,
  githubTimeoutMs: 30_000,
};

const ENABLED_SCHEDULER_CONFIG: AsksReconcileSchedulerConfig = {
  intervalMs: 30_000,
  enabled: true,
  mcpUrl: "http://localhost:4000",
  mcpToken: "test-token",
};

const DISABLED_SCHEDULER_CONFIG: AsksReconcileSchedulerConfig = {
  intervalMs: 30_000,
  enabled: false,
  mcpUrl: "",
  mcpToken: "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture console output for a synchronous callback, then restore. */
function captureConsole(fn: () => void): { logs: string[]; warns: string[] } {
  const logs: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return { logs, warns };
}

// ---------------------------------------------------------------------------
// Env var name constants (prevent magic-string-duplication lint warnings)
// ---------------------------------------------------------------------------

const ENV_ASKS_RECONCILE_ENABLED = "ASKS_RECONCILE_ENABLED";
const ENV_ASKS_RECONCILE_POLL_INTERVAL_MS = "ASKS_RECONCILE_POLL_INTERVAL_MS";
const ENV_MINSKY_MCP_URL = "MINSKY_MCP_URL";
const ENV_MINSKY_MCP_TOKEN = "MINSKY_MCP_TOKEN";

// ---------------------------------------------------------------------------
// loadAsksReconcileSchedulerConfig
// ---------------------------------------------------------------------------

describe("loadAsksReconcileSchedulerConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore env vars
    for (const key of [
      ENV_ASKS_RECONCILE_ENABLED,
      ENV_ASKS_RECONCILE_POLL_INTERVAL_MS,
      ENV_MINSKY_MCP_URL,
      ENV_MINSKY_MCP_TOKEN,
    ]) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test("defaults: disabled, 30s interval, empty MCP creds", () => {
    delete process.env[ENV_ASKS_RECONCILE_ENABLED];
    delete process.env[ENV_ASKS_RECONCILE_POLL_INTERVAL_MS];
    delete process.env[ENV_MINSKY_MCP_URL];
    delete process.env[ENV_MINSKY_MCP_TOKEN];

    const cfg = loadAsksReconcileSchedulerConfig();

    expect(cfg.enabled).toBe(false);
    expect(cfg.intervalMs).toBe(30_000);
    expect(cfg.mcpUrl).toBe("");
    expect(cfg.mcpToken).toBe("");
  });

  test("reads ASKS_RECONCILE_ENABLED=true", () => {
    process.env[ENV_ASKS_RECONCILE_ENABLED] = "true";
    const cfg = loadAsksReconcileSchedulerConfig();
    expect(cfg.enabled).toBe(true);
  });

  test("reads custom ASKS_RECONCILE_POLL_INTERVAL_MS", () => {
    process.env[ENV_ASKS_RECONCILE_POLL_INTERVAL_MS] = "60000";
    const cfg = loadAsksReconcileSchedulerConfig();
    expect(cfg.intervalMs).toBe(60_000);
  });

  test("reads MINSKY_MCP_URL and MINSKY_MCP_TOKEN", () => {
    process.env[ENV_MINSKY_MCP_URL] = "http://mcp.example.com";
    process.env[ENV_MINSKY_MCP_TOKEN] = "my-token";
    const cfg = loadAsksReconcileSchedulerConfig();
    expect(cfg.mcpUrl).toBe("http://mcp.example.com");
    expect(cfg.mcpToken).toBe("my-token");
  });
});

// ---------------------------------------------------------------------------
// startAsksReconcileScheduler — disabled path
// ---------------------------------------------------------------------------

describe("startAsksReconcileScheduler — disabled", () => {
  test("returns null and logs disabled event when enabled=false", () => {
    const { logs } = captureConsole(() => {
      const handle = startAsksReconcileScheduler(BASE_REVIEWER_CONFIG, DISABLED_SCHEDULER_CONFIG);
      expect(handle).toBeNull();
    });
    const disabledLog = logs.find((l) => l.includes("asks_reconcile_scheduler.disabled"));
    expect(disabledLog).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// startAsksReconcileScheduler — missing credentials
// ---------------------------------------------------------------------------

describe("startAsksReconcileScheduler — missing credentials", () => {
  let handle: ReturnType<typeof setInterval> | null = null;

  afterEach(() => {
    if (handle) {
      clearInterval(handle);
      handle = null;
    }
  });

  test("returns null and warns when credentials missing", () => {
    const noCredsCfg: AsksReconcileSchedulerConfig = {
      ...ENABLED_SCHEDULER_CONFIG,
      mcpUrl: "",
      mcpToken: "",
    };

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
    try {
      handle = startAsksReconcileScheduler(BASE_REVIEWER_CONFIG, noCredsCfg);
      expect(handle).toBeNull();
    } finally {
      console.warn = origWarn;
    }

    const credWarn = warns.find((w) => w.includes("asks_reconcile_scheduler.missing_credentials"));
    expect(credWarn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// startAsksReconcileScheduler — enabled path
// ---------------------------------------------------------------------------

describe("startAsksReconcileScheduler — enabled", () => {
  let handle: ReturnType<typeof setInterval> | null = null;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Replace global fetch with a stub that returns a successful MCP response.
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          result: {
            content: [
              {
                text: JSON.stringify({ inspected: 2, responded: 1, errors: 0 }),
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (handle) {
      clearInterval(handle);
      handle = null;
    }
  });

  test("returns a non-null interval handle when enabled with credentials", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      handle = startAsksReconcileScheduler(BASE_REVIEWER_CONFIG, ENABLED_SCHEDULER_CONFIG);
      expect(handle).not.toBeNull();
    } finally {
      console.log = origLog;
    }

    const enabledLog = logs.find((l) => l.includes("asks_reconcile_scheduler.enabled"));
    expect(enabledLog).toBeDefined();
  });

  test("logs enabled event with intervalMs and mcpUrl", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      handle = startAsksReconcileScheduler(BASE_REVIEWER_CONFIG, ENABLED_SCHEDULER_CONFIG);
    } finally {
      console.log = origLog;
    }

    const enabledLog = logs.find((l) => l.includes("asks_reconcile_scheduler.enabled"));
    expect(enabledLog).toBeDefined();

    const parsed = JSON.parse(enabledLog ?? "{}") as { intervalMs?: number; mcpUrl?: string };
    expect(parsed.intervalMs).toBe(30_000);
    expect(parsed.mcpUrl).toBe("http://localhost:4000");
  });
});

// ---------------------------------------------------------------------------
// Reentrancy guard
// ---------------------------------------------------------------------------

describe("startAsksReconcileScheduler — reentrancy guard", () => {
  let handle: ReturnType<typeof setInterval> | null = null;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (handle) {
      clearInterval(handle);
      handle = null;
    }
  });

  test("skips tick with skipped_overlap event when previous tick still running", async () => {
    // Simulate a slow MCP call that never resolves during the test window.
    let fetchResolve: (() => void) | null = null;
    globalThis.fetch = async () => {
      await new Promise<void>((resolve) => {
        fetchResolve = resolve;
      });
      return new Response(JSON.stringify({ result: { content: [{ text: "{}" }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const warns: string[] = [];
    const logs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    // Use a very short interval so the second tick fires quickly.
    const fastCfg: AsksReconcileSchedulerConfig = {
      ...ENABLED_SCHEDULER_CONFIG,
      intervalMs: 20,
    };

    try {
      handle = startAsksReconcileScheduler(BASE_REVIEWER_CONFIG, fastCfg);

      // Wait long enough for at least two ticks to fire.
      await new Promise((resolve) => setTimeout(resolve, 80));

      // The second (and subsequent) ticks should be skipped because the first
      // tick's fetch is still "running" (fetchResolve is not yet called).
      const skippedLog = warns.find((w) =>
        w.includes("asks_reconcile_scheduler.tick.skipped_overlap")
      );
      expect(skippedLog).toBeDefined();
    } finally {
      console.warn = origWarn;
      console.log = origLog;
      // Resolve the pending fetch to let the scheduler clean up.
      if (fetchResolve) (fetchResolve as () => void)();
    }
  });
});
