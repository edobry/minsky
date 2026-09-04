/**
 * Tests for getEffectivePersistenceConfig — the unified resolver used by both
 * the persistence bootstrap (PersistenceService) and persistence-facing commands.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  connectionTargetHost,
  detectIgnoredDatabaseUrl,
  formatIgnoredDatabaseUrlWarning,
  getEffectivePersistenceConfig,
  LegacySessiondbConfigError,
  resolvePersistenceTargetHost,
} from "./persistence-config";
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

  test("no config, no env: defaults to postgres with no synthesized connection", () => {
    const config = makeConfig({});
    const result = getEffectivePersistenceConfig(config);
    expect(result.backend).toBe("postgres");
    // No connection string is fabricated — the factory raises a clear
    // "configure Postgres" error at provider-create time (ADR-018 / mt#2349).
    expect(result.connectionString).toBeUndefined();
    expect(result.postgres).toBeUndefined();
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

  test("postgres sub-object is present when backend is postgres", () => {
    const config = makeConfig({
      persistence: {
        backend: "postgres",
        postgres: { connectionString: POSTGRES_URL },
      },
    });
    const result = getEffectivePersistenceConfig(config);
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

/**
 * mt#4789 — `DATABASE_URL` is set, ignored, and the fallthrough is production.
 *
 * Every assertion here is on a RETURNED value. The warning's log call is
 * deliberately not asserted: `tests/setup.ts` sets `TEST_LOGGER_SILENCED_FLAG`,
 * which silences winston's Console under the in-process harness, so a test
 * watching the logger would pass whether or not the warning ever fired.
 */
describe("mt#4789 — ignored DATABASE_URL detection", () => {
  const SCRATCH_URL = "postgresql://scratch_user:scratch_pw@127.0.0.1:59999/scratch";
  const SCRATCH_HOST = "127.0.0.1:59999";
  const CONFIG_HOST = "host:5432";

  let origDatabaseUrl: string | undefined;
  let origPostgresUrl: string | undefined;

  beforeEach(() => {
    origDatabaseUrl = process.env.DATABASE_URL;
    origPostgresUrl = process.env.MINSKY_POSTGRES_URL;
    delete process.env.DATABASE_URL;
    delete process.env.MINSKY_POSTGRES_URL;
  });

  afterEach(() => {
    if (origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origDatabaseUrl;
    if (origPostgresUrl === undefined) delete process.env.MINSKY_POSTGRES_URL;
    else process.env.MINSKY_POSTGRES_URL = origPostgresUrl;
  });

  describe("connectionTargetHost", () => {
    test("returns host:port and never the credential", () => {
      const host = connectionTargetHost(POSTGRES_URL);
      expect(host).toBe(CONFIG_HOST);
      expect(host).not.toContain("pass");
      expect(host).not.toContain("user");
    });

    test("returns undefined for an absent connection string", () => {
      expect(connectionTargetHost(undefined)).toBeUndefined();
    });

    // The two malformed branches are covered separately because `new URL` is far
    // more permissive than it looks: `scheme:opaque` PARSES, with an empty host.
    // Written as one case first, this suite proved it — the input below reached
    // the parsed-but-hostless branch, not the throwing one. Both must withhold
    // the credential, which is the assertion that carries the security property;
    // the exact label is diagnostic.
    test("a string that parses with no host yields a placeholder, NOT the input", () => {
      const opaque = "not-a-url-but-has-a-secret-in-it:hunter2";
      expect(new URL(opaque).host).toBe(""); // pins the premise this case rests on
      const host = connectionTargetHost(opaque);
      expect(host).toBe("(no host)");
      expect(host).not.toContain("hunter2");
    });

    test("a string URL rejects yields a placeholder, NOT the input", () => {
      const malformed = "http://[bad:hunter2";
      expect(() => new URL(malformed)).toThrow(); // pins the premise
      const host = connectionTargetHost(malformed);
      expect(host).toBe("(unparseable)");
      expect(host).not.toContain("hunter2");
    });
  });

  describe("detectIgnoredDatabaseUrl", () => {
    test("stays silent when DATABASE_URL is unset", () => {
      expect(detectIgnoredDatabaseUrl(POSTGRES_URL, undefined)).toBeUndefined();
    });

    test("stays silent when nothing resolved at all", () => {
      // An unconfigured Postgres connection already surfaces as the provider
      // factory's explicit "configure Postgres" error; a second warning here
      // would be noise on an already-loud path.
      expect(detectIgnoredDatabaseUrl(undefined, SCRATCH_URL)).toBeUndefined();
    });

    test("stays silent when the resolved target IS DATABASE_URL", () => {
      // The bridging case: a script that sets DATABASE_URL and forwards it onto
      // a registered variable got the database it asked for.
      expect(detectIgnoredDatabaseUrl(SCRATCH_URL, SCRATCH_URL)).toBeUndefined();
    });

    test("stays silent when the two spellings name the same host", () => {
      // `postgres://` vs `postgresql://` is the same target. A byte comparison
      // alone would warn here — and a credential-shape pattern that assumed one
      // spelling has already caused a real miss in this repo (mem#808).
      const asPostgres = "postgres://user:pass@host:5432/db";
      const asPostgresql = "postgresql://user:pass@host:5432/db";
      expect(detectIgnoredDatabaseUrl(asPostgres, asPostgresql)).toBeUndefined();
    });

    test("reports both hosts when DATABASE_URL names a different target", () => {
      const finding = detectIgnoredDatabaseUrl(POSTGRES_URL, SCRATCH_URL);
      expect(finding).toEqual({ ignoredHost: SCRATCH_HOST, selectedHost: CONFIG_HOST });
    });
  });

  describe("formatIgnoredDatabaseUrlWarning", () => {
    test("names both hosts and both general overrides, and no credential", () => {
      const finding = detectIgnoredDatabaseUrl(POSTGRES_URL, SCRATCH_URL);
      if (!finding) throw new Error("expected a finding for two different hosts");
      const message = formatIgnoredDatabaseUrlWarning(finding);

      expect(message).toContain(SCRATCH_HOST);
      expect(message).toContain(CONFIG_HOST);
      // The two variables that actually redirect resolution. Naming only the
      // legacy alias is what the task's own spec got wrong.
      expect(message).toContain("MINSKY_PERSISTENCE_POSTGRES_URL");
      expect(message).toContain("MINSKY_POSTGRES_URL");

      expect(message).not.toContain("scratch_pw");
      expect(message).not.toContain("pass@");
    });
  });

  describe("getEffectivePersistenceConfig does not honor DATABASE_URL", () => {
    test("DATABASE_URL does not override a configured connection string", () => {
      // The behavioral pin for the whole task: this is the production
      // fallthrough, asserted rather than described.
      process.env.DATABASE_URL = SCRATCH_URL;
      const config = makeConfig({
        persistence: { backend: "postgres", postgres: { connectionString: POSTGRES_URL } },
      });
      const result = getEffectivePersistenceConfig(config);
      expect(result.connectionString).toBe(POSTGRES_URL);
      expect(result.connectionString).not.toBe(SCRATCH_URL);
    });

    test("negative control: MINSKY_POSTGRES_URL DOES redirect, from the same starting state", () => {
      // Distinguishes "the override mechanism is broken" from "DATABASE_URL was
      // never one of them". Without this, the test above is also satisfied by a
      // resolver that ignores every environment variable.
      process.env.DATABASE_URL = SCRATCH_URL;
      process.env.MINSKY_POSTGRES_URL = SCRATCH_URL;
      const config = makeConfig({ persistence: { backend: "postgres" } });
      const result = getEffectivePersistenceConfig(config);
      expect(result.connectionString).toBe(SCRATCH_URL);
    });
  });

  describe("resolvePersistenceTargetHost", () => {
    test("reports the host only", () => {
      const config = makeConfig({
        persistence: { backend: "postgres", postgres: { connectionString: POSTGRES_URL } },
      });
      const host = resolvePersistenceTargetHost(config);
      expect(host).toBe(CONFIG_HOST);
      expect(host).not.toContain("pass");
    });

    test("returns undefined when no connection is configured", () => {
      const config = makeConfig({ persistence: { backend: "postgres" } });
      expect(resolvePersistenceTargetHost(config)).toBeUndefined();
    });
  });
});
