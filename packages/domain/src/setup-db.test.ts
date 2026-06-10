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
  PERSISTENCE_BACKEND_KEY,
  PERSISTENCE_CONNECTION_STRING_KEY,
  type SetupDbDeps,
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
