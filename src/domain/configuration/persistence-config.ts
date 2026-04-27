/**
 * Effective Persistence Configuration Utility
 *
 * Encapsulates the fallback pattern for reading persistence configuration,
 * checking `config.persistence` first and falling back to the legacy
 * `config.sessiondb` shape for backward compatibility.
 */

import { getDefaultSqliteDbPath } from "../../utils/paths";
import { log } from "../../utils/logger";
import type { Configuration } from "./schemas";
import type { PostgresConfig, SqliteConfig } from "./schemas/persistence";

let sessiondbDeprecationWarned = false;

function warnLegacySessiondbOnce(source: string): void {
  if (sessiondbDeprecationWarned) return;
  sessiondbDeprecationWarned = true;
  log.warn(
    `[deprecation] Legacy \`sessiondb.*\` config is in use (${source}). ` +
      `Rename to \`persistence.*\` or use the \`MINSKY_PERSISTENCE_*\` env vars. ` +
      `The \`sessiondb\` key and \`MINSKY_SESSIONDB_*\` env vars still work but will be removed in a future release.`
  );
}

/**
 * Test-only reset for the warned-once flag. Not part of the public API.
 */
export function _resetSessiondbDeprecationWarnedForTests(): void {
  sessiondbDeprecationWarned = false;
}

/**
 * Normalized persistence configuration resolved from either the modern
 * `persistence` key or the legacy `sessiondb` key.
 *
 * The top-level `connectionString` and `dbPath` fields are convenience
 * aliases preserved for backward compatibility. The full `postgres` and
 * `sqlite` sub-objects carry all configured fields (including pool settings)
 * so callers that construct a `PersistenceConfig` can pass them through
 * without silently dropping `maxConnections`, `connectTimeout`, etc.
 */
export interface EffectivePersistenceConfig {
  backend: "sqlite" | "postgres" | string;
  /** Convenience alias for `postgres.connectionString`. */
  connectionString?: string;
  /** Convenience alias for `sqlite.dbPath`. */
  dbPath?: string;
  /** Full resolved postgres sub-config (present when backend is "postgres"). */
  postgres?: PostgresConfig;
  /** Full resolved sqlite sub-config (present when backend is "sqlite"). */
  sqlite?: SqliteConfig;
}

/**
 * Resolve the effective persistence configuration from a Configuration object.
 *
 * Priority order:
 *   1. `config.persistence.*` (modern)
 *   2. `config.sessiondb.*`   (legacy — emits a one-time deprecation warning)
 *   3. Environment variable `MINSKY_POSTGRES_URL` (connection string only; legacy fallback)
 *   4. Hard-coded defaults (backend → "sqlite", dbPath → default SQLite path)
 *
 * Prefer `MINSKY_PERSISTENCE_POSTGRES_URL` over `MINSKY_POSTGRES_URL` — the former flows
 * through the standard env→config mapping into `persistence.postgres.connectionString`
 * and takes priority at step 1.
 */
export function getEffectivePersistenceConfig(config: Configuration): EffectivePersistenceConfig {
  const legacy = (config as Configuration & { sessiondb?: Record<string, unknown> }).sessiondb;
  const legacyPostgres = legacy?.postgres as Record<string, unknown> | undefined;
  const legacySqlite = legacy?.sqlite as Record<string, unknown> | undefined;

  // ── backend ──────────────────────────────────────────────────────────────
  const modernBackend = config.persistence?.backend as string | undefined;
  const legacyBackend = legacy?.backend as string | undefined;
  const backend: string = modernBackend ?? legacyBackend ?? "sqlite";

  // ── connectionString (postgres) ──────────────────────────────────────────
  const modernPostgres = config.persistence?.postgres;
  const modernConnString = modernPostgres?.connectionString;
  const legacyConnString =
    (legacyPostgres?.connectionString as string | undefined) ??
    (legacy?.connectionString as string | undefined);
  const connectionString: string | undefined =
    modernConnString ?? legacyConnString ?? process.env.MINSKY_POSTGRES_URL;

  // ── postgres sub-config (full) ────────────────────────────────────────────
  // Merge legacy extras first, then modern (so modern wins), then inject the
  // resolved connectionString. Only populate when the active backend is postgres
  // so callers don't receive a stale postgres sub-object when sqlite is active.
  const resolvedPostgres: PostgresConfig | undefined =
    backend === "postgres" && connectionString
      ? ({
          ...(legacyPostgres ?? {}),
          ...(modernPostgres ?? {}),
          connectionString,
        } as PostgresConfig)
      : undefined;

  // ── dbPath (sqlite) ──────────────────────────────────────────────────────
  const modernDbPath = config.persistence?.sqlite?.dbPath;
  const legacyDbPath =
    (legacySqlite?.path as string | undefined) ?? (legacy?.dbPath as string | undefined);
  const dbPath: string | undefined =
    modernDbPath ?? legacyDbPath ?? (backend === "sqlite" ? getDefaultSqliteDbPath() : undefined);

  // ── sqlite sub-config (full) ─────────────────────────────────────────────
  // Only populate when the active backend is sqlite.
  const resolvedSqlite: SqliteConfig | undefined =
    backend === "sqlite" && dbPath ? { dbPath } : undefined;

  // ── deprecation warning ──────────────────────────────────────────────────
  // Warn only when legacy values actually *contribute* to the effective config —
  // i.e. the modern shape didn't cover a field that the legacy shape did. If both
  // shapes are present, modern wins silently (no warning).
  const legacyContributedBackend = legacyBackend !== undefined && modernBackend === undefined;
  const legacyContributedConnString =
    legacyConnString !== undefined && modernConnString === undefined;
  const legacyContributedDbPath = legacyDbPath !== undefined && modernDbPath === undefined;
  if (legacyContributedBackend || legacyContributedConnString || legacyContributedDbPath) {
    const sources: string[] = [];
    if (legacyContributedBackend) sources.push("backend");
    if (legacyContributedConnString) sources.push("postgres.connectionString");
    if (legacyContributedDbPath) sources.push("sqlite.dbPath");
    warnLegacySessiondbOnce(`sessiondb.{${sources.join(", ")}}`);
  }

  return {
    backend,
    connectionString,
    dbPath,
    postgres: resolvedPostgres,
    sqlite: resolvedSqlite,
  };
}
