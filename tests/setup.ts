import "reflect-metadata";
/**
 * Global Test Setup
 *
 * This file sets up global mocks and configuration for all tests.
 * It mocks the logger to prevent console output noise during test runs.
 */

// eslint-disable-next-line custom/no-real-fs-in-tests -- this is the test PRELOAD, not a test: it must create a REAL writable temp dir so any code path that writes Minsky state during tests lands somewhere harmless (a fake path would make fail-open writers degrade and change behavior under test)
import { mkdtempSync } from "node:fs";
// eslint-disable-next-line custom/no-real-fs-in-tests -- see above; mkdtempSync guarantees per-run uniqueness, no race
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";
import { mockLogger } from "../src/utils/test-utils/mock-logger";
import { TEST_LOGGER_SILENCED_FLAG } from "@minsky/shared/logger";
import { installClockShift } from "./clock-shift";

// Wall-clock offset (mt#4726). Installed FIRST in this file's body, before any other setup runs,
// so nothing here captures an unshifted `Date.now`. Inert unless MINSKY_TEST_CLOCK_SHIFT_DAYS is
// set — with the var unset this is a parse, a null, and a return, and every ordinary run is
// unaffected. Placed in the preload rather than behind a runner flag so it reaches every suite
// that already loads this file (`test`, `test:hooks`, `test:components`, `test:integration`);
// mt#4721's bomb lived in `.minsky/hooks`, which only `test:hooks` reaches.
const clockShift = installClockShift();
if (clockShift.active) {
  // Named on stdout so a shifted run is identifiable from the CI log alone. The runner does not
  // rely on this line — `scripts/run-tests-clock-shifted.ts` proves the offset independently
  // before it starts the suite (SC6) — but a human reading a failure needs the horizon here.
  process.stdout.write(`🕐 ${clockShift.summary} (mt#4726 clock-shifted run)\n`);
}

// State-dir isolation (mt#2872): any code path that resolves the Minsky state
// dir (guard-health log, disconnect log, caches) must NEVER touch the
// operator's real ~/.local/state/minsky during tests. A dispatcher test that
// exercised a throwing guard without overriding the default recorder wrote
// fixture rows (guard "throws", error "boom") into the REAL guard-health log,
// firing a CRITICAL operator escalation for a guard that doesn't exist.
// TWO variables, because there are two state-dir families and each reads a
// different one (mt#3965). ~10 hand-rolled resolvers read MINSKY_STATE_DIR
// inline; the shared `getMinskyStateDir()` in packages/shared/src/paths.ts
// reads XDG_STATE_HOME. Setting only the first left every consumer of the
// shared function — session paths, workspace resolution, the transcripts
// writers, the conversation pid-map — writing into the operator's REAL state
// dir on an ordinary `bun test`. That is not hypothetical: a fixture
// conversation id reached the production conversation-by-pid/ map, and the
// operator's next /clear turned it into a fabricated predecessor edge in
// mt#3943's transition log — 2 of the 13 records in a file that is meant to be
// evidence for the lineage design.
//
// Fixed here rather than by adding MINSKY_STATE_DIR to the shared resolver: it
// would then outrank the XDG_STATE_HOME override that 7 test files use for
// their own per-test isolation (mt#3415 and siblings), silently defeating the
// more specific override. Measured: 24 tests fail that way.
//
// Both are set only when the invoker has not — individual tests still set and
// restore their own for path-specific cases, and that must keep working.
// ONE temp root serves both, so a run leaves one directory behind rather than
// two (PR #2883 R1). They do not collide: the inline family writes directly
// under the root, and `getMinskyStateDir()` appends `minsky` to it. The root is
// created lazily — if the invoker already set both, none is made at all.
let isolatedStateRoot: string | undefined;
const stateRoot = (): string =>
  (isolatedStateRoot ??= mkdtempSync(join(tmpdir(), "minsky-test-state-")));

if (!process.env.MINSKY_STATE_DIR) {
  process.env.MINSKY_STATE_DIR = stateRoot();
}
if (!process.env.XDG_STATE_HOME) {
  process.env.XDG_STATE_HOME = stateRoot();
}

// Global test setup - logger mocks apply to all tests
// Use Bun's mock system to replace the logger module
// This prevents any console output during tests while preserving logging functionality
mock.module("../src/utils/logger", () => ({
  log: {
    ...mockLogger,
    info: mock(() => {}),
    cli: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
  createConfigurableLogger: () => mockLogger,
  createLogger: () => mockLogger,
  isStructuredMode: () => false,
  isHumanMode: () => true,
}));

// Mock additional relative paths to the logger
mock.module("../../utils/logger", () => ({
  log: {
    ...mockLogger,
    info: mock(() => {}),
    cli: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
  createConfigurableLogger: () => mockLogger,
  createLogger: () => mockLogger,
  isStructuredMode: () => false,
  isHumanMode: () => true,
}));

mock.module("../../../utils/logger", () => ({
  log: {
    ...mockLogger,
    info: mock(() => {}),
    cli: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
  createConfigurableLogger: () => mockLogger,
  createLogger: () => mockLogger,
  isStructuredMode: () => false,
  isHumanMode: () => true,
}));

// Mock utils/logger from different directory levels
mock.module("../../src/utils/logger", () => ({
  log: {
    ...mockLogger,
    info: mock(() => {}),
    cli: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
  createConfigurableLogger: () => mockLogger,
  createLogger: () => mockLogger,
  isStructuredMode: () => false,
  isHumanMode: () => true,
}));

// Set up global test environment variables
process.env.NODE_ENV = "test";
process.env.MINSKY_LOG_LEVEL = "error";
process.env.MINSKY_LOG_MODE = "STRUCTURED";

// Check for debug mode to bypass console mocking
const isDebugMode = process.env.DEBUG_TESTS === "1" || process.env.DEBUG === "1";

if (isDebugMode) {
  process.stdout.write("🐛 DEBUG MODE: Console mocking disabled for debugging\n");
} else {
  // Print setup message before mocking console
  process.stdout.write(
    "🔇 Global test setup: Logger and console mocked to prevent output during tests\n"
  );

  // mt#2975: request the shared logger silence its winston Console transports
  // for THIS in-process harness only. A globalThis flag (unlike an env var) does
  // not cross into subprocesses that tests spawn via child_process — those run
  // the real CLI without this preload, so their startup logs (e.g. the MCP
  // "Ready to receive MCP requests via HTTP" readiness marker that
  // start-command.test.ts waits for) still reach stdout.
  (globalThis as Record<string, unknown>)[TEST_LOGGER_SILENCED_FLAG] = true;

  // Mock the console methods globally to prevent any console output during tests
  const _originalConsole = { ...console };
  console.log = mock(() => {});
  console.info = mock(() => {});
  console.warn = mock(() => {});
  console.error = mock(() => {});
  console.debug = mock(() => {});
}

// Export mock logger utilities for tests that need to verify logging behavior
export {
  mockLogger,
  resetMockLogger,
  wasMessageLogged,
  getLoggedErrors,
  getLoggedWarnings,
} from "../src/utils/test-utils/mock-logger";
