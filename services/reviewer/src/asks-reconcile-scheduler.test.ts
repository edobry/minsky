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
import { captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";

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

/**
 * Capture log lines emitted by the reviewer-local winston logger (`./logger`)
 * during a synchronous callback, then restore. Lines are split on newlines
 * before being returned; callers parse each line as JSON when needed.
 *
 * Wraps the shared `captureConsoleLogs()` helper to keep the existing
 * call-site shape (single `logs` array per capture).
 */
function captureConsole(fn: () => void): { logs: string[]; warns: string[] } {
  const { logs, restore } = captureConsoleLogs();
  try {
    fn();
  } finally {
    restore();
  }
  // The winston logger writes all levels to stdout (the reviewer-local logger
  // sets `stderrLevels: []`), so warn-level events land in the same captured
  // stream as info-level events. Tests that previously inspected `warns`
  // separately can either keep that name (we return the same array) or
  // switch to inspecting `logs` directly.
  return { logs, warns: logs };
}

// ---------------------------------------------------------------------------
// Env var name constants (prevent magic-string-duplication lint warnings)
// ---------------------------------------------------------------------------

const ENV_ASKS_RECONCILE_ENABLED = "ASKS_RECONCILE_ENABLED";
const ENV_ASKS_RECONCILE_POLL_INTERVAL_MS = "ASKS_RECONCILE_POLL_INTERVAL_MS";
const ENV_MINSKY_MCP_URL = "MINSKY_MCP_URL";
const ENV_MINSKY_MCP_AUTH_TOKEN = "MINSKY_MCP_AUTH_TOKEN";

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
      ENV_MINSKY_MCP_AUTH_TOKEN,
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
    delete process.env[ENV_MINSKY_MCP_AUTH_TOKEN];

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

  test("reads MINSKY_MCP_URL and MINSKY_MCP_AUTH_TOKEN", () => {
    process.env[ENV_MINSKY_MCP_URL] = "http://mcp.example.com";
    process.env[ENV_MINSKY_MCP_AUTH_TOKEN] = "my-token";
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

    const { logs, restore } = captureConsoleLogs();
    try {
      handle = startAsksReconcileScheduler(BASE_REVIEWER_CONFIG, noCredsCfg);
      expect(handle).toBeNull();
    } finally {
      restore();
    }

    expect(findLogEvent(logs, "asks_reconcile_scheduler.missing_credentials")).not.toBeNull();
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
    // Cast required: Bun's fetch type includes `preconnect` property not present on plain async fns.
    globalThis.fetch = (async () => {
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
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (handle) {
      clearInterval(handle);
      handle = null;
    }
  });

  test("returns a non-null interval handle when enabled with credentials", () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      handle = startAsksReconcileScheduler(BASE_REVIEWER_CONFIG, ENABLED_SCHEDULER_CONFIG);
      expect(handle).not.toBeNull();
    } finally {
      restore();
    }

    expect(findLogEvent(logs, "asks_reconcile_scheduler.enabled")).not.toBeNull();
  });

  test("logs enabled event with intervalMs and mcpUrl", () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      handle = startAsksReconcileScheduler(BASE_REVIEWER_CONFIG, ENABLED_SCHEDULER_CONFIG);
    } finally {
      restore();
    }

    const parsed = findLogEvent(logs, "asks_reconcile_scheduler.enabled");
    expect(parsed).not.toBeNull();
    expect(parsed?.intervalMs).toBe(30_000);
    expect(parsed?.mcpUrl).toBe("http://localhost:4000");
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
    // Cast required: Bun's fetch type includes `preconnect` property not present on plain async fns.
    globalThis.fetch = (async () => {
      await new Promise<void>((resolve) => {
        fetchResolve = resolve;
      });
      return new Response(JSON.stringify({ result: { content: [{ text: "{}" }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const { logs, restore } = captureConsoleLogs();

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
      expect(findLogEvent(logs, "asks_reconcile_scheduler.tick.skipped_overlap")).not.toBeNull();
    } finally {
      restore();
      // Resolve the pending fetch to let the scheduler clean up.
      if (fetchResolve) (fetchResolve as () => void)();
    }
  });
});
