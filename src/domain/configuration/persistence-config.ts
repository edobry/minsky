/**
 * Effective Persistence Configuration Utility
 *
 * Encapsulates the fallback pattern for reading persistence configuration,
 * checking `config.persistence` first and falling back to the legacy
 * `config.sessiondb` shape for backward compatibility.
 */

import { getDefaultSqliteDbPath } from "../../utils/paths";
import type { Configuration } from "./schemas";

/**
 * Normalized persistence configuration resolved from either the modern
 * `persistence` key or the legacy `sessiondb` key.
 */
export interface EffectivePersistenceConfig {
  backend: "sqlite" | "postgres" | string;
  connectionString?: string;
  dbPath?: string;
}

/**
 * Resolve the effective persistence configuration from a Configuration object.
 *
 * Priority order:
 *   1. `config.persistence.*` (modern)
 *   2. `config.sessiondb.*`   (legacy)
 *   3. Environment variable `MINSKY_POSTGRES_URL` (connection string only)
 *   4. Hard-coded defaults (backend → "sqlite", dbPath → default SQLite path)
 */
export function getEffectivePersistenceConfig(config: Configuration): EffectivePersistenceConfig {
  const legacy = (config as Configuration & { sessiondb?: Record<string, unknown> }).sessiondb;

  // ── backend ──────────────────────────────────────────────────────────────
  const backend: string = config.persistence?.backend ?? legacy?.backend ?? "sqlite";

  // ── connectionString (postgres) ───────────────────────────────────────────
  const connectionString: string | undefined =
    config.persistence?.postgres?.connectionString ??
    legacy?.postgres?.connectionString ??
    legacy?.connectionString ??
    process.env.MINSKY_POSTGRES_URL;

  // ── dbPath (sqlite) ───────────────────────────────────────────────────────
  const dbPath: string | undefined =
    config.persistence?.sqlite?.dbPath ??
    legacy?.sqlite?.path ??
    legacy?.dbPath ??
    (backend === "sqlite" ? getDefaultSqliteDbPath() : undefined);

  return { backend, connectionString, dbPath };
}
