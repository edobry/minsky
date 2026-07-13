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

  return {
    backend,
    connectionString,
    postgres: resolvedPostgres,
  };
}
