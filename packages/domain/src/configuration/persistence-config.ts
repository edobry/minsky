/**
 * Effective Persistence Configuration Utility
 *
 * Reads `config.persistence` and falls back to MINSKY_POSTGRES_URL for the
 * connection string only. Postgres is the sole supported backend (ADR-018,
 * mt#2349); when no Postgres connection is configured the provider factory
 * raises a clear "configure Postgres" error rather than silently falling back
 * to a local file.
 *
 * The legacy `config.sessiondb` block is no longer supported. If a config
 * file still contains a `sessiondb:` key, this resolver throws
 * `LegacySessiondbConfigError` with migration guidance instead of silently
 * stripping the key (Zod's default `.strip()` mode would otherwise drop it
 * unobserved). See task mt#1610 for the removal.
 */

import { log } from "@minsky/shared/logger";

import type { Configuration } from "./schemas";
import type { PostgresConfig } from "./schemas/persistence";

/**
 * Thrown by `getEffectivePersistenceConfig` when a merged config still
 * contains a legacy `sessiondb:` block. Fire-once-loud: stops execution at
 * the first persistence read so the operator sees the error directly rather
 * than chasing a downstream "no persistence config" symptom.
 */
export class LegacySessiondbConfigError extends Error {
  readonly detectedFields: string[];
  constructor(detectedFields: string[]) {
    super(
      `Legacy 'sessiondb:' configuration block detected (fields: ${detectedFields.join(", ")}). ` +
        `Migrate to 'persistence:' configuration — same shape, just rename the top-level key. ` +
        `Example: change \`sessiondb: { backend: "postgres", postgres: { connectionString: "..." } }\` ` +
        `to \`persistence: { backend: "postgres", postgres: { connectionString: "..." } }\`. ` +
        `Removed in mt#1610.`
    );
    this.name = "LegacySessiondbConfigError";
    this.detectedFields = detectedFields;
  }
}

/**
 * Normalized persistence configuration. The top-level `connectionString`
 * field is a convenience alias; the full `postgres` sub-object carries every
 * configured field (pool settings, etc.) so callers don't drop them silently.
 */
export interface EffectivePersistenceConfig {
  backend: "postgres" | string;
  /** Convenience alias for `postgres.connectionString`. */
  connectionString?: string;
  /** Full resolved postgres sub-config (present when backend is "postgres"). */
  postgres?: PostgresConfig;
}

/**
 * Extract the HOST (host:port) from a connection string.
 *
 * Host only, never the full string — a Postgres connection string carries the
 * password in userinfo, and everything this module surfaces is destined for a
 * log line or CLI output, both of which are persisted and ingested
 * (`terminal-command-best-practices.mdc §Secret handling`).
 *
 * Returns `undefined` for absent input and the literal `"(unparseable)"` for a
 * string `URL` rejects — deliberately NOT the input, which would leak the very
 * credential this function exists to withhold.
 */
export function connectionTargetHost(connectionString: string | undefined): string | undefined {
  if (!connectionString) return undefined;
  try {
    return new URL(connectionString).host || "(no host)";
  } catch {
    // intentional-swallow: an unparseable connection string is reported as such;
    // echoing the input here would emit the credential.
    return "(unparseable)";
  }
}

/** A `DATABASE_URL` that was set in the environment and had no effect. */
export interface IgnoredDatabaseUrl {
  /** Host named by `DATABASE_URL` — the target the caller believed they selected. */
  ignoredHost: string;
  /** Host actually resolved from Minsky config or a registered override. */
  selectedHost: string;
}

/**
 * Decide whether `DATABASE_URL` was set and ignored.
 *
 * `DATABASE_URL` is the ecosystem-conventional variable and is read NOWHERE in
 * Minsky's configuration-resolution path — an agent that exports it at a
 * scratch database gets whatever the config says, which is production, with no
 * error and no warning (mt#4789). This detects that specific ambiguity.
 *
 * Pure and total: takes the two values, returns the finding. It does not read
 * `process.env`, does not log, and does not depend on module state, so its
 * tests assert on a returned value rather than patching a collaborator
 * (`testing-standards.mdc §Testable Design`).
 *
 * Returns `undefined` — meaning "no ambiguity, stay silent" — when
 * `DATABASE_URL` is unset, when nothing resolved at all (that surfaces as the
 * provider factory's "configure Postgres" error, which is already loud), or
 * when the resolved target is the one `DATABASE_URL` names. That last case is
 * what keeps this quiet for the scripts that legitimately drive Minsky through
 * `DATABASE_URL` by bridging it onto a registered variable.
 */
export function detectIgnoredDatabaseUrl(
  resolvedConnectionString: string | undefined,
  databaseUrl: string | undefined
): IgnoredDatabaseUrl | undefined {
  if (!databaseUrl) return undefined;
  if (!resolvedConnectionString) return undefined;
  if (resolvedConnectionString === databaseUrl) return undefined;

  const ignoredHost = connectionTargetHost(databaseUrl);
  const selectedHost = connectionTargetHost(resolvedConnectionString);
  if (!ignoredHost || !selectedHost) return undefined;

  // Same target reached via a differently-spelled URL (postgres:// vs
  // postgresql://, a trailing slash, differing query params) is not the
  // ambiguity this warns about — the caller got the database they asked for.
  if (ignoredHost === selectedHost) return undefined;

  return { ignoredHost, selectedHost };
}

/**
 * Render the warning text for an ignored `DATABASE_URL`.
 *
 * Separate from the detection above so the message is assertable without
 * capturing log output — the in-process test harness silences winston's
 * Console (`TEST_LOGGER_SILENCED_FLAG`), so a test that watched the logger
 * would pass whether or not this ever fired.
 */
export function formatIgnoredDatabaseUrlWarning(finding: IgnoredDatabaseUrl): string {
  return (
    `DATABASE_URL is set to ${finding.ignoredHost} but Minsky resolved ` +
    `${finding.selectedHost}. Minsky does not read DATABASE_URL: set ` +
    `MINSKY_PERSISTENCE_POSTGRES_URL (canonical) or MINSKY_POSTGRES_URL ` +
    `(legacy alias) to redirect it.`
  );
}

/**
 * Fire-once guard, keyed on the rendered message.
 *
 * `getEffectivePersistenceConfig` is called on every persistence-facing
 * operation, so an unguarded warning would repeat many times per process for a
 * condition that is constant across them.
 */
const warnedMessages = new Set<string>();

function warnIgnoredDatabaseUrlOnce(finding: IgnoredDatabaseUrl | undefined): void {
  if (!finding) return;
  const message = formatIgnoredDatabaseUrlWarning(finding);
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  log.warn(message);
}

/**
 * Resolve the target HOST for a configuration, without emitting the credential.
 *
 * The readback behind `persistence check`: it answers "which database am I
 * about to talk to?" — the question whose silent wrong answer is production.
 */
export function resolvePersistenceTargetHost(config: Configuration): string | undefined {
  return connectionTargetHost(getEffectivePersistenceConfig(config).connectionString);
}

/**
 * Resolve the effective persistence configuration from a Configuration object.
 *
 * Resolution priority:
 *   1. `config.persistence.*`
 *   2. Environment variable `MINSKY_POSTGRES_URL` (connection string only;
 *      kept as the canonical escape hatch — `MINSKY_PERSISTENCE_POSTGRES_URL`
 *      already flows through the standard env→config mapping into
 *      `persistence.postgres.connectionString` and takes priority at step 1).
 *   3. Hard-coded default (backend → "postgres"). No connection string is
 *      synthesized; an unconfigured Postgres connection surfaces as a clear
 *      error at provider-create time.
 *
 * Throws `LegacySessiondbConfigError` if the merged config still contains a
 * `sessiondb:` block.
 */
export function getEffectivePersistenceConfig(config: Configuration): EffectivePersistenceConfig {
  // Loud fail on legacy sessiondb config — see mt#1610.
  const legacy = (config as Configuration & { sessiondb?: Record<string, unknown> }).sessiondb;
  if (legacy && typeof legacy === "object") {
    throw new LegacySessiondbConfigError(Object.keys(legacy));
  }

  const backend: string = (config.persistence?.backend as string | undefined) ?? "postgres";

  // ── connectionString (postgres) ──────────────────────────────────────────
  const modernPostgres = config.persistence?.postgres;
  const modernConnString = modernPostgres?.connectionString;
  const connectionString: string | undefined = modernConnString ?? process.env.MINSKY_POSTGRES_URL;

  // ── postgres sub-config (full) ───────────────────────────────────────────
  // Only populate when the active backend is postgres and a connection string
  // is available so callers don't receive a half-populated postgres sub-object.
  const resolvedPostgres: PostgresConfig | undefined =
    backend === "postgres" && connectionString
      ? ({
          ...(modernPostgres ?? {}),
          connectionString,
        } as PostgresConfig)
      : undefined;

  // mt#4789: `DATABASE_URL` is the ecosystem-conventional variable and is read
  // nowhere in this path. Setting it produces no error and no warning while the
  // resolution falls through to whatever config says — which is production.
  // Warn on the genuine ambiguity; do NOT honor it, which would be a new
  // precedence rule with its own blast radius.
  warnIgnoredDatabaseUrlOnce(detectIgnoredDatabaseUrl(connectionString, process.env.DATABASE_URL));

  return {
    backend,
    connectionString,
    postgres: resolvedPostgres,
  };
}
