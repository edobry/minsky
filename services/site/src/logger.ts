/**
 * Site-local winston logger.
 *
 * Mirrors the pattern of services/reviewer/src/logger.ts, but is a standalone
 * module — no cross-package imports. The site service is a separately-deployed
 * Nixpacks package (services/site/nixpacks.toml); keeping the logger local
 * ensures the deployment boundary stays clean.
 *
 * Mode selection:
 *   STRUCTURED — JSON lines to stdout. Activated when:
 *     1. MINSKY_LOG_MODE=STRUCTURED env var is set, OR
 *     2. stdout is not a TTY (production/CI/Nixpacks).
 *   HUMAN      — concise human-readable lines to stdout. Default when stdout IS a TTY.
 *
 * Log level:
 *   Controlled by LOG_LEVEL env var: debug | info | warn | error. Default: info.
 *
 * Redaction contract (enforced by this module):
 *   - Bearer tokens MUST NOT appear in any log line.
 *   - PEM content / privateKey MUST NOT appear.
 *   - Sensitive context keys (mcpToken, privateKey, authorization, Authorization,
 *     providerApiKey) are redacted to "***".
 *
 * Even though services/site has no current tokens or PEMs in scope, these
 * redaction guarantees ship from day one — this protects future code from
 * leaking secrets if the surface area grows.
 */

import * as winston from "winston";

const { format, transports } = winston;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

export enum LogMode {
  HUMAN = "HUMAN",
  STRUCTURED = "STRUCTURED",
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

/**
 * Determine the active log mode.
 *
 * Priority:
 *   1. MINSKY_LOG_MODE=STRUCTURED  → STRUCTURED
 *   2. MINSKY_LOG_MODE=HUMAN       → HUMAN
 *   3. stdout is NOT a TTY         → STRUCTURED (production / Nixpacks default)
 *   4. otherwise                   → HUMAN
 */
export function resolveLogMode(): LogMode {
  const envMode = process.env["MINSKY_LOG_MODE"];
  if (envMode === "STRUCTURED") return LogMode.STRUCTURED;
  if (envMode === "HUMAN") return LogMode.HUMAN;
  return process.stdout.isTTY ? LogMode.HUMAN : LogMode.STRUCTURED;
}

/**
 * Resolve the log level from the LOG_LEVEL env var.
 * Falls back to "info" for unknown values.
 */
export function resolveLogLevel(): LogLevel {
  const raw = process.env["LOG_LEVEL"];
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const BEARER_RE = /Bearer\s+\S+/gi;
// Match an entire PEM block (header + base64 body + footer). [\s\S] handles
// the multi-line body without needing the /s flag. Lazy quantifier (*?) so
// adjacent PEM blocks don't get coalesced into one match.
const PEM_BLOCK_RE = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;

/**
 * Redact sensitive values from a string before it is logged.
 *
 * - "Bearer <token>" → "Bearer ***"
 * - Full PEM blocks (BEGIN through END) → "[REDACTED PEM]"
 */
export function redactString(value: string): string {
  return value.replace(BEARER_RE, "Bearer ***").replace(PEM_BLOCK_RE, "[REDACTED PEM]");
}

/**
 * Walk a log-context object and redact known-sensitive keys in-place on a
 * shallow copy. Returns a new shallow-copy object — never mutates the caller's
 * object.
 */
export function redactContext(ctx: LogContext): LogContext {
  const SENSITIVE_KEYS = new Set([
    "mcpToken",
    "privateKey",
    "authorization",
    "Authorization",
    "providerApiKey",
  ]);
  const result: LogContext = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = "***";
    } else if (typeof value === "string") {
      result[key] = redactString(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

export interface SiteLogger {
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
  mode: LogMode;
}

/**
 * Create a site-local winston logger.
 *
 * @param modeOverride  Force a specific mode (used in tests).
 * @param levelOverride Force a specific level (used in tests).
 */
export function createLogger(modeOverride?: LogMode, levelOverride?: LogLevel): SiteLogger {
  const mode = modeOverride ?? resolveLogMode();
  const level = levelOverride ?? resolveLogLevel();

  const structuredFormat = format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  );

  const humanFormat = format.combine(
    format.colorize(),
    format.printf((info) => {
      const {
        level: lvl,
        message,
        timestamp: _ts,
        ...rest
      } = info as {
        level: string;
        message: unknown;
        timestamp?: unknown;
        [key: string]: unknown;
      };
      const msg = typeof message === "string" ? message : JSON.stringify(message);
      const keys = Object.keys(rest);
      const suffix =
        keys.length > 0
          ? ` ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, rest[k]])))}`
          : "";
      return `${lvl}: ${msg}${suffix}`;
    })
  );

  const activeFormat = mode === LogMode.STRUCTURED ? structuredFormat : humanFormat;

  const winstonLogger = winston.createLogger({
    level,
    format: activeFormat,
    // Explicit stderrLevels: ["error"] so log.error preserves the stderr-emission
    // semantic of the console.error call it replaces in server.ts. Winston's
    // Console transport defaults to an empty stderr set when the option is
    // omitted (see node_modules/winston/lib/winston/transports/console.js's
    // _stringArrayToSet: undefined → {}). Diverges from
    // services/reviewer/src/logger.ts (which forces everything to stdout via
    // stderrLevels: []); that decision is owned by mt#1255 and not in scope here.
    transports: [new transports.Console({ stderrLevels: ["error"] })],
    exitOnError: false,
  });

  function emit(lvl: LogLevel, message: string, context?: LogContext): void {
    const redactedMsg = redactString(message);
    const redactedCtx = context ? redactContext(context) : undefined;
    if (redactedCtx !== undefined) {
      winstonLogger[lvl](redactedMsg, redactedCtx);
    } else {
      winstonLogger[lvl](redactedMsg);
    }
  }

  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    mode,
  };
}

// ---------------------------------------------------------------------------
// Default singleton (lazy)
// ---------------------------------------------------------------------------

let _defaultLogger: SiteLogger | null = null;

function getDefaultLogger(): SiteLogger {
  if (!_defaultLogger) {
    _defaultLogger = createLogger();
  }
  return _defaultLogger;
}

/**
 * TEST-ONLY: reset the cached default logger so the next access re-initialises
 * it from the current environment variables. Call in beforeEach after mutating
 * process.env.
 */
export function _resetDefaultLoggerForTests(): void {
  _defaultLogger = null;
}

/**
 * Module-level logger proxy. All site-service modules import this and call
 * `log.info(...)`, `log.error(...)`, etc.
 */
export const log: SiteLogger = new Proxy({} as SiteLogger, {
  get(_target, prop) {
    // SiteLogger doesn't structurally overlap Record<string|symbol, unknown>
    // for TS's narrowing, so we route through `unknown` to satisfy the cast.
    // The double-cast is intentional for proxy passthrough; the linter's
    // 'no-excessive-as-unknown' heuristic doesn't apply here.
    // eslint-disable-next-line custom/no-excessive-as-unknown
    return (getDefaultLogger() as unknown as Record<string | symbol, unknown>)[
      prop as string | symbol
    ];
  },
});
