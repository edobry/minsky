/**
 * Tests for getEffectivePersistenceConfig — the unified resolver used by both
 * the persistence bootstrap (PersistenceService) and persistence-facing commands.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getEffectivePersistenceConfig, LegacySessiondbConfigError } from "./persistence-config";
import type { Configuration } from "./schemas";

const POSTGRES_URL = "postgresql://user:pass@host:5432/db";

function makeConfig(overrides: Partial<Configuration> & Record<string, unknown>): Configuration {
  return overrides as unknown as Configuration;
}

describe("getEffectivePersistenceConfig", () => {
  let origEnvPostgresUrl: string | undefined;

  beforeEach(() => {
    origEnvPostgresUrl = process.env.MINSKY_POSTGRES_URL;
    delete process.env.MINSKY_POSTGRES_URL;
  });

  afterEach(() => {
    if (origEnvPostgresUrl === undefined) delete process.env.MINSKY_POSTGRES_URL;
    else process.env.MINSKY_POSTGRES_URL = origEnvPostgresUrl;
  });

  test("modern `persistence.*` shape resolves correctly", () => {
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.backend).toBe("postgres");
    expect(result.connectionString).toBe(POSTGRES_URL);
  });

  test("env var MINSKY_POSTGRES_URL fills connectionString when persistence does not provide one", () => {
    process.env.MINSKY_POSTGRES_URL = POSTGRES_URL;
    const config = makeConfig({
      persistence: { backend: "postgres" },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.backend).toBe("postgres");
    expect(result.connectionString).toBe(POSTGRES_URL);
  });

  test("no config, no env: defaults to sqlite with default dbPath", () => {
    const config = makeConfig({});
    const result = getEffectivePersistenceConfig(config);
    expect(result.backend).toBe("sqlite");
    expect(result.dbPath).toBeTruthy();
  });

  test("postgres.maxConnections is preserved on the returned postgres sub-object", () => {
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL, maxConnections: 5 },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.postgres?.connectionString).toBe(POSTGRES_URL);
    expect(result.postgres?.maxConnections).toBe(5);
  });

  test("postgres extras (maxConnections, connectTimeout, idleTimeout, prepareStatements) all preserved", () => {
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: {
          connectionString: POSTGRES_URL,
          maxConnections: 7,
          connectTimeout: 15,
          idleTimeout: 60,
          prepareStatements: false,
        },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.postgres).toEqual({
      connectionString: POSTGRES_URL,
      maxConnections: 7,
      connectTimeout: 15,
      idleTimeout: 60,
      prepareStatements: false,
    });
  });

  test("sqlite sub-object is populated with dbPath when backend is sqlite", () => {
    const config = makeConfig({
      persistence: {
        backend: "sqlite",
        sqlite: { dbPath: "/tmp/explicit.db" },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.sqlite?.dbPath).toBe("/tmp/explicit.db");
  });

  test("env-var connectionString is merged with modern postgres extras", () => {
    // connectionString comes from env; modern postgres block carries extras but no connectionString.
    process.env.MINSKY_POSTGRES_URL = POSTGRES_URL;
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: { maxConnections: 9, connectTimeout: 30 } as unknown as {
          connectionString: string;
          maxConnections?: number;
          connectTimeout?: number;
        },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.postgres?.connectionString).toBe(POSTGRES_URL);
    expect(result.postgres?.maxConnections).toBe(9);
    expect(result.postgres?.connectTimeout).toBe(30);
  });

  test("postgres sub-object is absent when backend is sqlite", () => {
    process.env.MINSKY_POSTGRES_URL = POSTGRES_URL;
    const config = makeConfig({
      persistence: { backend: "sqlite", sqlite: { dbPath: "/tmp/test.db" } },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.postgres).toBeUndefined();
    expect(result.sqlite?.dbPath).toBe("/tmp/test.db");
  });

  test("sqlite sub-object is absent when backend is postgres", () => {
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.sqlite).toBeUndefined();
    expect(result.postgres?.connectionString).toBe(POSTGRES_URL);
  });

  test("throws LegacySessiondbConfigError when config contains a sessiondb block", () => {
    const config = makeConfig({
      sessiondb: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL },
      },
    });
    expect(() => getEffectivePersistenceConfig(config)).toThrow(LegacySessiondbConfigError);
  });

  test("LegacySessiondbConfigError message includes the detected legacy fields and migration guidance", () => {
    const config = makeConfig({
      sessiondb: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL },
        sqlite: { path: "/tmp/legacy.db" },
      },
    });
    let caught: unknown;
    try {
      getEffectivePersistenceConfig(config);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LegacySessiondbConfigError);
    const err = caught as LegacySessiondbConfigError;
    expect(err.detectedFields).toEqual(expect.arrayContaining(["backend", "postgres", "sqlite"]));
    expect(err.message).toContain("persistence:");
    expect(err.message).toContain("mt#1610");
  });

  test("LegacySessiondbConfigError fires even when config also has a valid persistence block", () => {
    // The error is loud-fail-on-legacy regardless of whether persistence is also configured.
    // This prevents silent strip + "modern wins" ambiguity.
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL },
      },
      sessiondb: {
        backend: "sqlite",
      },
    });
    expect(() => getEffectivePersistenceConfig(config)).toThrow(LegacySessiondbConfigError);
  });
});
