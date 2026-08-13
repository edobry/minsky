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
import {
  createLogger,
  getCliOutputLineCount,
  getProcessRole,
  log,
  LogMode,
  resolveDiagnosticSink,
  setProcessRole,
  TEST_LOGGER_SILENCED_FLAG,
} from "@minsky/shared/logger";

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

/**
 * Visible-CLI-output line counter (mt#3870).
 *
 * The CLI bridge reads this counter around `execute` to tell "this command
 * printed its own report" from "this command printed nothing", which decides
 * whether the generic result formatter renders the payload's keys. Both
 * directions matter and fail differently:
 *
 * - Miss a channel a command actually reports through, and the formatter dumps
 *   the payload underneath the report — printing the findings twice. PR #2840
 *   R1 caught exactly that for `cliWarn` / `cliError`.
 * - Count a channel the operator never sees, and the formatter suppresses the
 *   payload for output nobody read — reinstating the discard the counter exists
 *   to fix. That is why `cliDebug` must stay uncounted.
 */
describe("visible-CLI-output line counter", () => {
  test("counts every channel that writes unconditionally", () => {
    const before = getCliOutputLineCount();

    log.cli("a report line");
    log.cliWarn("a warning line");
    log.cliError("an error line");

    expect(getCliOutputLineCount() - before).toBe(3);
  });

  test("does not count cliDebug, which is filtered out at normal verbosity", () => {
    const before = getCliOutputLineCount();

    log.cliDebug("a debug line");

    expect(getCliOutputLineCount() - before).toBe(0);
  });
});

/**
 * Domain-channel diagnostic routing (mt#2464).
 *
 * Before this, HUMAN mode without `ENABLE_AGENT_LOGS` made `log.debug`/`log.info`/`log.warn` a
 * complete no-op — no transport, no stream. At a terminal that is the intent; in a deployed
 * container it meant boot diagnostics were never written anywhere, so the deploy log showed
 * nothing but `Starting Container` and the reported symptom looked like a platform-ingest problem.
 *
 * Two claims are worth separating, and they are verified in different places:
 *
 * - The DECISION — which sink applies — is a pure function, exercised here across its full truth
 *   table with no globals touched.
 * - The STREAM — that a line actually lands on fd 2 and never fd 1 — is a claim about real file
 *   descriptors, and asserting it from inside this process would mean patching
 *   `process.stdout.write`. `scripts/verify-diagnostic-sink.ts` owns it instead, by spawning a
 *   child with piped stdio (the same non-TTY condition a container has) and reading both streams.
 *   Re-checking `stderrLevels` here would only restate the source.
 *
 * What is left for this file is the join between them: that `createLogger` actually CONSUMES the
 * pure function rather than reimplementing the choice inline.
 */
describe("domain-channel diagnostic routing (mt#2464)", () => {
  describe("resolveDiagnosticSink", () => {
    test("sends everything to the structured stdout logger in STRUCTURED mode", () => {
      for (const stderrIsTerminal of [true, false]) {
        expect(
          resolveDiagnosticSink({
            mode: LogMode.STRUCTURED,
            enableAgentLogs: false,
            stderrIsTerminal,
          })
        ).toBe("agent");
      }
    });

    test("honors ENABLE_AGENT_LOGS in HUMAN mode, terminal or not", () => {
      for (const stderrIsTerminal of [true, false]) {
        expect(
          resolveDiagnosticSink({
            mode: LogMode.HUMAN,
            enableAgentLogs: true,
            stderrIsTerminal,
          })
        ).toBe("agent");
      }
    });

    test("stays quiet when a person is reading stderr — today's CLI behavior, preserved", () => {
      expect(
        resolveDiagnosticSink({
          mode: LogMode.HUMAN,
          enableAgentLogs: false,
          stderrIsTerminal: true,
        })
      ).toBe("discard");
    });

    test("routes to stderr when stderr is captured — the case that was silently discarded", () => {
      expect(
        resolveDiagnosticSink({
          mode: LogMode.HUMAN,
          enableAgentLogs: false,
          stderrIsTerminal: false,
        })
      ).toBe("stderr");
    });

    // A scripted `minsky ...` run has captured stderr too, and is NOT a container. The regression
    // this prevents is concrete: `minsky security check-credentials --quiet` documents that it
    // prints nothing on any path, and its end-to-end tests assert `stdout === "" && stderr === ""`.
    // Bootstrap chatter on its stderr breaks that contract regardless of which subsystem emitted
    // it, so a one-shot command discards even with stderr captured.
    test("a one-shot CLI command stays silent even with stderr captured", () => {
      expect(
        resolveDiagnosticSink({
          mode: LogMode.HUMAN,
          enableAgentLogs: false,
          stderrIsTerminal: false,
          oneShotCommand: true,
        })
      ).toBe("discard");
    });

    // An explicit mode request outranks the role: someone who set MINSKY_LOG_MODE=STRUCTURED asked
    // for machine-readable output and must get it, CLI or not.
    test("an explicit STRUCTURED request outranks the one-shot role", () => {
      expect(
        resolveDiagnosticSink({
          mode: LogMode.STRUCTURED,
          enableAgentLogs: false,
          stderrIsTerminal: false,
          oneShotCommand: true,
        })
      ).toBe("agent");
    });
  });

  describe("process role", () => {
    const realRole = getProcessRole();
    afterEach(() => {
      setProcessRole(realRole);
    });

    // The default matters on its own: an entry point that declares nothing must end up VISIBLE.
    // Silence-by-default is the failure this task removes, so it must not be reachable by omission.
    test("defaults to long-running-service, so an undeclared process is visible", () => {
      expect(realRole).toBe("long-running-service");
    });

    test("a declared one-shot role reaches the wired logger", () => {
      const realStderrIsTty = process.stderr.isTTY;
      process.stderr.isTTY = false;
      try {
        setProcessRole("one-shot-command");
        expect(
          createLogger({ mode: "HUMAN", level: "info", enableAgentLogs: false }).diagnosticSink
        ).toBe("discard");

        setProcessRole("long-running-service");
        expect(
          createLogger({ mode: "HUMAN", level: "info", enableAgentLogs: false }).diagnosticSink
        ).toBe("stderr");
      } finally {
        process.stderr.isTTY = realStderrIsTty;
      }
    });
  });

  describe("createLogger wiring", () => {
    // Single boolean properties, saved and restored — production code reads the real `isTTY`, so
    // the test exercises the real read rather than a parallel injection path.
    const realStdoutIsTty = process.stdout.isTTY;
    const realStderrIsTty = process.stderr.isTTY;
    afterEach(() => {
      process.stdout.isTTY = realStdoutIsTty;
      process.stderr.isTTY = realStderrIsTty;
    });

    const HUMAN_CONFIG = { mode: "HUMAN", level: "info", enableAgentLogs: false } as const;

    test("wires the stderr sink when stderr is captured", () => {
      process.stderr.isTTY = false;

      expect(createLogger(HUMAN_CONFIG).diagnosticSink).toBe("stderr");
    });

    test("wires the discard sink when stderr is a terminal", () => {
      process.stderr.isTTY = true;

      expect(createLogger(HUMAN_CONFIG).diagnosticSink).toBe("discard");
    });

    // The `cmd | jq` shape, which is the whole reason the test keys on stderr. A stdout-keyed
    // check would classify this as "no terminal" and start printing at an operator who is
    // watching — regressing a case that is quiet today, for no gain.
    test("stays quiet when only STDOUT is piped and the operator still sees stderr", () => {
      process.stdout.isTTY = false;
      process.stderr.isTTY = true;

      expect(createLogger(HUMAN_CONFIG).diagnosticSink).toBe("discard");
    });

    test("STRUCTURED mode still wires the agent sink with stderr captured", () => {
      process.stderr.isTTY = false;

      expect(
        createLogger({ mode: "STRUCTURED", level: "info", enableAgentLogs: false }).diagnosticSink
      ).toBe("agent");
    });
  });
});
