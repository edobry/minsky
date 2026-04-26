/**
 * Tests for environment-variable -> configuration mappings.
 *
 * Specifically guards the persistence-config wiring that boots
 * PersistenceService on Minsky MCP startup. mt#1223: MINSKY_POSTGRES_URL did
 * not auto-map to persistence.postgres.connectionString; the explicit
 * environmentMappings entry is what makes hosted-MCP startup succeed.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadEnvironmentConfiguration } from "./environment";

const TEST_POSTGRES_URL = "postgresql://user:pass@host:5432/db";

const PERSISTENCE_KEYS = [
  "MINSKY_PERSISTENCE_BACKEND",
  "MINSKY_PERSISTENCE_POSTGRES_URL",
  "MINSKY_POSTGRES_URL",
  "MINSKY_SESSIONDB_BACKEND",
  "MINSKY_SESSIONDB_POSTGRES_URL",
  "MINSKY_SESSIONDB_SQLITE_PATH",
  "MINSKY_SESSIONDB_BASE_DIR",
];

/**
 * Subset of the resolved env-loaded shape this test cares about. Defined
 * here rather than reused from the runtime schema because the live shape is
 * `z.input<...>` of nested-optional schemas, which TypeScript can't navigate
 * deeply enough for the assertions below.
 */
type ExpectedShape = {
  persistence?: {
    backend?: string;
    postgres?: { connectionString?: string };
  };
  sessiondb?: {
    postgres?: { connectionString?: string };
  };
};

function loadAsExpected(): ExpectedShape {
  return loadEnvironmentConfiguration() as ExpectedShape;
}

describe("environment configuration source — persistence mappings (mt#1223)", () => {
  let originalValues: Record<string, string | undefined>;

  beforeEach(() => {
    originalValues = {};
    for (const key of PERSISTENCE_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PERSISTENCE_KEYS) {
      const value = originalValues[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("MINSKY_POSTGRES_URL maps to persistence.postgres.connectionString", () => {
    process.env.MINSKY_POSTGRES_URL = TEST_POSTGRES_URL;
    const config = loadAsExpected();
    expect(config.persistence?.postgres?.connectionString).toBe(TEST_POSTGRES_URL);
  });

  test("MINSKY_PERSISTENCE_POSTGRES_URL maps to persistence.postgres.connectionString (mt#1267)", () => {
    // Locks in the explicit mapping for the modern var name. Without this
    // mapping the auto-conversion fallback would route it to
    // `persistence.postgres.url` (note `_URL` → `.url`, not `.connectionString`),
    // a non-schema key that the persistence factory would silently ignore. This
    // is the var name `scripts/deploy-minsky-mcp.ts` ENV_SPEC uploads to Railway.
    process.env.MINSKY_PERSISTENCE_POSTGRES_URL = TEST_POSTGRES_URL;
    const config = loadAsExpected();
    expect(config.persistence?.postgres?.connectionString).toBe(TEST_POSTGRES_URL);
  });

  test("MINSKY_SESSIONDB_POSTGRES_URL still maps to sessiondb.postgres.connectionString", () => {
    process.env.MINSKY_SESSIONDB_POSTGRES_URL = TEST_POSTGRES_URL;
    const config = loadAsExpected();
    expect(config.sessiondb?.postgres?.connectionString).toBe(TEST_POSTGRES_URL);
  });

  test("MINSKY_PERSISTENCE_BACKEND auto-maps to persistence.backend", () => {
    process.env.MINSKY_PERSISTENCE_BACKEND = "postgres";
    const config = loadAsExpected();
    expect(config.persistence?.backend).toBe("postgres");
  });

  test("MINSKY_POSTGRES_URL + MINSKY_PERSISTENCE_BACKEND together produce a complete persistence config", () => {
    process.env.MINSKY_PERSISTENCE_BACKEND = "postgres";
    process.env.MINSKY_POSTGRES_URL = TEST_POSTGRES_URL;
    const config = loadAsExpected();
    expect(config.persistence?.backend).toBe("postgres");
    expect(config.persistence?.postgres?.connectionString).toBe(TEST_POSTGRES_URL);
  });

  test("MINSKY_POSTGRES_URL does NOT route to top-level postgres.url under auto-mapping fallback", () => {
    process.env.MINSKY_POSTGRES_URL = TEST_POSTGRES_URL;
    // Cast required: `postgres` is intentionally absent from the schema. The
    // assertion is structural — checking the schema doesn't accidentally grow
    // a top-level `postgres` key from the auto-mapping fallback.
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    expect(config.postgres).toBeUndefined();
  });
});
