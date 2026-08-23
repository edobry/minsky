import * as winston from "winston";
const { format, transports } = winston;
import type {} from "logform";

// Removed config dependency to avoid circular imports - logger should be independently configurable

// Logger configuration interface
export interface LoggerConfig {
  mode: "HUMAN" | "STRUCTURED" | "auto";
  level: "debug" | "info" | "warn" | "error";
  enableAgentLogs: boolean;
}

// Log context interface
export type LogContext = Record<string, unknown>;

// Environment variable for log mode
// STRUCTURED: Full JSON logs for machine consumption (for CI/CD, integrations)
// HUMAN: Clean, human-readable logs only (default for CLI usage)
export enum LogMode {
  STRUCTURED = "STRUCTURED",
  HUMAN = "HUMAN",
}

/**
 * Get logger configuration from environment variables and CLI options only
 * No dependency on application config system to avoid circular imports
 */
function getLoggerConfig(): LoggerConfig {
  const envMode = process.env.MINSKY_LOG_MODE || "auto";
  const envLevel = process.env.LOGLEVEL || "info";
  const envAgentLogs = process.env.ENABLE_AGENT_LOGS === "true";

  return {
    mode: envMode as "HUMAN" | "STRUCTURED" | "auto",
    level: envLevel as "debug" | "info" | "warn" | "error",
    enableAgentLogs: envAgentLogs,
  };
}

/**
 * globalThis flag set ONLY by the in-process test preload (`tests/setup.ts`) to
 * request Console silencing (mt#2975). Exported so the preload and this module
 * share one source of truth for the key.
 */
export const TEST_LOGGER_SILENCED_FLAG = "__MINSKY_TEST_LOGGER_SILENCED__";

/**
 * Whether winston Console transports should be silenced (mt#2975).
 *
 * Under the in-process test harness the real winston logger would otherwise
 * write error-path output — full JSON stack traces — to stdout, because most
 * code imports this canonical `@minsky/shared/logger` directly rather than the
 * `src/utils/logger` re-export that the harness mocks. That flooded CI build
 * logs (mt#2975: one 2026-07-20 `build` log was 5.4 MB, dominated by ~120
 * `Failed to initialize PersistenceService` stack traces).
 *
 * Gated on a globalThis flag that ONLY `tests/setup.ts` sets — deliberately NOT
 * on `NODE_ENV=test`. Integration tests spawn the real CLI as a subprocess with
 * `env: { ...process.env }`, so `NODE_ENV=test` INHERITS into that child; a
 * NODE_ENV gate would then silence the child's own startup logs — e.g. the
 * `"Ready to receive MCP requests via HTTP"` readiness marker in
 * `src/commands/mcp/start-command.ts` that `start-command.test.ts` waits for on
 * the child's stdout — hanging the test. A globalThis flag does NOT cross the
 * process boundary: a spawned child never runs the preload, so it keeps its
 * console output while the in-process harness stays quiet. `DEBUG_TESTS=1` /
 * `DEBUG=1` make the preload skip setting the flag (the same escape hatch it
 * uses to un-mock console), restoring console output for local debugging.
 *
 * Silencing ONLY the Console transports keeps the logger fully functional
 * (levels, the `log.*` API, and File transports) — the cockpit daemon rotating
 * File-transport test (`src/cockpit/daemon-file-log.test.ts`) is unaffected
 * because it asserts on File content. Prod/Railway/CLI never run the preload, so
 * their console output is unchanged.
 */
function isTestHarnessConsoleSilent(): boolean {
  return (globalThis as Record<string, unknown>)[TEST_LOGGER_SILENCED_FLAG] === true;
}

/**
 * Where a domain-channel log call (`log.debug` / `log.info` / `log.warn`) should go.
 *
 * - `agent`   — the structured JSON logger on **stdout**. STRUCTURED mode, or HUMAN mode with
 *               `ENABLE_AGENT_LOGS=true`.
 * - `stderr`  — plain text on **stderr**. HUMAN mode when stderr is being captured.
 * - `discard` — dropped. HUMAN mode when stderr is a terminal a person is reading.
 */
export type DiagnosticSink = "agent" | "stderr" | "discard";

/**
 * Resolve where domain-channel diagnostics go (mt#2464).
 *
 * Pure, so the whole behavioral rule is testable without a TTY, a transport, or a spy.
 *
 * Until mt#2464 the HUMAN-mode branch was a bare `return` — `log.info`/`log.warn`/`log.debug`
 * reached no transport at all. That is invisible at a terminal (where silence is the point) and a
 * defect everywhere else: in a deployed container it meant boot diagnostics were never written to
 * any stream, so nothing could ingest them. The reported symptom was "domain-logger lines are
 * missing from Railway's deploy log"; the actual mechanism was that they were never emitted.
 * `log.error` always had the stderr fallback below, which is why an error and the warn beside it
 * behaved differently in the same boot (mt#2463).
 *
 * **`stderr`, not stdout, and this is load-bearing.** Routing to the structured stdout logger
 * would corrupt two channels that own stdout: a piped CLI payload (`... --json | jq`), and the MCP
 * **stdio** transport, whose JSON-RPC protocol stream IS stdout and is never a TTY. stderr collides
 * with neither and is ingested by the deploy-log surface just the same — the one line that DID
 * survive the mt#2463 boot was a stderr write.
 *
 * **The test is on STDERR's terminal-ness, not stdout's**, and the difference is the entire CLI
 * blast radius. The question this answers is "would a person have to read these lines, or is
 * something capturing them?" — so it must be asked of the stream they would be written to. Under
 * `minsky ... | jq`, stdout is a pipe but stderr is still the operator's terminal; keying on stdout
 * would start printing boot chatter at them for a command that is quiet today (measured on mt#2464:
 * 3 new lines on a plain `tasks list`). Keying on stderr keeps every interactive shape exactly as
 * quiet as it is now, and still fires for the cases that motivated this — a container, CI, a
 * supervised daemon, an MCP stdio child — where stderr is a pipe or a file and discarding is pure
 * loss.
 */
export function resolveDiagnosticSink(params: {
  mode: LogMode;
  enableAgentLogs: boolean;
  stderrIsTerminal: boolean;
  /**
   * True for a CLI invocation that runs one command and exits. Such a process's streams belong to
   * the command: `minsky security check-credentials --quiet` documents that it prints NOTHING on
   * any path, and bootstrap chatter appearing on its stderr breaks that contract no matter which
   * subsystem emitted it. Long-running services are the opposite case — their diagnostics are the
   * only record anyone gets.
   *
   * Defaults to false, so the emitting behavior is what a process gets by DEFAULT and silence is
   * what must be asked for. A new service that declares nothing is visible; only the CLI, which
   * declares it once at its entry point, is quiet.
   */
  oneShotCommand?: boolean;
}): DiagnosticSink {
  if (params.mode === LogMode.STRUCTURED || params.enableAgentLogs) {
    return "agent";
  }
  if (params.oneShotCommand) {
    return "discard";
  }
  return params.stderrIsTerminal ? "discard" : "stderr";
}

/**
 * What kind of process this is, for the purpose of the rule above.
 *
 * `long-running-service` is the default precisely because forgetting to declare a role should leave
 * a process VISIBLE rather than silent — silence is the failure mode mt#2464 exists to remove. The
 * CLI declares `one-shot-command` at its entry point; the `start` subcommands that are themselves
 * long-running servers declare their way back.
 */
export type ProcessRole = "one-shot-command" | "long-running-service";

let processRole: ProcessRole = "long-running-service";

/**
 * Declare this process's role. Rebuilds the shared logger so the change applies to the next
 * `log.*` call, including on a singleton some earlier import already initialized.
 */
export function setProcessRole(role: ProcessRole): void {
  processRole = role;
  defaultLogger = null;
}

/** The role currently declared. Exported for tests and diagnostics. */
export function getProcessRole(): ProcessRole {
  return processRole;
}

/**
 * Whether this process's stderr is a terminal — i.e. whether a person is positioned to read what
 * the diagnostic sink writes. See `resolveDiagnosticSink` for why this asks about stderr.
 *
 * Read at logger-construction time, alongside mode and level, so all three are captured together.
 */
function stderrIsTerminal(): boolean {
  return Boolean(process.stderr.isTTY);
}

/** Keys the diagnostic renderer prints positionally rather than as trailing context. */
const DIAGNOSTIC_RESERVED_KEYS = ["level", "message", "timestamp", "stack"];

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    // intentional-swallow: a value that will not serialize must not take down the log call that
    // was trying to report something else. Callers fall back to a non-JSON rendering.
    return undefined;
  }
}

/**
 * Render one diagnostic line as `<level>: <message>`, with any context appended as compact JSON.
 *
 * The level prefix is not decoration. A platform log surface derives severity from the STREAM, so
 * everything routed here arrives under a single severity: Railway's docs state that it captures
 * stdout and stderr, and that "logs emitted to stderr will be converted to level.error and coloured
 * red" (https://docs.railway.com/observability/logs). Once a line lands there, this prefix is the
 * only thing distinguishing a warn from an info.
 *
 * Plain text rather than single-line JSON is a deliberate trade. Railway WOULD parse a JSON line's
 * `level` field and file it at the right severity, but this sink also serves CI logs, redirected
 * files, and the stderr of an MCP stdio child that a developer reads directly — all of which are
 * worse as JSON. `MINSKY_LOG_MODE=STRUCTURED` remains the way to ask for machine-readable output,
 * and it already routes to the JSON logger instead of here.
 */
function renderDiagnosticLine(info: Record<string, unknown>): string {
  const level = typeof info.level === "string" ? info.level : "info";
  const message =
    typeof info.message === "string"
      ? info.message
      : (safeStringify(info.message) ?? String(info.message));

  let line = `${level}: ${message}`;
  if (typeof info.stack === "string") {
    line += `\n${info.stack}`;
  }

  const metadata: Record<string, unknown> = {};
  for (const key of Object.keys(info)) {
    if (DIAGNOSTIC_RESERVED_KEYS.includes(key)) {
      continue;
    }
    metadata[key] = info[key];
  }
  if (Object.keys(metadata).length > 0) {
    const rendered = safeStringify(metadata);
    if (rendered !== undefined) {
      line += ` ${rendered}`;
    }
  }
  return line;
}

/**
 * Determine the current logging mode.
 *
 * **The mode does not vary by TTY, and never has.** `auto` — the state when `MINSKY_LOG_MODE` is
 * unset — resolves to `HUMAN` everywhere: terminal, pipe, container, CI alike. Only an explicit
 * `MINSKY_LOG_MODE=STRUCTURED` (or a config override) selects `STRUCTURED`.
 *
 * This docblock previously described TTY-based auto-detection, matching `docs/logging.md` and
 * `services/reviewer/src/logger.ts` (which really does implement it) but not this function. The
 * gap was load-bearing rather than cosmetic: `STRUCTURED` is what puts domain logs on stdout, so a
 * reader reasoning about a deployed service from these words concluded its `log.info` output was
 * already going somewhere, when in fact it was being discarded (mt#2464).
 *
 * Auto-detection was not added as the fix, because `STRUCTURED` writes to stdout and two consumers
 * own that stream — a piped CLI payload and the MCP stdio JSON-RPC channel. What varies by
 * terminal instead is `resolveDiagnosticSink` above, which writes to stderr and collides with
 * neither.
 */
export function getLogMode(configOverride?: LoggerConfig): LogMode {
  const config = configOverride || getLoggerConfig();

  // If explicitly set via configuration, respect that
  if (config.mode === "STRUCTURED") {
    return LogMode.STRUCTURED;
  }

  if (config.mode === "HUMAN") {
    return LogMode.HUMAN;
  }

  // Auto mode resolves to HUMAN unconditionally — it does NOT consult the TTY. Keeping STRUCTURED
  // opt-in is what stops machine-readable JSON from landing on stdout beside a CLI payload or
  // inside the MCP stdio protocol stream. Domain diagnostics still reach a stream in this mode;
  // resolveDiagnosticSink routes them to stderr rather than dropping them (mt#2464).
  return LogMode.HUMAN;
}

/**
 * Create a logger instance with the given configuration
 * This allows for dependency injection and testing
 */
/**
 * Is this the error a closed output pipe produces? (mt#3885)
 *
 * Pure, and exported for its own test: the discrimination is the whole guard,
 * and it must not accept a non-EPIPE error — exiting on an unrelated write
 * failure would turn a recoverable condition into a silent process death.
 */
export function isBrokenPipeError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPIPE";
}

/** The process surface the guard needs. Narrowed so a test can supply a fake. */
export interface BrokenPipeGuardProcess {
  on(event: "uncaughtException", listener: (error: unknown) => void): unknown;
  exit(code?: number): unknown;
  stdout?: { on?(event: "error", listener: (error: unknown) => void): unknown };
  stderr?: { on?(event: "error", listener: (error: unknown) => void): unknown };
}

let brokenPipeGuardInstalled = false;

/** Test seam — the guard is process-global and installs at most once per process. */
export function _resetBrokenPipeGuardForTests(): void {
  brokenPipeGuardInstalled = false;
}

/**
 * Exit instead of reporting, when the stream we would report on is gone (mt#3885).
 *
 * ## The failure this prevents
 *
 * A write to a closed stdout raises `EPIPE`. With no handler that becomes an
 * `uncaughtException`, which winston reports — through a Console transport that
 * writes to the SAME stdout (`console.js` sends every level to stdout unless
 * `stderrLevels` names it, and `_stringArrayToSet` turns an omitted option into
 * an empty set). That write raises `EPIPE` too. With `exitOnError: false`, the
 * cycle never terminates.
 *
 * Measured on 2026-08-13 against a `mcp start --http` whose stdout pipe was
 * closed: **~780 MB/s at 100-192% CPU**, an `Error` plus rendered stack per
 * iteration. It is a SYNCHRONOUS cycle, so it also blocks the event loop —
 * which is why mt#3886's memory ceiling, mt#3764's watchers and the process's
 * own SIGTERM handler were all unreachable, and why the orphans the pre-commit
 * test watchdog left behind reached 40-60 GB and panicked the machine
 * (mem#913, five panics in four days).
 *
 * ## Why exiting, rather than routing the report elsewhere
 *
 * Routing the exception dump to stderr looks like the smaller fix and does not
 * work: the case that produced the incident is a test runner spawned with
 * `stdio: ["pipe", "pipe", "pipe"]` being SIGKILLed, which closes BOTH read
 * ends at once. A handler that reports to stderr then loops on stderr instead.
 * The only stable answer is to stop trying to report.
 *
 * Exiting is also the conventional behavior for the condition. SIGPIPE
 * terminates a process by default; Node and Bun ignore it and surface `EPIPE`
 * instead, which leaves the decision to the program. A process whose output
 * pipe is closed has lost the channel it would explain itself on, so `head`
 * closing its input ends `minsky` for the same reason it ends `yes`.
 *
 * Installed FIRST, before any winston logger exists, so this listener runs
 * before winston's and `exit()` preempts the reporting cycle rather than
 * racing it.
 */
export function installBrokenPipeGuard(
  // The runtime methods all exist; this project's ambient `process` type is
  // narrowed and omits `stdout.on`/`stderr.on`, the same gap `start-command.ts`
  // and `stdio-proxy/proxy.ts` cast around.
  // eslint-disable-next-line custom/no-excessive-as-unknown -- narrowed ambient process type, methods exist at runtime
  proc: BrokenPipeGuardProcess = process as unknown as BrokenPipeGuardProcess
): void {
  if (brokenPipeGuardInstalled) return;
  brokenPipeGuardInstalled = true;

  // Exit 0, not non-zero: a closed reader is a normal way for a pipeline to
  // end, and the process did nothing wrong. This matches how conventional CLI
  // tools treat SIGPIPE.
  const exitOnBrokenPipe = (error: unknown): void => {
    if (isBrokenPipeError(error)) proc.exit(0);
  };

  // The stream listeners are what actually fire, and attaching them is what
  // makes that true: before this guard the write threw synchronously through
  // bun's `writeFast` and surfaced as an uncaught exception, because nothing
  // was listening. Measured with the uncaughtException route disabled, the
  // stream listener alone still ends the process — so this pair is the fix, not
  // the line below it.
  proc.stdout?.on?.("error", exitOnBrokenPipe);
  proc.stderr?.on?.("error", exitOnBrokenPipe);

  // Backstop for a write path that reaches the fd without going through
  // `process.stdout` (winston writes via `console._stdout`, which is the same
  // object in the runtimes measured here — but that is an implementation
  // detail of two dependencies, not a contract). It costs nothing to hold:
  // winston installs its own `uncaughtException` handler unconditionally a few
  // lines below, so the process-wide semantics this participates in are
  // already in force either way.
  proc.on("uncaughtException", exitOnBrokenPipe);
}

export function createLogger(configOverride?: LoggerConfig) {
  // mt#3885: before any winston logger exists, so this handler is registered
  // ahead of winston's exception handlers. See installBrokenPipeGuard.
  installBrokenPipeGuard();

  const loggerConfig = configOverride || getLoggerConfig();
  const logLevel = loggerConfig.level;
  const currentLogMode = getLogMode(loggerConfig);
  const enableAgentLogs = loggerConfig.enableAgentLogs;
  // mt#2975: silence winston Console output under the test harness (see
  // isTestHarnessConsoleSilent). File transports and the log.* API stay live.
  const silentConsole = isTestHarnessConsoleSilent();
  // mt#2464: where log.debug/info/warn go. See resolveDiagnosticSink.
  const diagnosticSink = resolveDiagnosticSink({
    mode: currentLogMode,
    enableAgentLogs,
    stderrIsTerminal: stderrIsTerminal(),
    oneShotCommand: processRole === "one-shot-command",
  });

  // Common format for agent logs (JSON)
  const agentLogFormat = format.combine(
    format.timestamp(),
    format.errors({ stack: true }), // Log stack traces
    format.json()
  );

  // Common format for program/CLI logs (plain text)
  const programLogFormat = format.combine(
    format.colorize(),
    format.printf((info: Record<string, unknown>) => {
      // Cast info to a proper type
      const logInfo = info as { message?: unknown; stack?: string; [key: string]: unknown };
      // Ensure message is a string
      const message =
        typeof logInfo.message === "string" ? logInfo.message : JSON.stringify(logInfo.message);
      // For user-facing CLI output, just show the message without timestamp and log level
      let log = message;
      if (logInfo.stack) {
        log += `\n${logInfo.stack}`;
      }
      // Add other metadata if it exists
      const metadata = Object.keys(logInfo).reduce(
        (acc, key) => {
          if (["level", "message", "timestamp", "stack"].includes(key)) {
            return acc;
          }
          acc[key] = logInfo[key];
          return acc;
        },
        {} as Record<string, unknown>
      );

      if (Object.keys(metadata).length > 0) {
        try {
          log += ` ${JSON.stringify(metadata)}`;
        } catch (error) {
          // ignore serialization errors for metadata in text logs
        }
      }
      return log;
    })
  );

  // Agent logger: structured JSON to stdout (when enabled)
  const agentLogger = winston.createLogger({
    level: logLevel,
    format: agentLogFormat,
    transports: [],
    exitOnError: false,
  });

  // Only add stdout transport if in STRUCTURED mode or explicitly enabled in HUMAN mode
  if (currentLogMode === LogMode.STRUCTURED || enableAgentLogs) {
    agentLogger.add(new transports.Console({ stderrLevels: [], silent: silentConsole })); // Ensure only stdout
    agentLogger.exceptions.handle(
      new transports.Console({ format: agentLogFormat, stderrLevels: [], silent: silentConsole })
    );
    agentLogger.rejections.handle(
      new transports.Console({ format: agentLogFormat, stderrLevels: [], silent: silentConsole })
    );
  }

  // Program logger: plain text; normal info goes to stdout, warnings/errors to stderr
  const programLogger = winston.createLogger({
    level: logLevel,
    format: programLogFormat,
    transports: [
      new transports.Console({
        // Send only non-normal levels to stderr; keep info on stdout
        stderrLevels: ["error", "warn", "debug", "http", "verbose", "silly"],
        silent: silentConsole,
      }),
    ], // Ensure only stderr for non-info levels
    exitOnError: false,
  });

  // Always setup exception handlers for programLogger
  programLogger.exceptions.handle(
    new transports.Console({ format: programLogFormat, silent: silentConsole })
  );
  programLogger.rejections.handle(
    new transports.Console({ format: programLogFormat, silent: silentConsole })
  );

  // Diagnostic logger (mt#2464): plain text, EVERY level on stderr.
  //
  // This cannot reuse programLogger. That transport deliberately keeps `info` on STDOUT — that is
  // the `log.cli` user-output channel — and stdout is precisely the stream this sink must not
  // touch, since a piped CLI payload and the MCP stdio protocol both own it. Listing every level
  // in `stderrLevels` is what makes the stream guarantee unconditional rather than level-dependent.
  //
  // No `colorize()`: the consumer here is a container log surface or a redirected file, never a
  // terminal, so ANSI escapes would be noise in the artifact an operator reads.
  const diagnosticLogger = winston.createLogger({
    level: logLevel,
    format: format.combine(
      format.errors({ stack: true }),
      format.printf((info: Record<string, unknown>) => renderDiagnosticLine(info))
    ),
    transports: [
      new transports.Console({
        stderrLevels: ["error", "warn", "info", "debug", "http", "verbose", "silly"],
        silent: silentConsole,
      }),
    ],
    exitOnError: false,
  });

  // Check if we're in structured mode
  const isStructuredMode = () => currentLogMode === LogMode.STRUCTURED;
  // Check if we're in human mode
  const isHumanMode = () => currentLogMode === LogMode.HUMAN;

  /**
   * Emit one domain-channel line to whichever sink `resolveDiagnosticSink` chose (mt#2464).
   *
   * Level filtering still applies at the chosen logger, so `debug` stays silent at the default
   * `info` level on either sink. This routes where a line goes; it does not change how much is
   * logged.
   */
  function emitDiagnostic(
    level: "debug" | "info" | "warn",
    message: string,
    context?: LogContext
  ): void {
    if (diagnosticSink === "discard") {
      return;
    }
    const target = diagnosticSink === "agent" ? agentLogger : diagnosticLogger;
    if (context) {
      target[level](message, context);
    } else {
      target[level](message);
    }
  }

  // Convenience wrapper
  const loggerInstance = {
    // Agent logs (structured JSON to stdout)
    agent: (message: unknown) => {
      // Only log to agentLogger if we're in STRUCTURED mode or agent logs are explicitly enabled
      if (currentLogMode === LogMode.HUMAN && !enableAgentLogs) {
        return;
      }
      agentLogger.info(message as string);
    },
    debug: (message: string, context?: LogContext) => {
      emitDiagnostic("debug", message, context);
    },
    info: (message: string, context?: LogContext) => {
      emitDiagnostic("info", message, context);
    },
    warn: (message: string, context?: LogContext) => {
      emitDiagnostic("warn", message, context);
    },
    error: (
      message: string,
      context?:
        | LogContext
        | Error
        | { originalError?: unknown; stack?: string; [key: string]: unknown }
    ) => {
      // For errors, in HUMAN mode route to programLogger.error instead of suppressing
      if (currentLogMode === LogMode.HUMAN && !enableAgentLogs) {
        // Format the error for the programLogger
        if (context instanceof Error) {
          programLogger.error(`${message}: ${context.message}`);
          if (context.stack) {
            programLogger.error(context.stack);
          }
        } else if (typeof context === "object" && context !== null) {
          // Human-friendly context formatting (avoid raw JSON blobs)
          const parts: string[] = [];
          const anyCtx = context as Record<string, unknown>;
          if (typeof anyCtx.error === "string" && anyCtx.error.trim().length > 0) {
            parts.push(anyCtx.error.trim());
          }
          if (typeof anyCtx.name === "string" && anyCtx.name.trim().length > 0) {
            parts.push(`Session: ${anyCtx.name.trim()}`);
          }
          if (typeof anyCtx.stack === "string") {
            parts.push(anyCtx.stack);
          }
          const suffix = parts.length > 0 ? `\n${parts.join("\n")}` : "";
          programLogger.error(`${message}${suffix}`);
        } else {
          programLogger.error(message);
        }
        return;
      }

      // In STRUCTURED mode or if agent logs explicitly enabled, use agentLogger
      if (context instanceof Error) {
        agentLogger.error(message, {
          originalError: context.message,
          stack: context.stack,
          name: context.name,
        });
      } else if (
        typeof context === "object" &&
        context !== null &&
        (context.originalError || context.stack)
      ) {
        agentLogger.error(message, context);
      } else {
        agentLogger.error(message, context);
      }
    },
    // Program/CLI logs (plain text to stderr)
    cli: (message: unknown) => programLogger.info(String(message)),
    cliWarn: (message: unknown) => programLogger.warn(String(message)),
    cliError: (message: unknown) => programLogger.error(String(message)),
    // Add ability to set log level
    setLevel: (level: string) => {
      agentLogger.level = level;
      programLogger.level = level;
    },
    // Add additional CLI-oriented debug log
    cliDebug: (message: unknown) => programLogger.debug(String(message)),
    // Add system-level debug logging that always goes to stderr, bypassing the mode limitations
    // Use this for important system debugging that should always be visible when debug level is set
    systemDebug: (message: unknown) => {
      // Always log to programLogger (stderr) regardless of mode
      programLogger.debug(String(message));
    },

    // Expose log mode information
    mode: currentLogMode,
    // Where log.debug/info/warn were wired to go (mt#2464). Exposed so a test can check that
    // createLogger actually CONSUMED resolveDiagnosticSink, rather than only that the pure
    // function returns the right answer on its own.
    diagnosticSink,
    isStructuredMode,
    isHumanMode,
    // Expose configuration for testing
    config: loggerConfig,
    // Expose internal loggers for special cases like exit handlers
    _internal: {
      programLogger,
      agentLogger,
    },
  };

  return loggerInstance;
}

// Lazy default logger instance to avoid configuration access during module loading
let defaultLogger: ReturnType<typeof createLogger> | null = null;

function getDefaultLogger() {
  if (!defaultLogger) {
    defaultLogger = createLogger();
  }
  return defaultLogger;
}

// Export the default logger for backward compatibility (lazy).
//
// This is a PLAIN OBJECT of forwarding members, NOT a Proxy. The pre-mt#1859
// shape was `new Proxy({}, { get: ... })` over the lazy singleton — which kept
// module-load side effects out, but made `spyOn(log, "debug")` a silent no-op:
// bun's spyOn installs the patched method through a native path that bypasses
// proxy traps, so the spy landed nowhere reads happen and every logger
// call-count assertion in the test suite saw 0 calls. A plain object with own
// function properties is spy-able directly, and laziness is preserved because
// each forwarder defers `getDefaultLogger()` to its first CALL (data members
// like `mode`/`config`/`_internal` defer via getters).
type DefaultLogger = ReturnType<typeof createLogger>;

/**
 * Lines of operator-visible CLI output emitted since process start —
 * `log.cli`, `log.cliWarn`, and `log.cliError`.
 *
 * Read by the CLI bridge to tell "this command printed its own report" from
 * "this command returned a payload and printed nothing" — the distinction that
 * decides whether the generic result formatter should render the payload's keys
 * or stay quiet (mt#3870). A command cannot be asked directly: most set no
 * `printed` flag, and a shared formatter that guessed wrong would either double-
 * print a self-rendered report or keep swallowing findings.
 *
 * `cliDebug` is deliberately EXCLUDED. It logs at debug level, so at normal
 * verbosity it emits nothing the operator sees; counting it would mark a command
 * as having reported when the terminal stayed empty, and the payload would be
 * suppressed — reinstating the very defect this counter exists to fix. The three
 * counted channels all write unconditionally.
 *
 * This is a process-wide counter, so it is only meaningful where one command
 * runs per process — which is exactly the CLI, its sole consumer. The MCP
 * server increments it too and never reads it.
 */
let cliOutputLineCount = 0;

/** Current value of the visible-CLI-output line counter. See `cliOutputLineCount`. */
export function getCliOutputLineCount(): number {
  return cliOutputLineCount;
}

export const log: DefaultLogger = {
  agent: (message) => getDefaultLogger().agent(message),
  debug: (message, context?) => getDefaultLogger().debug(message, context),
  info: (message, context?) => getDefaultLogger().info(message, context),
  warn: (message, context?) => getDefaultLogger().warn(message, context),
  error: ((message: Parameters<DefaultLogger["error"]>[0], context?: unknown) =>
    (getDefaultLogger().error as (m: unknown, c?: unknown) => void)(
      message,
      context
    )) as DefaultLogger["error"],
  cli: (message) => {
    cliOutputLineCount++;
    return getDefaultLogger().cli(message);
  },
  cliWarn: (message) => {
    cliOutputLineCount++;
    return getDefaultLogger().cliWarn(message);
  },
  cliError: (message) => {
    cliOutputLineCount++;
    return getDefaultLogger().cliError(message);
  },
  setLevel: (level) => getDefaultLogger().setLevel(level),
  cliDebug: (message) => getDefaultLogger().cliDebug(message),
  systemDebug: (message) => getDefaultLogger().systemDebug(message),
  isStructuredMode: () => getDefaultLogger().isStructuredMode(),
  isHumanMode: () => getDefaultLogger().isHumanMode(),
  get mode() {
    return getDefaultLogger().mode;
  },
  get diagnosticSink() {
    return getDefaultLogger().diagnosticSink;
  },
  get config() {
    return getDefaultLogger().config;
  },
  get _internal() {
    return getDefaultLogger()._internal;
  },
} as DefaultLogger;

/**
 * TEST-ONLY: reset the cached default logger singleton so the next access
 * re-initializes it from the current environment variables (e.g. MINSKY_LOG_MODE).
 *
 * Call this in test `beforeEach` hooks after mutating process.env to ensure the
 * STRUCTURED-mode (or other mode) tests don't reuse a cached HUMAN-mode logger
 * from earlier test suites in the same process.
 *
 * Do NOT call this in production code.
 */
export function _resetDefaultLoggerForTests(): void {
  defaultLogger = null;
}

/**
 * Force the shared default logger singleton to be rebuilt on next use,
 * picking up any `process.env` changes (e.g. `ENABLE_AGENT_LOGS`,
 * `MINSKY_LOG_MODE`, `LOGLEVEL`) made since it was first created.
 *
 * Unlike {@link _resetDefaultLoggerForTests} (test-only), this IS a
 * legitimate production entrypoint — for a caller that intentionally
 * mutates a logger-relevant env var at runtime and needs the change to
 * take effect immediately, rather than silently having no effect until
 * some later, unrelated first-use of `log` happens to occur after the
 * mutation (which may never happen, if something already called `log.*`
 * earlier in the process).
 *
 * Without this, `enableAgentLogs` (and the HUMAN/STRUCTURED mode choice)
 * is captured ONCE into each wrapper function's closure inside
 * {@link createLogger} at first use and never re-read from `process.env`
 * again. Originating case (mt#2894 PR #2019 R1 BLOCKING #3):
 * `src/cockpit/daemon-file-log.ts`'s `installDaemonFileLogging()` set
 * `ENABLE_AGENT_LOGS=true` but never called this, so `log.warn`/`log.info`/
 * `log.debug` calls that happened to be the process's first `log.*` use —
 * anywhere in the CLI bootstrap, before `cockpit start`'s action handler
 * even ran — silently kept dropping, because the singleton had already
 * baked in the pre-change (disabled) value.
 */
export function reinitializeDefaultLoggerFromEnv(): void {
  defaultLogger = null;
}

export const isStructuredMode = () => getDefaultLogger().isStructuredMode();
export const isHumanMode = () => getDefaultLogger().isHumanMode();

// Export the factory function for dependency injection
export { createLogger as createConfigurableLogger };

// Ensure logs are written before exiting on unhandled exceptions/rejections
const _handleExit = async (error?: Error) => {
  if (error) {
    // Use default logger's internal program logger for unhandled errors that might crash the CLI
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    defaultLogger!._internal.programLogger.error("Unhandled error or rejection, exiting.", error);
  }
  // Give logs a moment to flush
  await new Promise((resolve) => setTimeout(resolve, 100));
};

// Basic test to ensure it works - can be removed or moved to a test file
if (process.env.RUN_LOGGER_TEST === "true") {
  log.cli("--- Agent Logger (stdout) ---");
  log.debug("Agent debug message");
  log.agent("Agent info message");
  log.warn("Agent warning message");
  log.error("Agent error message (string)", { details: "string error" });
  log.error("Agent error via Error object", new Error("Test error"));

  log.cli("\n--- Program Logger (stderr) ---");
  log.cliDebug("This is a CLI debug message.");
  log.cli("This is a CLI message.");
  log.cliWarn("This is a CLI warning.");
  log.cliError("This is a CLI error.");
  log.systemDebug("This is a system debug message that works in all modes.");

  log.cli("\n--- Environment Information ---");
  log.cli(`Current Log Mode: ${log.mode}`);
  log.cli(`Is Structured Mode: ${log.isStructuredMode()}`);
  log.cli(`Is Human Mode: ${log.isHumanMode()}`);
  log.cli(`Is Terminal (TTY): ${Boolean(process.stdout.isTTY)}`);
}
