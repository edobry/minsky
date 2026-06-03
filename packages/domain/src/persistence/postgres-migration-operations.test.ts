/**
 * Tests for postgres-migration-operations.ts — unmerged-migration guard
 * (mt#2277)
 *
 * This file tests the pure decision predicates that are separated from
 * git and connection I/O so they can be unit-tested without real DB or
 * real git infrastructure.
 */

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import {
  isProdPostgresConnection,
  checkUnmergedMigrations,
  UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV,
  type JournalEntry,
} from "./postgres-migration-operations";
import * as childProcess from "child_process";

// ---------------------------------------------------------------------------
// isProdPostgresConnection
// ---------------------------------------------------------------------------

describe("isProdPostgresConnection", () => {
  describe("local / dev connections → NOT prod", () => {
    test("localhost is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@localhost:5432/db")).toBe(false);
    });

    test("localhost with UPPER CASE host is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@LOCALHOST:5432/db")).toBe(false);
    });

    test("127.0.0.1 is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@127.0.0.1:5432/db")).toBe(false);
    });

    test("::1 (IPv6 loopback) is not prod — both bracketed and unbracketed hostname forms", () => {
      // Bun's URL.hostname keeps brackets ("[::1]"); Node's strips them ("::1").
      // The classifier matches both forms so it's correct under either runtime (mt#2277 review).
      // (Under Bun all IPv6 hosts serialize bracketed and normalized, so the unbracketed
      // "::1" pattern is defensive coverage for Node; both expanded and compact forms below
      // normalize to "[::1]" under Bun and are correctly classified non-prod.)
      expect(isProdPostgresConnection("postgresql://user:pass@[::1]:5432/db")).toBe(false);
      expect(isProdPostgresConnection("postgresql://user:pass@[0:0:0:0:0:0:0:1]:5432/db")).toBe(
        false
      );
    });

    test("host.docker.internal is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@host.docker.internal:5432/db")).toBe(
        false
      );
    });

    test("'postgres' service alias is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@postgres:5432/db")).toBe(false);
    });

    test("'db' service alias is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@db:5432/db")).toBe(false);
    });

    test("'database' service alias is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@database:5432/db")).toBe(false);
    });
  });

  describe("remote connections → IS prod", () => {
    test("Supabase Supavisor pooler host is prod", () => {
      expect(
        isProdPostgresConnection(
          "postgresql://postgres.abc:pass@aws-0-us-west-2.pooler.supabase.com:6543/postgres"
        )
      ).toBe(true);
    });

    test("Supabase direct host is prod", () => {
      expect(
        isProdPostgresConnection(
          "postgresql://postgres:pass@db.yvkkrpyjhoiilmizlnac.supabase.co:5432/postgres"
        )
      ).toBe(true);
    });

    test("Neon.tech host is prod", () => {
      expect(
        isProdPostgresConnection(
          "postgresql://user:pass@ep-quiet-forest-abc.us-east-2.aws.neon.tech:5432/db"
        )
      ).toBe(true);
    });

    test("AWS RDS host is prod", () => {
      expect(
        isProdPostgresConnection(
          "postgresql://admin:pass@mydb.cluster-xyz.us-east-1.rds.amazonaws.com:5432/mydb"
        )
      ).toBe(true);
    });

    test("any unknown remote hostname is prod (conservative)", () => {
      expect(
        isProdPostgresConnection("postgresql://user:pass@some-remote-postgres.example.com:5432/db")
      ).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("unparseable connection string is treated as prod (fail-closed)", () => {
      expect(isProdPostgresConnection("not-a-url")).toBe(true);
    });

    test("empty string is treated as prod (fail-closed)", () => {
      expect(isProdPostgresConnection("")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// checkUnmergedMigrations
// ---------------------------------------------------------------------------

/**
 * Helper to build a JournalEntry with defaults.
 */
function makeEntry(idx: number, tag: string): JournalEntry {
  return { idx, version: "7", when: 1000000 + idx, tag, breakpoints: false };
}

describe("checkUnmergedMigrations", () => {
  // We spy on child_process.execFile and util.promisify chain so we can
  // control git's exit code without a real git repo or real filesystem.

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("returns not-blocked when there are no pending entries", async () => {
    const entries = [makeEntry(0, "0000_initial"), makeEntry(1, "0001_second")];
    // appliedCount = entries.length → no pending
    const result = await checkUnmergedMigrations("migrations/pg", entries, entries.length);
    expect(result.blocked).toBe(false);
    expect(result.unmergedTags).toEqual([]);
  });

  test("returns not-blocked when all pending entries are present on origin/main", async () => {
    // Inject a git that always succeeds (all files present on main)
    const execFileMock = mock(
      (
        _file: string,
        _args: string[],
        _opts: object,
        callback: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(null, "", "");
      }
    );

    const spyExecFile = spyOn(childProcess, "execFile").mockImplementation(execFileMock as any);

    try {
      const entries = [makeEntry(0, "0000_initial"), makeEntry(1, "0001_second")];
      // 0 applied → both are pending; mock says both are on main
      const result = await checkUnmergedMigrations("migrations/pg", entries, 0, "/repo");
      expect(result.blocked).toBe(false);
      expect(result.unmergedTags).toEqual([]);
    } finally {
      spyExecFile.mockRestore();
    }
  });

  // Args-aware mock: `git rev-parse ... origin/main` succeeds (ref resolves);
  // `git cat-file -e origin/main:<path>` succeeds unless the path is in `absent`.
  function gitMock(absentTags: string[]) {
    return mock(
      (
        _file: string,
        args: string[],
        _opts: object,
        callback: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (args[0] === "rev-parse") {
          callback(null, "", ""); // origin/main resolves
          return;
        }
        const target = args[2] ?? ""; // "origin/main:<path>"
        if (absentTags.some((tag) => target.includes(tag))) {
          callback(new Error("not found") as any, "", "");
        } else {
          callback(null, "", "");
        }
      }
    );
  }

  test("returns blocked when a pending entry is NOT on origin/main", async () => {
    const spyExecFile = spyOn(childProcess, "execFile").mockImplementation(
      gitMock(["0002_third"]) as any
    );
    try {
      const entries = [
        makeEntry(0, "0000_initial"),
        makeEntry(1, "0001_second"),
        makeEntry(2, "0002_third"),
      ];
      // 1 applied → entries[1] and entries[2] are pending; only 0002_third is absent
      const result = await checkUnmergedMigrations("migrations/pg", entries, 1, "/repo");
      expect(result.blocked).toBe(true);
      expect(result.unmergedTags).toEqual(["0002_third"]);
    } finally {
      spyExecFile.mockRestore();
    }
  });

  test("returns all unmerged tags when multiple pending entries are absent from origin/main", async () => {
    const spyExecFile = spyOn(childProcess, "execFile").mockImplementation(
      gitMock(["0000_initial", "0001_second", "0002_third"]) as any
    );
    try {
      const entries = [
        makeEntry(0, "0000_initial"),
        makeEntry(1, "0001_second"),
        makeEntry(2, "0002_third"),
      ];
      // 0 applied → all 3 are pending; none on origin/main
      const result = await checkUnmergedMigrations("migrations/pg", entries, 0, "/repo");
      expect(result.blocked).toBe(true);
      expect(result.unmergedTags).toEqual(["0000_initial", "0001_second", "0002_third"]);
    } finally {
      spyExecFile.mockRestore();
    }
  });

  test("FAILS OPEN (not blocked, skippedReason set) when origin/main does not resolve", async () => {
    // rev-parse fails → guard cannot run → must NOT block (mt#2277 review fix:
    // a missing/unfetched/differently-named remote is an infra issue, not a true
    // unmerged migration).
    const execFileMock = mock(
      (
        _file: string,
        args: string[],
        _opts: object,
        callback: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (args[0] === "rev-parse") {
          callback(new Error("fatal: bad revision 'origin/main'") as any, "", "");
          return;
        }
        // cat-file would also fail, but we must never reach it
        callback(new Error("should not be called") as any, "", "");
      }
    );
    const spyExecFile = spyOn(childProcess, "execFile").mockImplementation(execFileMock as any);
    try {
      const entries = [makeEntry(0, "0000_initial"), makeEntry(1, "0001_second")];
      const result = await checkUnmergedMigrations("migrations/pg", entries, 0, "/repo");
      expect(result.blocked).toBe(false);
      expect(result.unmergedTags).toEqual([]);
      expect(result.skippedReason).toBeDefined();
      expect(result.skippedReason).toContain("origin/main");
    } finally {
      spyExecFile.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV constant
// ---------------------------------------------------------------------------

describe("UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV", () => {
  test("constant is the correct env var name", () => {
    expect(UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV).toBe("MINSKY_SKIP_UNMERGED_MIGRATION_CHECK");
  });
});
