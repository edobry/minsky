/**
 * `minsky setup db` — onboarding orchestration (mt#2429).
 *
 * Now that Postgres is required (mt#2349), a brand-new user boots into
 * "DB-unavailable mode" with only a "configure Postgres" error and no guided
 * path. This module owns the REAL onboarding friction — validating a Postgres
 * connection string, writing it to config, running migrations, and verifying
 * connectivity — independent of any interactive prompting (which lives in the
 * adapter: `src/adapters/shared/commands/setup-db.ts`).
 *
 * Per the mt#2395 design (§Decision), the wizard does NOT supervise a Docker
 * container; it owns config-write + migrate + verify and defers *running* the
 * DB to the user's existing tools.
 *
 * The functions here are pure / dependency-injected so they unit-test without a
 * live database and the smoke script (`scripts/smoke-setup-db.ts`) can drive the
 * full config-write → migrate → verify chain against a throwaway DB + temp
 * config dir.
 */

import { getErrorMessage } from "./errors/index";
import { createConfigWriter, type ConfigWriter } from "./configuration/config-writer";
import { verifyPostgresConnectivity } from "./persistence/validation-operations";
import {
  runPostgresSchemaMigrations,
  getPostgresMigrationsStatus,
} from "./persistence/postgres-migration-operations";

/** The config key paths the wizard writes (backend FIRST — the schema requires it). */
export const PERSISTENCE_BACKEND_KEY = "persistence.backend";
export const PERSISTENCE_CONNECTION_STRING_KEY = "persistence.postgres.connectionString";

/**
 * Mask the user/password in a Postgres connection string for display.
 * Mirrors the masking used across persistence operations.
 */
export function maskConnectionString(connectionString: string): string {
  return connectionString.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@");
}

/**
 * Validate that a string is a usable Postgres connection URL.
 * Accepts the `postgres://` and `postgresql://` schemes and requires a host.
 */
export function validatePostgresConnectionString(
  connectionString: string
): { ok: true } | { ok: false; error: string } {
  const trimmed = connectionString.trim();
  if (!trimmed) {
    return { ok: false, error: "Connection string is empty." };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: `Not a valid URL. Expected e.g. postgresql://user:password@host:5432/dbname`, // gitleaks:allow — placeholder, not a real credential
    };
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return {
      ok: false,
      error: `Unsupported scheme "${url.protocol.replace(/:$/, "")}". Use postgres:// or postgresql://`,
    };
  }

  if (!url.hostname) {
    return { ok: false, error: "Connection string has no host." };
  }

  return { ok: true };
}

/**
 * Build the copy-paste Docker one-liner the wizard prints for the
 * Docker-present branch. Minsky does NOT run or supervise this container
 * (mt#2395 §Decision) — it only captures the resulting connection string.
 */
export function buildDockerPostgresOneLiner(password: string): string {
  return (
    `docker run -d --name minsky-pg ` +
    `-e POSTGRES_PASSWORD=${password} ` +
    `-p 5432:5432 ` +
    `-v minsky-pgdata:/var/lib/postgresql/data ` +
    `postgres:17`
  );
}

/**
 * The local connection string that results from {@link buildDockerPostgresOneLiner}.
 * Offered as the default prompt value in the Docker branch.
 */
export function dockerLocalConnectionString(password: string): string {
  return `postgresql://postgres:${password}@localhost:5432/postgres`; // gitleaks:allow — ${password} is a template variable, not a committed secret
}

/** Injectable dependencies — defaults wire the real persistence/config stack. */
export interface SetupDbDeps {
  /** Override the user config directory (tests / smoke). Ignored if `configWriter` is set. */
  configDir?: string;
  /** Fully-injected config writer (overrides `configDir`). */
  configWriter?: Pick<ConfigWriter, "setConfigValue">;
  /** Connectivity probe (default: real `SELECT 1`). */
  verifyConnectivity?: (connectionString: string) => Promise<{ ok: boolean; error?: string }>;
  /** Schema migration runner (default: real drizzle migrate). */
  runMigrations?: (connectionString: string, options: { dryRun: boolean }) => Promise<unknown>;
  /** Post-migrate status check (default: real ledger query). */
  getStatus?: (connectionString: string) => Promise<{ pendingCount: number; appliedCount: number }>;
}

/** Step at which {@link runSetupDbConfigure} failed (when `success` is false). */
export type SetupDbFailedStep = "validate" | "connectivity" | "config-write" | "migrate" | "verify";

export interface SetupDbResult {
  success: boolean;
  message: string;
  configPath?: string;
  appliedCount?: number;
  pendingCount?: number;
  failedStep?: SetupDbFailedStep;
  error?: string;
}

/**
 * Configure Postgres persistence from a connection string: validate → verify
 * connectivity → write config (backend, then connection string) → run pending
 * migrations → verify the schema is up to date.
 *
 * Re-runnable / idempotent: writing the two keys updates them in place without
 * corrupting other config, and re-running against an already-migrated DB is a
 * no-op migrate + a clean verify.
 *
 * Never throws — every failure mode is returned as a `SetupDbResult` with
 * `success: false` and a `failedStep` so the caller can render an actionable
 * message.
 */
export async function runSetupDbConfigure(
  connectionString: string,
  deps: SetupDbDeps = {}
): Promise<SetupDbResult> {
  const verifyConnectivity = deps.verifyConnectivity ?? verifyPostgresConnectivity;
  const runMigrations = deps.runMigrations ?? runPostgresSchemaMigrations;
  const getStatus =
    deps.getStatus ??
    (async (cs: string) => {
      const status = await getPostgresMigrationsStatus(cs);
      return { pendingCount: status.pendingCount, appliedCount: status.appliedCount };
    });
  const configWriter = deps.configWriter ?? createConfigWriter({ configDir: deps.configDir });

  const masked = maskConnectionString(connectionString);

  // 1. Validate format
  const validation = validatePostgresConnectionString(connectionString);
  if (!validation.ok) {
    return {
      success: false,
      failedStep: "validate",
      error: validation.error,
      message: `Invalid Postgres connection string: ${validation.error}`,
    };
  }

  // 2. Verify connectivity BEFORE mutating config
  const connectivity = await verifyConnectivity(connectionString);
  if (!connectivity.ok) {
    return {
      success: false,
      failedStep: "connectivity",
      error: connectivity.error,
      message:
        `Could not connect to ${masked}: ${connectivity.error ?? "unknown error"}.\n` +
        `Verify the database is running and the connection string is correct, then re-run.`,
    };
  }

  // 3. Write config — backend FIRST (the persistence schema requires `backend`,
  // so writing the connection string alone would fail validation), then the
  // connection string.
  const backendWrite = await configWriter.setConfigValue(PERSISTENCE_BACKEND_KEY, "postgres");
  if (!backendWrite.success) {
    return {
      success: false,
      failedStep: "config-write",
      error: backendWrite.error,
      message: `Failed to write ${PERSISTENCE_BACKEND_KEY}: ${backendWrite.error ?? "unknown error"}`,
    };
  }
  const csWrite = await configWriter.setConfigValue(
    PERSISTENCE_CONNECTION_STRING_KEY,
    connectionString
  );
  if (!csWrite.success) {
    return {
      success: false,
      failedStep: "config-write",
      error: csWrite.error,
      configPath: csWrite.filePath,
      message: `Failed to write ${PERSISTENCE_CONNECTION_STRING_KEY}: ${csWrite.error ?? "unknown error"}`,
    };
  }
  const configPath = csWrite.filePath;

  // 4. Run pending migrations
  try {
    await runMigrations(connectionString, { dryRun: false });
  } catch (error) {
    return {
      success: false,
      failedStep: "migrate",
      error: getErrorMessage(error),
      configPath,
      message:
        `Connection string written to ${configPath}, but migrations failed: ` +
        `${getErrorMessage(error)}`,
    };
  }

  // 5. Verify schema is up to date
  try {
    const status = await getStatus(connectionString);
    if (status.pendingCount > 0) {
      return {
        success: false,
        failedStep: "verify",
        configPath,
        appliedCount: status.appliedCount,
        pendingCount: status.pendingCount,
        message:
          `Migrations ran but ${status.pendingCount} migration(s) are still pending. ` +
          `Re-run \`minsky persistence migrate --execute\`.`,
      };
    }
    return {
      success: true,
      configPath,
      appliedCount: status.appliedCount,
      pendingCount: status.pendingCount,
      message:
        `Postgres configured: wrote connection to ${configPath}, ` +
        `${status.appliedCount} migration(s) applied, schema verified.`,
    };
  } catch (error) {
    return {
      success: false,
      failedStep: "verify",
      error: getErrorMessage(error),
      configPath,
      message:
        `Connection string written and migrations ran, but the post-migrate ` +
        `verification query failed: ${getErrorMessage(error)}`,
    };
  }
}
