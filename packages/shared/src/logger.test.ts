/**
 * Logger console-silence under the test harness (mt#2975).
 *
 * Regression guard for the CI build-log noise leak. Code across the repo imports
 * the canonical `@minsky/shared/logger` DIRECTLY (197 non-test files in
 * `packages/`, 181 in `src/`) — not the `src/utils/logger` re-export that
 * `tests/setup.ts` mocks. So the real winston logger ran under test and its
 * Console transport wrote error-path output (message + full JSON stack) straight
 * to stdout, bloating CI logs (one 2026-07-20 `build` job log was 5.4 MB,
 * dominated by ~120 `Failed to initialize PersistenceService` stack traces).
 *
 * The fix marks `createLogger`'s Console transports `silent` under the test
 * harness (NODE_ENV=test, unless DEBUG_TESTS=1/DEBUG=1) — the logger stays fully
 * functional (levels, File transports, the `log.*` API) while emitting nothing to
 * stdout/stderr. This test asserts that suppression against the REAL, un-mocked
 * logger, exercising the exact `log.error(message, Error)` shape that flooded CI.
 *
 * Capture note: winston's Console transport writes via `console._stdout.write`
 * (which is the same object as `process.stdout` — verified), so we intercept by
 * reassigning `.write` on the real streams rather than via `spyOn` (which did not
 * intercept winston's write path under the harness), and flush a tick before
 * asserting.
 */
import { describe, test, expect } from "bun:test";
import { log, _resetDefaultLoggerForTests } from "@minsky/shared/logger";

type WriteFn = (chunk: unknown, ...rest: unknown[]) => boolean;

describe("logger console silence under the test harness (mt#2975)", () => {
  test("log.error on the real @minsky/shared/logger writes nothing to stdout/stderr", async () => {
    // Rebuild the singleton from the current env so we exercise the harness
    // (NODE_ENV=test) code path regardless of what a prior test installed.
    _resetDefaultLoggerForTests();

    const marker = "MT2975_LOGGER_LEAK_MARKER";
    const captured: string[] = [];
    const realStdout = process.stdout.write.bind(process.stdout) as WriteFn;
    const realStderr = process.stderr.write.bind(process.stderr) as WriteFn;
    const capture: WriteFn = (chunk) => {
      captured.push(String(chunk));
      return true;
    };

    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    try {
      // The exact shape that flooded CI: an error message plus an Error whose
      // stack winston would otherwise serialize to stdout.
      log.error(marker, new Error("mt#2975 probe error — must not reach stdout/stderr"));
      // winston delivers to its Console transport possibly across a tick — flush.
      await new Promise((r) => setTimeout(r, 25));
    } finally {
      process.stdout.write = realStdout as typeof process.stdout.write;
      process.stderr.write = realStderr as typeof process.stderr.write;
    }

    const leaked = captured.some((chunk) => chunk.includes(marker));
    expect(leaked).toBe(false);
  });
});
