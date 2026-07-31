/**
 * Cockpit daemon rotating file log (mt#2894).
 *
 * ## Root-cause background
 *
 * mt#2894's spec asked (SC#4) to root-cause a 2026-07-16 sweep-liveness
 * incident from daemon-side evidence "or document that the daemon has no
 * persistent log — and fix THAT". Investigation found the premise more
 * subtle than "no log file exists":
 *
 *   - The daemon's raw stdout/stderr ARE already captured to files for two
 *     of the three ways the daemon gets started — the tray supervisor
 *     (`cockpit-tray/src-tauri/src/supervisor.rs`'s `open_log()`) and the
 *     launchd plist (`StandardOutPath`/`StandardErrorPath` in `./launchd.ts`)
 *     both redirect to `~/.local/state/minsky/logs/cockpit-{stdout,stderr}.log`.
 *     A bare/manual `bun run src/cli.ts cockpit start` (dev/terminal use) has
 *     NO redirection — nothing is captured there today.
 *   - Those captured files are UNBOUNDED (no rotation) — `cockpit-stderr.log`
 *     had grown to ~2GB by the time of this investigation, dominated by an
 *     unrelated recurring `agent_transcripts` upsert failure whose full query
 *     params get re-logged on every retry (filed separately; out of scope
 *     here).
 *   - Critically, `@minsky/shared/logger`'s default mode (HUMAN, no
 *     `ENABLE_AGENT_LOGS`) makes `log.warn(...)` — the EXACT call
 *     `createIntervalSweeper` uses for every tick timeout, watchdog
 *     force-release, and unexpected throw — a silent no-op. Neither the tray
 *     spawn path nor the launchd plist sets `ENABLE_AGENT_LOGS` or
 *     `MINSKY_LOG_MODE=STRUCTURED`. So even where raw stdio WAS captured,
 *     none of the sweep-liveness-relevant operational warnings ever reached
 *     it — the channel that would have recorded the 2026-07-16 incident was
 *     architecturally silent by default.
 *
 * This module fixes both gaps for the cockpit daemon specifically (NOT a
 * change to the shared logger's default elsewhere in the CLI, to avoid
 * regressing `§Rationale` in packages/shared/src/logger.ts's own comment
 * about HUMAN-mode CLI output):
 *
 *   1. Forces `ENABLE_AGENT_LOGS=true` for the daemon process so
 *      `log.warn`/`log.error`/`log.info`/`log.debug` actually emit (as
 *      structured JSON with real ISO timestamps, via the existing
 *      `agentLogger` — see `packages/shared/src/logger.ts`).
 *   2. Attaches a size-bounded, rotating winston `File` transport (built-in
 *      `maxsize`/`maxFiles` rotation — no new dependency) to a dedicated
 *      `~/.local/state/minsky/logs/cockpit-daemon.log`, independent of
 *      whichever of the three daemon-launch paths is in use. This is the
 *      literal "daemon logs to a rotating file under ~/.local/state/minsky/"
 *      fix the spec named.
 *
 * Call `installDaemonFileLogging()` ONCE, as early as possible in the
 * `cockpit start` command's action handler — before any sweeper starts.
 * "As early as possible" is a defense-in-depth ordering preference, not a
 * correctness requirement: this function also calls
 * `reinitializeDefaultLoggerFromEnv()` (mt#2894 PR #2019 R1 BLOCKING #3)
 * after setting `ENABLE_AGENT_LOGS`, which forces the shared logger
 * singleton to rebuild from the now-current env on its NEXT use — so a
 * `log.*` call that already happened earlier in the process (before this
 * function ran, baking in the pre-fix disabled state into the singleton)
 * does not permanently defeat the fix. Without that reinit call, setting
 * the env var alone is silently ineffective once anything has already
 * triggered the logger's lazy first-use.
 */
import * as winston from "winston";
import fs from "fs";
import path from "path";
import { log, reinitializeDefaultLoggerFromEnv } from "@minsky/shared/logger";
import { getStateDir } from "./lifecycle";

/** Per-file size cap before winston rotates (built-in File transport `maxsize`). */
export const DAEMON_LOG_MAX_BYTES = 20 * 1024 * 1024; // 20MB

/** Number of rotated files retained (built-in File transport `maxFiles`). */
export const DAEMON_LOG_MAX_FILES = 5; // ~100MB total retained, worst case

export function getDaemonLogDir(): string {
  return path.join(getStateDir(), "logs");
}

export function getDaemonLogFilePath(): string {
  return path.join(getDaemonLogDir(), "cockpit-daemon.log");
}

let installed = false;

/**
 * Install rotating file logging + force-enable the structured warn/error
 * channel for the cockpit daemon process. Idempotent — safe to call more
 * than once (e.g. if a future entrypoint calls it defensively); only the
 * first call has effect.
 */
export function installDaemonFileLogging(): void {
  if (installed) return;
  installed = true;

  // Fix the silent-log-drop gap (see module docblock): without this, HUMAN
  // mode (the CLI default) makes log.warn/info/debug complete no-ops, and
  // log.error routes through the unstructured, untimestamped programLogger.
  process.env.ENABLE_AGENT_LOGS = "true";
  // mt#2894 PR #2019 R1 BLOCKING #3: the env var alone is NOT sufficient —
  // `enableAgentLogs` is captured once into the logger singleton's closures
  // at first use. Force a rebuild so THIS process's log calls (including
  // ones already made earlier, whose effect was "dropped" under the old
  // singleton) are honored going forward.
  reinitializeDefaultLoggerFromEnv();

  const logDir = getDaemonLogDir();
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    // Best-effort — if the directory truly can't be created, the File
    // transport's own open() will fail too and winston logs that failure
    // to its remaining transports; the daemon must not crash over this.
    const message = err instanceof Error ? err.message : String(err);
    log.cliWarn(`cockpit: could not create daemon log directory ${logDir}: ${message}`);
  }

  const fileTransport = new winston.transports.File({
    filename: getDaemonLogFilePath(),
    maxsize: DAEMON_LOG_MAX_BYTES,
    maxFiles: DAEMON_LOG_MAX_FILES,
    tailable: true,
    // Explicit format (JSON + timestamp), overriding whichever parent
    // logger (agentLogger vs. programLogger) routes a given call through —
    // programLogger's own format includes ANSI colorize() codes that would
    // otherwise pollute the file; forcing a consistent format here keeps
    // the rotating file machine-readable regardless of call site.
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  });

  // Attach to `agentLogger` ONLY (mt#2894 PR #2019 R1 NON-BLOCKING #4).
  // With ENABLE_AGENT_LOGS=true (set above), `log.warn`/`log.info`/
  // `log.debug`/`log.error` — the entire call surface `createIntervalSweeper`
  // and the rest of the cockpit daemon use — route exclusively through
  // `agentLogger` (see packages/shared/src/logger.ts's wrapper functions).
  // `programLogger` is reached only via the separate `log.cli`/`cliWarn`/
  // `cliError`/`cliDebug`/`systemDebug` helpers, which cockpit code does not
  // call. Attaching the SAME transport instance to both loggers was
  // considered and rejected: each logger independently registers its own
  // `exceptions.handle()`/`rejections.handle()` in `createLogger()`, so an
  // uncaught exception/rejection could reach BOTH loggers' handlers and be
  // written twice to one file. Attaching once removes that risk entirely
  // rather than deduplicating after the fact. See
  // `src/cockpit/daemon-file-log.test.ts`'s "does not duplicate a line
  // across agentLogger and programLogger" test for the regression check.
  log._internal.agentLogger.add(fileTransport);
}

/** TEST-ONLY: reset the installed guard so tests can re-install against a fresh transport. */
export function _resetDaemonFileLoggingForTest(): void {
  installed = false;
}
