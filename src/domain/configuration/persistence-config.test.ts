/**
 * Tests for getEffectivePersistenceConfig — the unified resolver used by both
 * the persistence bootstrap (PersistenceService) and persistence-facing commands.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  getEffectivePersistenceConfig,
  _resetSessiondbDeprecationWarnedForTests,
} from "./persistence-config";
import type { Configuration } from "./schemas";
import { log } from "../../utils/logger";

const POSTGRES_URL = "postgresql://user:pass@host:5432/db";
const ALT_POSTGRES_URL = "postgresql://other:pw@host:5432/db";

function makeConfig(overrides: Partial<Configuration> & Record<string, unknown>): Configuration {
  return overrides as unknown as Configuration;
}

describe("getEffectivePersistenceConfig", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  let origEnvPostgresUrl: string | undefined;

  beforeEach(() => {
    _resetSessiondbDeprecationWarnedForTests();
    warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);
    // Clear any historical calls inherited from the global tests/setup.ts mock
    // or from prior test files in the same suite — assertions must scope to
    // calls made *during this test*.
    warnSpy.mockClear();
    origEnvPostgresUrl = process.env.MINSKY_POSTGRES_URL;
    delete process.env.MINSKY_POSTGRES_URL;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (origEnvPostgresUrl === undefined) delete process.env.MINSKY_POSTGRES_URL;
    else process.env.MINSKY_POSTGRES_URL = origEnvPostgresUrl;
  });

  test("modern `persistence.*` shape takes precedence, emits no deprecation warning", () => {
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.backend).toBe("postgres");
    expect(result.connectionString).toBe(POSTGRES_URL);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("legacy `sessiondb.*` shape resolves and emits deprecation warning once", () => {
    const config = makeConfig({
      sessiondb: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.backend).toBe("postgres");
    expect(result.connectionString).toBe(POSTGRES_URL);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("[deprecation]");
    expect(String(warnSpy.mock.calls[0][0])).toContain("sessiondb");
  });

  test("both shapes present: modern wins, no deprecation warning", () => {
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL },
      },
      sessiondb: {
        backend: "sqlite",
        postgres: { connectionString: ALT_POSTGRES_URL },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.backend).toBe("postgres");
    expect(result.connectionString).toBe(POSTGRES_URL);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("env var MINSKY_POSTGRES_URL fills connectionString when neither shape provides one", () => {
    process.env.MINSKY_POSTGRES_URL = POSTGRES_URL;
    const config = makeConfig({
      persistence: { backend: "postgres" },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.backend).toBe("postgres");
    expect(result.connectionString).toBe(POSTGRES_URL);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("legacy `sessiondb.postgres.connectionString` contributes and triggers warning", () => {
    const config = makeConfig({
      persistence: { backend: "postgres" },
      sessiondb: {
        postgres: { connectionString: POSTGRES_URL },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.connectionString).toBe(POSTGRES_URL);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("postgres.connectionString");
  });

  test("no config, no env: defaults to sqlite with default dbPath", () => {
    const config = makeConfig({});
    const result = getEffectivePersistenceConfig(config);
    expect(result.backend).toBe("sqlite");
    expect(result.dbPath).toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("deprecation warning fires at most once across many legacy-driven calls", () => {
    const config = makeConfig({
      sessiondb: { backend: "postgres", postgres: { connectionString: POSTGRES_URL } },
    });
    for (let i = 0; i < 5; i++) {
      getEffectivePersistenceConfig(config);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("legacy dbPath via `sessiondb.sqlite.path` is read and triggers warning", () => {
    const config = makeConfig({
      sessiondb: { backend: "sqlite", sqlite: { path: "/tmp/legacy.db" } },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.backend).toBe("sqlite");
    expect(result.dbPath).toBe("/tmp/legacy.db");
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
    // The partial postgres object is intentional — connectionString is supplied via env var.
    process.env.MINSKY_POSTGRES_URL = POSTGRES_URL;
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        // connectionString is intentionally omitted — supplied via env var below.
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
    expect(warnSpy).not.toHaveBeenCalled();
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

  test("legacy-only extras merged: deprecation fires and includes postgres.maxConnections in sources", () => {
    // Modern config provides connectionString (no extras), legacy provides maxConnections.
    // Legacy maxConnections should be merged in and trigger the deprecation warning.
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL },
      },
      sessiondb: {
        postgres: { maxConnections: 5 },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.postgres?.maxConnections).toBe(5);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMessage = String(warnSpy.mock.calls[0][0]);
    expect(warnMessage).toContain("[deprecation]");
    expect(warnMessage).toContain("postgres.maxConnections");
  });

  test("modern wins over legacy extras: no deprecation warning for overridden field", () => {
    // Both modern and legacy provide maxConnections; modern (10) should win over legacy (5).
    // No deprecation warning should fire for maxConnections because legacy didn't contribute.
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL, maxConnections: 10 },
      },
      sessiondb: {
        postgres: { maxConnections: 5 },
      },
    });
    const result = getEffectivePersistenceConfig(config);
    expect(result.postgres?.maxConnections).toBe(10);
    // Deprecation should NOT fire for maxConnections since modern overrides it.
    // (There may be no warning at all, or only for other fields — but not for maxConnections.)
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    for (const msg of warnCalls) {
      expect(msg).not.toContain("postgres.maxConnections");
    }
  });
});
