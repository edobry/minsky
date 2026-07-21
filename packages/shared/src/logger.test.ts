/**
 * Logger console-silence under the test harness (mt#2975).
 *
 * Regression guard for the CI build-log noise leak. Code across the repo imports
 * the canonical `@minsky/shared/logger` DIRECTLY (~380 files) — not the
 * `src/utils/logger` re-export that `tests/setup.ts` mocks — so the real winston
 * logger ran under test and its Console transport wrote error output (full JSON
 * stack traces) straight to stdout, bloating CI logs (one 2026-07-20 `build` job
 * log was 5.4 MB, dominated by ~120 `Failed to initialize PersistenceService`
 * stack traces).
 *
 * The fix: `createLogger` marks its winston Console transports `silent` when the
 * in-process test preload has set `TEST_LOGGER_SILENCED_FLAG` on `globalThis`.
 * Gated on that flag — NOT `NODE_ENV` — so a spawned subprocess (which never runs
 * the preload) keeps its own console output; see the logger's own docblock for
 * why that distinction is load-bearing. File transports and the `log.*` API are
 * unaffected.
 *
 * This verifies the `createLogger` half deterministically, both ways: with the
 * flag set every Console transport it builds is `silent` (winston short-circuits
 * a silent transport's write), and with the flag absent they are not. It toggles
 * the flag itself, so it is self-contained (no dependency on the preload) and does
 * NOT mutate global `process.stdout`/`process.stderr` — avoiding cross-test
 * interference and timing flakes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as winston from "winston";
import { createLogger, TEST_LOGGER_SILENCED_FLAG } from "@minsky/shared/logger";

const flagHolder = globalThis as Record<string, unknown>;

/** All winston Console transports across both underlying loggers. */
function consoleTransportsOf(logger: ReturnType<typeof createLogger>) {
  return [...logger._internal.agentLogger.transports, ...logger._internal.programLogger.transports]
    .filter((t) => t instanceof winston.transports.Console)
    .map((t) => t as unknown as { silent?: boolean });
}

// STRUCTURED + enableAgentLogs forces BOTH the agentLogger stdout Console and the
// programLogger Console to be added, so every Console transport is exercised.
const FULL_CONSOLE_CONFIG = { mode: "STRUCTURED", level: "info", enableAgentLogs: true } as const;

describe("logger console silence under the test harness (mt#2975)", () => {
  // Snapshot the preload-set flag and restore it after each test so this file
  // never leaks a toggled flag to test files that run later in the same process.
  const previousFlag = flagHolder[TEST_LOGGER_SILENCED_FLAG];
  afterEach(() => {
    flagHolder[TEST_LOGGER_SILENCED_FLAG] = previousFlag;
  });

  test("marks every Console transport silent when the harness flag is set", () => {
    flagHolder[TEST_LOGGER_SILENCED_FLAG] = true;

    const transports = consoleTransportsOf(createLogger(FULL_CONSOLE_CONFIG));

    expect(transports.length).toBeGreaterThan(0);
    expect(transports.every((t) => t.silent === true)).toBe(true);
  });

  test("leaves Console transports audible when the flag is absent (gating both ways)", () => {
    delete flagHolder[TEST_LOGGER_SILENCED_FLAG];

    const transports = consoleTransportsOf(createLogger(FULL_CONSOLE_CONFIG));

    expect(transports.length).toBeGreaterThan(0);
    expect(transports.some((t) => t.silent === true)).toBe(false);
  });
});
