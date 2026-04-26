/**
 * Reviewer-local structured logger.
 *
 * A thin winston wrapper that provides two output modes:
 *   HUMAN     — concise single-line text via printf (default when stdout is a TTY)
 *   STRUCTURED — JSON lines via winston.format.json() (when MINSKY_LOG_MODE=STRUCTURED
 *                or when stdout is not a TTY, e.g. inside a Docker container)
 *
 * Log level controlled by `LOG_LEVEL` env var (debug | info | warn | error). Default: info.
 * `LOG_LEVEL` matches the variable already read by `config.ts` (loadConfig); the env var name
 * is unified across the service.
 *
 * **Redaction:** the logger applies a defensive scrub *before* serialization that nukes
 * values for sensitive keys (token, authorization, mcpToken, privateKey, apiKey, secret —
 * case-insensitive, exact match) and replaces strings starting with `Bearer ` with `Bearer ***`.
 * Call sites are still expected to redact at the source (don't pass the secret in the first
 * place); this is defense in depth, not the primary control.
 *
 * This is intentionally a standalone module — it MUST NOT import from the main
 * Minsky src/ tree because the reviewer service ships as an independent Docker image.
 *
 * Usage:
 *   import { log } from "./logger";
 *   log.info("review started", { prNumber: 42 });
 *   log.error("lookup failed", { artifactId: "123", err: "timeout" });
 *
 * For testing:
 *   import { createLogger } from "./logger";
 *   const testLog = createLogger({ mode: "STRUCTURED", level: "debug" });
 */

import * as winston from "winston";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogMode = "HUMAN" | "STRUCTURED";
export type LogContext = Record<string, unknown>;

export interface LoggerOptions {
  mode?: LogMode;
  level?: LogLevel;
}

/**
 * Determine the effective log mode.
 *
 * Priority:
 *  1. Explicit options.mode
 *  2. MINSKY_LOG_MODE env var == "STRUCTURED"
 *  3. stdout is non-TTY  ->  STRUCTURED
 *  4. Default: HUMAN
 */
function resolveMode(options?: LoggerOptions): LogMode {
  if (options?.mode) return options.mode;
  if (process.env["MINSKY_LOG_MODE"] === "STRUCTURED") return "STRUCTURED";
  if (!process.stdout.isTTY) return "STRUCTURED";
  return "HUMAN";
}

function resolveLevel(options?: LoggerOptions): LogLevel {
  if (options?.level) return options.level;
  // Honor LOG_LEVEL (with underscore) to match the existing reviewer config
  // (`config.ts` reads `optionalEnv("LOG_LEVEL", "info")` into `ReviewerConfig.logLevel`).
  const env = process.env["LOG_LEVEL"];
  if (env === "debug" || env === "info" || env === "warn" || env === "error") return env;
  return "info";
}

/**
 * Pattern that matches common secret-like field names. Tested case-insensitively
 * against the lower-cased key. Covers known variants:
 *   token, mcpToken, accessToken, refreshToken, authToken, bearerToken, idToken
 *   apiKey, api_key, x_api_key, xApiKey
 *   secret, clientSecret, client_secret, app_secret
 *   password, passwd
 *   privateKey, private_key
 *   authorization, x-authorization (and related auth* / authorization* forms)
 *
 * Underscores and hyphens are normalized away before matching so {access_token,
 * accessToken, access-token} all match.
 */
const REDACT_KEY_PATTERN =
  /^(?:.*(?:token|secret|password|passwd|apikey|privatekey|authorization|authtoken|bearertoken)|auth)$/;

function isSensitiveKey(key: string): boolean {
  // Lowercase + drop separators so accessToken / access_token / access-token all match.
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return REDACT_KEY_PATTERN.test(normalized);
}

const REDACTED = "***";

/**
 * Recursively scrub a non-info value: replace values of sensitive keys with "***"
 * and rewrite Bearer-style strings. Returns a new value — does not mutate input.
 */
function redact(value: unknown, depth = 0): unknown {
  // Cap recursion depth defensively to avoid runaway costs on cyclic structures.
  if (depth > 8) return value;

  if (typeof value === "string") {
    // Catch `Bearer <token>` anywhere in a string value.
    return value.replace(/Bearer\s+\S+/gi, "Bearer ***");
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Winston format that scrubs sensitive fields *in place* on the info object before
 * it reaches downstream serialization.
 *
 * Mutates info rather than replacing it because winston's pipeline relies on
 * Symbol-keyed metadata (Symbol.for("level"), Symbol.for("message"), Symbol.for("splat"))
 * that would be lost if we returned a fresh object built from `Object.entries`. We touch
 * only the string-keyed own properties contributed by call-site context.
 */
const redactFormat = winston.format((info) => {
  for (const k of Object.keys(info)) {
    const v = (info as Record<string, unknown>)[k];
    if (isSensitiveKey(k)) {
      (info as Record<string, unknown>)[k] = REDACTED;
    } else if (typeof v === "string") {
      (info as Record<string, unknown>)[k] = v.replace(/Bearer\s+\S+/gi, "Bearer ***");
    } else if (v !== null && typeof v === "object") {
      (info as Record<string, unknown>)[k] = redact(v);
    }
  }
  return info;
})();

/**
 * Build a winston logger instance.
 *
 * HUMAN mode: `printf` format — concise, human-readable lines.
 * STRUCTURED mode: JSON lines for log aggregators.
 */
export function createLogger(options?: LoggerOptions) {
  const mode = resolveMode(options);
  const level = resolveLevel(options);

  const humanFormat = winston.format.combine(
    winston.format.timestamp(),
    redactFormat,
    winston.format.printf((info) => {
      const {
        timestamp,
        level: lvl,
        message,
        ...rest
      } = info as {
        timestamp?: string;
        level: string;
        message: unknown;
        [key: string]: unknown;
      };
      const ts = timestamp ?? new Date().toISOString();
      const msg = typeof message === "string" ? message : JSON.stringify(message);
      const extras = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
      return `${ts} [${lvl.toUpperCase()}] ${msg}${extras}`;
    })
  );

  const structuredFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    redactFormat,
    winston.format.json()
  );

  const winstonLogger = winston.createLogger({
    level,
    format: mode === "STRUCTURED" ? structuredFormat : humanFormat,
    // Route warn + error to stderr to preserve the pre-PR semantics — `console.error`
    // wrote to stderr; without `stderrLevels` winston defaults all levels to stdout,
    // which would silently break log routing keyed on stream (Railway, etc.).
    transports: [new winston.transports.Console({ stderrLevels: ["warn", "error"] })],
    exitOnError: false,
  });

  return {
    debug(message: string, context?: LogContext) {
      if (context) {
        winstonLogger.debug(message, context);
      } else {
        winstonLogger.debug(message);
      }
    },
    info(message: string, context?: LogContext) {
      if (context) {
        winstonLogger.info(message, context);
      } else {
        winstonLogger.info(message);
      }
    },
    warn(message: string, context?: LogContext) {
      if (context) {
        winstonLogger.warn(message, context);
      } else {
        winstonLogger.warn(message);
      }
    },
    error(message: string, context?: LogContext) {
      if (context) {
        winstonLogger.error(message, context);
      } else {
        winstonLogger.error(message);
      }
    },
    /** Expose underlying winston instance for advanced usage. */
    _winston: winstonLogger,
  };
}

/** Default logger instance (lazy-initialized). */
let _default: ReturnType<typeof createLogger> | null = null;

function getDefault(): ReturnType<typeof createLogger> {
  if (!_default) {
    _default = createLogger();
  }
  return _default;
}

/**
 * Default `log` singleton — mirrors the main-package pattern.
 * All reviewer modules should import this and call log.info / log.error etc.
 */
export const log: ReturnType<typeof createLogger> = new Proxy(
  {} as ReturnType<typeof createLogger>,
  {
    get(_target, prop) {
      return (getDefault() as Record<string | symbol, unknown>)[prop as string | symbol];
    },
  }
) as ReturnType<typeof createLogger>;
