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
 * `cockpit start` command's action handler — before any sweeper starts and
 * before any other `log.*` call — so the logger singleton picks up
 * `ENABLE_AGENT_LOGS` before it lazily initializes (see
 * `packages/shared/src/logger.ts`'s `getDefaultLogger()`).
 */
import * as winston from "winston";
import fs from "fs";
import path from "path";
import { log } from "@minsky/shared/logger";
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

  // Attach to BOTH internal loggers (see packages/shared/src/logger.ts's
  // `_internal` escape hatch, documented there as intended for "special
  // cases like exit handlers"). `log.warn`/`log.error`/etc. route to
  // agentLogger once ENABLE_AGENT_LOGS is set above; programLogger is
  // attached too for completeness (log.cli*/systemDebug calls, if any).
  log._internal.agentLogger.add(fileTransport);
  log._internal.programLogger.add(fileTransport);
}

/** TEST-ONLY: reset the installed guard so tests can re-install against a fresh transport. */
export function _resetDaemonFileLoggingForTest(): void {
  installed = false;
}
