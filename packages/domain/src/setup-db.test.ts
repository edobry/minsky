/**
 * Tests for the `minsky setup db` onboarding orchestration (mt#2429).
 *
 * Execution evidence: `bun test packages/domain/src/setup-db.test.ts`
 * exercises the pure helpers (string validation, masking, Docker one-liner)
 * and `runSetupDbConfigure` across its success path and every failure branch
 * (validate / connectivity / config-write / migrate / verify) using injected
 * deps — no live database required.
 */

import { describe, test, expect } from "bun:test";
import {
  validatePostgresConnectionString,
  maskConnectionString,
  buildDockerPostgresOneLiner,
  dockerLocalConnectionString,
  runSetupDbConfigure,
  resolveExistingPostgresConnection,
  PERSISTENCE_BACKEND_KEY,
  PERSISTENCE_CONNECTION_STRING_KEY,
  type SetupDbDeps,
  type ResolveExistingConnectionDeps,
} from "./setup-db";

const GOOD = "postgresql://postgres:secret@localhost:5432/postgres";
const CONFIG_PATH = "/tmp/config.yaml";

/** Build deps that record config writes and let each step be overridden. */
function makeDeps(overrides: Partial<SetupDbDeps> = {}): {
  deps: SetupDbDeps;
  writes: Array<{ key: string; value: unknown }>;
} {
  const writes: Array<{ key: string; value: unknown }> = [];
  const deps: SetupDbDeps = {
    configWriter: {
      async setConfigValue(key: string, value: unknown) {
        writes.push({ key, value });
        return { success: true, filePath: CONFIG_PATH };
      },
    },
    verifyConnectivity: async () => ({ ok: true }),
    runMigrations: async () => ({ success: true }),
    getStatus: async () => ({ pendingCount: 0, appliedCount: 3 }),
    ...overrides,
  };
  return { deps, writes };
}

describe("validatePostgresConnectionString", () => {
  test("accepts postgres:// and postgresql:// URLs", () => {
    expect(validatePostgresConnectionString(GOOD).ok).toBe(true);
    expect(validatePostgresConnectionString("postgres://u:p@db.example.com:5432/x").ok).toBe(true);
  });

  test("rejects empty / whitespace", () => {
    expect(validatePostgresConnectionString("").ok).toBe(false);
    expect(validatePostgresConnectionString("   ").ok).toBe(false);
  });

  test("rejects a non-URL", () => {
    expect(validatePostgresConnectionString("not a url").ok).toBe(false);
  });

  test("rejects a non-postgres scheme", () => {
    const r = validatePostgresConnectionString("http://localhost:5432/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("scheme");
  });

  test("rejects a URL without a host", () => {
    // postgres:///dbname has no host
    expect(validatePostgresConnectionString("postgres:///dbname").ok).toBe(false);
  });
});

describe("maskConnectionString", () => {
  test("masks user and password", () => {
    expect(maskConnectionString(GOOD)).toBe("postgresql://***:***@localhost:5432/postgres");
  });

  test("masks when the username is empty (PR #1666)", () => {
    expect(maskConnectionString("postgresql://:secret@host:5432/db")).toBe(
      "postgresql://***:***@host:5432/db"
    );
  });

  test("masks when the password is empty", () => {
    expect(maskConnectionString("postgresql://user:@host/db")).toBe("postgresql://***:***@host/db");
  });

  test("leaves a credential-less URI unchanged", () => {
    expect(maskConnectionString("postgresql://host:5432/db")).toBe("postgresql://host:5432/db");
  });

  test("masks an embedded connection string inside a longer error message", () => {
    const msg = 'connection refused for "postgresql://admin:hunter2@db:5432/x" — retry';
    expect(maskConnectionString(msg)).toBe(
      'connection refused for "postgresql://***:***@db:5432/x" — retry'
    );
  });
});

describe("buildDockerPostgresOneLiner / dockerLocalConnectionString", () => {
  test("one-liner embeds the password and pins postgres:17", () => {
    const line = buildDockerPostgresOneLiner("hunter2");
    expect(line).toContain("POSTGRES_PASSWORD=hunter2");
    expect(line).toContain("postgres:17");
    expect(line).toContain("-p 5432:5432");
    expect(line).toContain("minsky-pgdata");
  });

  test("local connection string matches the one-liner password", () => {
    expect(dockerLocalConnectionString("hunter2")).toBe(
      "postgresql://postgres:hunter2@localhost:5432/postgres"
    );
  });
});

describe("runSetupDbConfigure", () => {
  test("success path: validate → connectivity → write → migrate → verify", async () => {
    const { deps, writes } = makeDeps();
    const result = await runSetupDbConfigure(GOOD, deps);

    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(3);
    expect(result.pendingCount).toBe(0);
    expect(result.configPath).toBe(CONFIG_PATH);
    // backend is written FIRST (schema requires it), then the connection string.
    expect(writes.map((w) => w.key)).toEqual([
      PERSISTENCE_BACKEND_KEY,
      PERSISTENCE_CONNECTION_STRING_KEY,
    ]);
    expect(writes[0]?.value).toBe("postgres");
    expect(writes[1]?.value).toBe(GOOD);
  });

  test("invalid string fails at validate with no config writes", async () => {
    const { deps, writes } = makeDeps();
    const result = await runSetupDbConfigure("nope", deps);
    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("validate");
    expect(writes).toHaveLength(0);
  });

  test("connectivity failure stops before any config write", async () => {
    const { deps, writes } = makeDeps({
      verifyConnectivity: async () => ({ ok: false, error: "ECONNREFUSED" }),
    });
    const result = await runSetupDbConfigure(GOOD, deps);
    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("connectivity");
    expect(result.message).toContain("ECONNREFUSED");
    expect(writes).toHaveLength(0);
  });

  test("config-write failure surfaces failedStep config-write", async () => {
    const { deps } = makeDeps({
      configWriter: {
        async setConfigValue() {
          return { success: false, filePath: CONFIG_PATH, error: "Validation failed" };
        },
      },
    });
    const result = await runSetupDbConfigure(GOOD, deps);
    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("config-write");
  });

  test("migration failure surfaces failedStep migrate (config already written)", async () => {
    const { deps, writes } = makeDeps({
      runMigrations: async () => {
        throw new Error("relation already exists");
      },
    });
    const result = await runSetupDbConfigure(GOOD, deps);
    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("migrate");
    expect(result.message).toContain("relation already exists");
    // Config was written before the migrate attempt.
    expect(writes).toHaveLength(2);
  });

  test("pending migrations after migrate surface failedStep verify", async () => {
    const { deps } = makeDeps({
      getStatus: async () => ({ pendingCount: 2, appliedCount: 1 }),
    });
    const result = await runSetupDbConfigure(GOOD, deps);
    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("verify");
    expect(result.pendingCount).toBe(2);
  });
});

describe("resolveExistingPostgresConnection (mt#2502)", () => {
  function makeResolveDeps(
    overrides: Partial<ResolveExistingConnectionDeps> = {}
  ): ResolveExistingConnectionDeps {
    return {
      loadConfig: async () => ({ effectiveValues: {} }),
      verifyConnectivity: async () => ({ ok: true }),
      ...overrides,
    };
  }

  test("nothing resolves: returns found: false and never probes connectivity", async () => {
    let connectivityCalls = 0;
    const deps = makeResolveDeps({
      verifyConnectivity: async () => {
        connectivityCalls += 1;
        return { ok: true };
      },
    });

    const result = await resolveExistingPostgresConnection(deps);

    expect(result).toEqual({ found: false });
    expect(connectivityCalls).toBe(0);
  });

  test("resolves from user config: reports source label and connectivity ok", async () => {
    const deps = makeResolveDeps({
      loadConfig: async () => ({
        effectiveValues: {
          [PERSISTENCE_CONNECTION_STRING_KEY]: {
            value: GOOD,
            source: "user",
            path: PERSISTENCE_CONNECTION_STRING_KEY,
          },
        },
      }),
    });

    const result = await resolveExistingPostgresConnection(deps);

    expect(result.found).toBe(true);
    expect(result.connectionString).toBe(GOOD);
    expect(result.sourceName).toBe("user");
    expect(result.source).toContain("user config");
    expect(result.connectivity).toEqual({ ok: true });
  });

  test("resolves from repo (project) config: source label reflects repo config", async () => {
    const deps = makeResolveDeps({
      loadConfig: async () => ({
        effectiveValues: {
          [PERSISTENCE_CONNECTION_STRING_KEY]: {
            value: GOOD,
            source: "project",
            path: PERSISTENCE_CONNECTION_STRING_KEY,
          },
        },
      }),
    });

    const result = await resolveExistingPostgresConnection(deps);

    expect(result.found).toBe(true);
    expect(result.sourceName).toBe("project");
    expect(result.source).toContain("repo config");
  });

  test("resolves from environment: source label reflects environment variable", async () => {
    const deps = makeResolveDeps({
      loadConfig: async () => ({
        effectiveValues: {
          [PERSISTENCE_CONNECTION_STRING_KEY]: {
            value: GOOD,
            source: "environment",
            path: PERSISTENCE_CONNECTION_STRING_KEY,
          },
        },
      }),
    });

    const result = await resolveExistingPostgresConnection(deps);

    expect(result.found).toBe(true);
    expect(result.sourceName).toBe("environment");
    expect(result.source).toBe("environment variable");
  });

  test("resolves but connectivity check fails: found stays true, connectivity carries the error", async () => {
    const deps = makeResolveDeps({
      loadConfig: async () => ({
        effectiveValues: {
          [PERSISTENCE_CONNECTION_STRING_KEY]: {
            value: GOOD,
            source: "user",
            path: PERSISTENCE_CONNECTION_STRING_KEY,
          },
        },
      }),
      verifyConnectivity: async () => ({ ok: false, error: "ECONNREFUSED" }),
    });

    const result = await resolveExistingPostgresConnection(deps);

    expect(result.found).toBe(true);
    expect(result.connectivity).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  test("empty/whitespace-only resolved value is treated as not found", async () => {
    const deps = makeResolveDeps({
      loadConfig: async () => ({
        effectiveValues: {
          [PERSISTENCE_CONNECTION_STRING_KEY]: {
            value: "   ",
            source: "user",
            path: PERSISTENCE_CONNECTION_STRING_KEY,
          },
        },
      }),
    });

    const result = await resolveExistingPostgresConnection(deps);

    expect(result).toEqual({ found: false });
  });
});
