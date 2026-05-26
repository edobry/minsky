/**
 * Tests for asks-reconcile-scheduler.ts (mt#2121 — migrated from MCP-over-HTTP
 * to direct domain imports).
 *
 * Strategy:
 *   - loadAsksReconcileSchedulerConfig() reflects process.env correctly.
 *   - startAsksReconcileScheduler() logs disabled/enabled events.
 *   - Reentrancy guard: a second interval tick is skipped while the first is running.
 *   - Timer is returned as a clearable handle when enabled.
 *
 * No HTTP calls are made — the scheduler uses domain container injection directly.
 * The scheduler's setInterval handle is cleared after each test to prevent timer leaks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReviewerConfig } from "./config";
import {
  loadAsksReconcileSchedulerConfig,
  startAsksReconcileScheduler,
  type AsksReconcileSchedulerConfig,
} from "./asks-reconcile-scheduler";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
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
  mcpUrl: undefined,
  mcpToken: undefined,
  port: 0,
  logLevel: "info",
  modelTimeoutMs: 120_000,
  githubTimeoutMs: 30_000,
};

const ENABLED_SCHEDULER_CONFIG: AsksReconcileSchedulerConfig = {
  intervalMs: 30_000,
  enabled: true,
};

const DISABLED_SCHEDULER_CONFIG: AsksReconcileSchedulerConfig = {
  intervalMs: 30_000,
  enabled: false,
};

// ---------------------------------------------------------------------------
// Fake domain container
// ---------------------------------------------------------------------------

/**
 * A minimal fake AppContainerInterface. The scheduler only calls `container.get()`
 * inside `runAsksReconcileDomain` — but since those calls happen async inside the
 * interval tick (not at schedule-time), we can provide a container that stubs
 * the get() method for lifecycle tests without a real DB.
 */
function makeFakeContainer(): AppContainerInterface {
  return {
    get: (_token: unknown) => {
      throw new Error("fake container: get() not implemented for tests");
    },
    initialize: async () => {},
  } as unknown as AppContainerInterface;
}

/**
 * A fake container whose get("persistence") blocks forever — used to test
 * the reentrancy guard without a real DB connection.
 */
function makeBlockingContainer(): AppContainerInterface {
  return {
    get: (_token: unknown) => {
      // Returns a fake persistence provider whose getDatabaseConnection never resolves.
      return {
        getDatabaseConnection: () => new Promise(() => {}), // never resolves
      };
    },
    initialize: async () => {},
  } as unknown as AppContainerInterface;
}

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

// ---------------------------------------------------------------------------
// loadAsksReconcileSchedulerConfig
// ---------------------------------------------------------------------------

describe("loadAsksReconcileSchedulerConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of [ENV_ASKS_RECONCILE_ENABLED, ENV_ASKS_RECONCILE_POLL_INTERVAL_MS]) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test("defaults: disabled, 30s interval", () => {
    delete process.env[ENV_ASKS_RECONCILE_ENABLED];
    delete process.env[ENV_ASKS_RECONCILE_POLL_INTERVAL_MS];

    const cfg = loadAsksReconcileSchedulerConfig();

    expect(cfg.enabled).toBe(false);
    expect(cfg.intervalMs).toBe(30_000);
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
// startAsksReconcileScheduler — missing domain container
// ---------------------------------------------------------------------------

describe("startAsksReconcileScheduler — missing domain container", () => {
  let handle: ReturnType<typeof setInterval> | null = null;

  afterEach(() => {
    if (handle) {
      clearInterval(handle);
      handle = null;
    }
  });

  test("returns null and warns when domain container not provided", () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      // No container passed — scheduler should refuse to start.
      handle = startAsksReconcileScheduler(BASE_REVIEWER_CONFIG, ENABLED_SCHEDULER_CONFIG);
      expect(handle).toBeNull();
    } finally {
      restore();
    }

    expect(findLogEvent(logs, "asks_reconcile_scheduler.missing_domain_container")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startAsksReconcileScheduler — enabled path
// ---------------------------------------------------------------------------

describe("startAsksReconcileScheduler — enabled", () => {
  let handle: ReturnType<typeof setInterval> | null = null;

  afterEach(() => {
    if (handle) {
      clearInterval(handle);
      handle = null;
    }
  });

  test("returns a non-null interval handle when enabled with domain container", () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      handle = startAsksReconcileScheduler(
        BASE_REVIEWER_CONFIG,
        ENABLED_SCHEDULER_CONFIG,
        makeFakeContainer()
      );
      expect(handle).not.toBeNull();
    } finally {
      restore();
    }

    expect(findLogEvent(logs, "asks_reconcile_scheduler.enabled")).not.toBeNull();
  });

  test("logs enabled event with intervalMs", () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      handle = startAsksReconcileScheduler(
        BASE_REVIEWER_CONFIG,
        ENABLED_SCHEDULER_CONFIG,
        makeFakeContainer()
      );
    } finally {
      restore();
    }

    const parsed = findLogEvent(logs, "asks_reconcile_scheduler.enabled");
    expect(parsed).not.toBeNull();
    expect(parsed?.intervalMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Reentrancy guard
// ---------------------------------------------------------------------------

describe("startAsksReconcileScheduler — reentrancy guard", () => {
  let handle: ReturnType<typeof setInterval> | null = null;

  afterEach(() => {
    if (handle) {
      clearInterval(handle);
      handle = null;
    }
  });

  test("skips tick with skipped_overlap event when previous tick still running", async () => {
    // Use a blocking container so the first tick's domain call never completes
    // during the test window, leaving isRunning=true when the second tick fires.
    const { logs, restore } = captureConsoleLogs();

    // Use a very short interval so the second tick fires quickly.
    const fastCfg: AsksReconcileSchedulerConfig = {
      ...ENABLED_SCHEDULER_CONFIG,
      intervalMs: 20,
    };

    try {
      handle = startAsksReconcileScheduler(BASE_REVIEWER_CONFIG, fastCfg, makeBlockingContainer());

      // Wait long enough for at least two ticks to fire.
      await new Promise((resolve) => setTimeout(resolve, 80));

      // The second (and subsequent) ticks should be skipped because the first
      // tick's domain call is still "running" (makeBlockingContainer never resolves).
      expect(findLogEvent(logs, "asks_reconcile_scheduler.tick.skipped_overlap")).not.toBeNull();
    } finally {
      restore();
    }
  });
});
