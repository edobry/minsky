/**
 * Tests for identifyFilesystemOrphanDirs (mt#1941).
 *
 * Verifies that session_cleanup --orphaned detects workspace directories on
 * disk that have no corresponding DB session record. This is the inverse of
 * the classic "DB orphan" (record exists, dir missing): here the dir exists
 * but the DB record is gone.
 *
 * The mt#1941 failure mode: the webhook fires and runs applyPostMergeStateSync
 * first, deleting the DB record AND the dir. Then mergeSessionPr calls
 * applyPostMergeStateSync again — pre-fix it threw "session not found"; the
 * workspace dir was never cleaned up. The result: a dir on disk with no DB
 * record. session_cleanup --orphaned missed it because identifyCleanupCandidates
 * only enumerates DB records (checking if the dir exists), never the reverse.
 *
 * Design note: these tests intentionally use real filesystem operations.
 * identifyFilesystemOrphanDirs calls readdirSync/statSync on real paths, so
 * the only way to verify its behavior is to create real directories. All dirs
 * are created under a per-test temp directory and cleaned up in afterEach.
 * An in-memory mock of `fs` would not catch the production behavior of
 * readdirSync/statSync path filtering. The custom/no-real-fs-in-tests rule
 * is disabled file-wide for this reason.
 */
/* eslint-disable custom/no-real-fs-in-tests */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { identifyFilesystemOrphanDirs } from "./session-cleanup";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";
import { SessionStatus } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable v4 UUIDs for test scenarios. Must satisfy SESSION_ID_RE:
 * /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
 * Version nibble (13th char of the canonical form) must be 1-5;
 * variant nibble (17th char) must be 8, 9, a, or b.
 */
const ORPHAN_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
const KNOWN_UUID = "11111111-2222-4333-8444-555555555555";

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: KNOWN_UUID,
    repoName: "owner/repo",
    repoUrl: "https://github.com/owner/repo",
    createdAt: new Date().toISOString(),
    taskId: "mt#1941",
    status: SessionStatus.MERGED,
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("identifyFilesystemOrphanDirs (mt#1941 — orphan detection)", () => {
  let tmpBase: string;
  let sessionsDir: string;
  let originalXdgStateHome: string | undefined;

  beforeEach(() => {
    // Each test gets a fresh temp directory. Use a fixed-prefix path to satisfy
    // the no-race-condition concern: tests run sequentially in bun test.
    tmpBase = join(tmpdir(), "minsky-test-orphan-detect");
    sessionsDir = join(tmpBase, "minsky", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    // Override XDG_STATE_HOME so getSessionsDir() returns our temp dir
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = tmpBase;
  });

  afterEach(() => {
    // Restore XDG_STATE_HOME
    if (originalXdgStateHome === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = originalXdgStateHome;
    }
    // Remove temp dir
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("returns empty array when sessions dir is empty", async () => {
    const sessionProvider = new FakeSessionProvider({ initialSessions: [] });
    const orphans = await identifyFilesystemOrphanDirs(sessionProvider);
    expect(orphans).toHaveLength(0);
  });

  it("returns empty array when all dirs have matching DB records", async () => {
    // Create dir for KNOWN_UUID
    mkdirSync(join(sessionsDir, KNOWN_UUID), { recursive: true });

    // DB has a record for KNOWN_UUID — not an orphan
    const sessionProvider = new FakeSessionProvider({
      initialSessions: [makeSessionRecord({ sessionId: KNOWN_UUID })],
    });

    const orphans = await identifyFilesystemOrphanDirs(sessionProvider);
    expect(orphans).toHaveLength(0);
  });

  it("detects a dir with no DB record as a filesystem orphan", async () => {
    // Create dir for ORPHAN_UUID — no DB record
    const orphanDir = join(sessionsDir, ORPHAN_UUID);
    mkdirSync(orphanDir, { recursive: true });

    // DB is empty (no records)
    const sessionProvider = new FakeSessionProvider({ initialSessions: [] });

    const orphans = await identifyFilesystemOrphanDirs(sessionProvider);

    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.sessionId).toBe(ORPHAN_UUID);
    expect(orphans[0]?.dirPath).toBe(orphanDir);
  });

  it("detects orphan dir but not dir with DB record when both exist", async () => {
    // Create dir for KNOWN_UUID (has DB record) and ORPHAN_UUID (no DB record)
    mkdirSync(join(sessionsDir, KNOWN_UUID), { recursive: true });
    mkdirSync(join(sessionsDir, ORPHAN_UUID), { recursive: true });

    const sessionProvider = new FakeSessionProvider({
      initialSessions: [makeSessionRecord({ sessionId: KNOWN_UUID })],
    });

    const orphans = await identifyFilesystemOrphanDirs(sessionProvider);

    // Only the orphan is returned
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.sessionId).toBe(ORPHAN_UUID);
  });

  it("skips non-directory entries (files) in sessions dir", async () => {
    // Create a file (not a dir) — should be skipped
    writeFileSync(join(sessionsDir, ".gitkeep"), "");

    const sessionProvider = new FakeSessionProvider({ initialSessions: [] });
    const orphans = await identifyFilesystemOrphanDirs(sessionProvider);

    // .gitkeep is a file, not a dir — should not appear as orphan
    expect(orphans).toHaveLength(0);
  });

  it("skips dirs whose names are not valid UUID session IDs", async () => {
    // Create dirs with non-UUID names (e.g. tool-created subdirs, temp dirs)
    mkdirSync(join(sessionsDir, "not-a-uuid"), { recursive: true });
    mkdirSync(join(sessionsDir, "some-tool-cache"), { recursive: true });
    // Also create a valid UUID orphan to confirm it is still detected
    const orphanDir = join(sessionsDir, ORPHAN_UUID);
    mkdirSync(orphanDir, { recursive: true });

    const sessionProvider = new FakeSessionProvider({ initialSessions: [] });
    const orphans = await identifyFilesystemOrphanDirs(sessionProvider);

    // Only the UUID-named dir should appear; non-UUID names are excluded
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.sessionId).toBe(ORPHAN_UUID);
  });

  it("returns empty array when sessions dir does not exist", async () => {
    // Remove the sessions dir entirely
    rmSync(sessionsDir, { recursive: true, force: true });

    const sessionProvider = new FakeSessionProvider({ initialSessions: [] });
    const orphans = await identifyFilesystemOrphanDirs(sessionProvider);

    expect(orphans).toHaveLength(0);
  });

  it("returns multiple orphans when multiple dirs have no DB record", async () => {
    // All UUIDs must satisfy SESSION_ID_RE (v4, variant bits 8/9/a/b).
    const uuids = [
      "bbbbbbbb-0001-4000-8000-000000000001",
      "bbbbbbbb-0001-4000-8000-000000000002",
      "bbbbbbbb-0001-4000-8000-000000000003",
    ];
    for (const uuid of uuids) {
      mkdirSync(join(sessionsDir, uuid), { recursive: true });
    }

    const sessionProvider = new FakeSessionProvider({ initialSessions: [] });
    const orphans = await identifyFilesystemOrphanDirs(sessionProvider);

    expect(orphans).toHaveLength(3);
    const ids = orphans.map((o) => o.sessionId).sort();
    expect(ids).toEqual(uuids.sort());
  });
});
