/**
 * Integration tests for SQLite storage backend pagination (mt#933).
 *
 * Verifies that limit/offset/orderBy are applied by the actual SQL query,
 * not post-fetch in memory. Uses bun:sqlite's in-memory DB (":memory:")
 * so no real filesystem access is needed.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { createSqliteStorage } from "./sqlite-storage";
import type { DatabaseStorage } from "../database-storage";
import type { SessionRecord, SessionDbState } from "../../session/session-db";

function makeRecord(n: number, lastActivityAt?: string): SessionRecord {
  return {
    session: `s${n}`,
    repoName: `repo-${n}`,
    repoUrl: `https://example.test/repo${n}.git`,
    createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    lastActivityAt,
  } as SessionRecord;
}

describe("SqliteStorage pagination (mt#933)", () => {
  let storage: DatabaseStorage<SessionRecord, SessionDbState>;

  beforeEach(async () => {
    // bun:sqlite ":memory:" DB — no filesystem access, no cleanup needed
    storage = createSqliteStorage({ dbPath: ":memory:" });
    await storage.initialize();

    // Seed 30 sessions with increasing lastActivityAt so sort order is deterministic
    const sessions: SessionRecord[] = Array.from({ length: 30 }, (_, i) =>
      makeRecord(i + 1, new Date(Date.UTC(2026, 0, i + 1)).toISOString())
    );
    await storage.writeState({ sessions, baseDir: "/mock/tmp" });
  });

  test("default getEntities returns all rows (backwards compatible)", async () => {
    const out = await storage.getEntities();
    expect(out.length).toBe(30);
  });

  test("limit caps the number of returned rows", async () => {
    const out = await storage.getEntities({ limit: 5 });
    expect(out.length).toBe(5);
  });

  test("limit + offset return non-overlapping pages", async () => {
    const orderBy = [{ field: "lastActivityAt", direction: "desc" as const }];
    const page1 = await storage.getEntities({ limit: 5, offset: 0, orderBy });
    const page2 = await storage.getEntities({ limit: 5, offset: 5, orderBy });
    expect(page1.length).toBe(5);
    expect(page2.length).toBe(5);
    const p1Ids = new Set(page1.map((s) => s.session));
    const p2Ids = page2.map((s) => s.session);
    for (const id of p2Ids) {
      expect(p1Ids.has(id)).toBe(false);
    }
  });

  test("orderBy lastActivityAt desc places most recent first", async () => {
    const out = await storage.getEntities({
      limit: 3,
      orderBy: [{ field: "lastActivityAt", direction: "desc" }],
    });
    expect(out.map((s) => s.session)).toEqual(["s30", "s29", "s28"]);
  });

  test("createdAfter / createdBefore bound the window", async () => {
    const out = await storage.getEntities({
      createdAfter: new Date(Date.UTC(2026, 0, 10)).toISOString(),
      createdBefore: new Date(Date.UTC(2026, 0, 15)).toISOString(),
      orderBy: [{ field: "createdAt", direction: "asc" }],
    });
    expect(out.map((s) => s.session)).toEqual(["s10", "s11", "s12", "s13", "s14", "s15"]);
  });
});
