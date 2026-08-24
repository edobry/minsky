/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp transcript files exercise the real seed/tail/process path; fs.watch integration is covered by scripts/smoke-transcript-watcher.ts */
/**
 * Tests for the testable core of the cockpit transcript watcher (mt#2320):
 * `seedExisting` + `processFile` gating, registry updates, and the per-path
 * in-flight guard — with an injected ingest spy (no DB, no fs.watch).
 *
 * The fs.watch event wiring + real ingest are verified end-to-end by
 * `scripts/smoke-transcript-watcher.ts` (env-gated on DATABASE_URL).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TranscriptWatcher } from "./transcript-watcher";
import { TranscriptWatcherTracker } from "./transcript-watcher-tracker";

const userLine = (text: string, ts: string) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    cwd: "/c",
    timestamp: ts,
  });

async function writeLines(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.length ? `${lines.join("\n")}\n` : "");
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("TranscriptWatcher core (mt#2320)", () => {
  let root: string;
  let tracker: TranscriptWatcherTracker;
  let ingestCalls: string[];
  let ingestReturn: number;
  let gate: Deferred | null;

  const makeWatcher = () =>
    new TranscriptWatcher({
      claudeProjectsDir: root,
      tracker,
      ingestFile: async (path: string) => {
        ingestCalls.push(path);
        if (gate) await gate.promise;
        return ingestReturn;
      },
    });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "transcript-watcher-"));
    tracker = TranscriptWatcherTracker.resetForTest();
    ingestCalls = [];
    ingestReturn = 1;
    gate = null;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("seedExisting registers existing transcripts (incl. subagents) and seeds offsets to EOF", async () => {
    const rootSession = join(root, "proj-a", "sess-1.jsonl");
    const subSession = join(root, "proj-a", "sess-1", "subagents", "agent-x.jsonl");
    await writeLines(rootSession, [userLine("hi", "2026-06-18T00:00:00.000Z")]);
    await writeLines(subSession, [userLine("sub", "2026-06-18T00:00:00.000Z")]);

    const watcher = makeWatcher();
    const count = await watcher.seedExisting();
    expect(count).toBe(2);

    const sessions = tracker.getActiveSessions();
    expect(sessions.map((s) => s.agentSessionId).sort()).toEqual(["agent-x", "sess-1"]);
    expect(sessions.find((s) => s.agentSessionId === "agent-x")?.isSubagent).toBe(true);
    expect(tracker.getSummary().filesWatched).toBe(2);

    // Offset seeded to EOF → an unchanged file does NOT trigger ingest.
    await watcher.processFile(rootSession);
    expect(ingestCalls).toEqual([]);
  });

  test("processFile ingests when new content is appended after seeding", async () => {
    const session = join(root, "proj-a", "sess-1.jsonl");
    await writeLines(session, [userLine("first", "2026-06-18T00:00:00.000Z")]);

    const watcher = makeWatcher();
    await watcher.seedExisting();

    await appendFile(session, `${userLine("second", "2026-06-18T00:00:01.000Z")}\n`);
    ingestReturn = 1;
    await watcher.processFile(session);

    expect(ingestCalls).toEqual([session]);
    const entry = tracker.getActiveSessions().find((s) => s.agentSessionId === "sess-1");
    expect(entry?.lastIngestAt).not.toBeNull();
    expect(entry?.lastTurnsIngested).toBe(1);
  });

  test("processFile ingests a brand-new (unseeded) file from the start and registers it", async () => {
    const session = join(root, "proj-a", "new-session.jsonl");
    await writeLines(session, [userLine("hello", "2026-06-18T00:00:00.000Z")]);

    const watcher = makeWatcher();
    await watcher.processFile(session);

    expect(ingestCalls).toEqual([session]);
    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).toContain("new-session");
  });

  test("processFile skips ingest when only an incomplete (newline-less) line is present", async () => {
    const session = join(root, "proj-a", "partial.jsonl");
    await mkdir(dirname(session), { recursive: true });
    await writeFile(session, '{"type":"user","message":'); // no trailing newline

    const watcher = makeWatcher();
    await watcher.processFile(session);

    expect(ingestCalls).toEqual([]);
    // Still registered (we observed an event for it).
    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).toContain("partial");
  });

  test("processFile on a vanished file removes it from the registry and does not ingest", async () => {
    const session = join(root, "proj-a", "ghost.jsonl");
    await writeLines(session, [userLine("x", "2026-06-18T00:00:00.000Z")]);
    const watcher = makeWatcher();
    await watcher.seedExisting();
    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).toContain("ghost");

    await rm(session);
    await watcher.processFile(session);

    expect(ingestCalls).toEqual([]);
    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).not.toContain("ghost");
  });

  test("per-path in-flight guard ingests once under concurrent processing", async () => {
    const session = join(root, "proj-a", "busy.jsonl");
    await writeLines(session, [userLine("a", "2026-06-18T00:00:00.000Z")]);
    const watcher = makeWatcher();

    gate = deferred();
    const p1 = watcher.processFile(session); // enters, adds in-flight, awaits ingest gate
    const p2 = watcher.processFile(session); // sees in-flight → no-op
    gate.resolve();
    await Promise.all([p1, p2]);

    expect(ingestCalls).toEqual([session]);
  });
});

describe("TranscriptWatcher DB handle across a pool recycle (mt#4480)", () => {
  /**
   * The watcher cached its DB handle for the life of the process. A pool
   * recycle (mt#3638) ENDS the old `Sql` instance and postgres-js then rejects
   * every query on a handle derived from it with `CONNECTION_ENDED` forever, so
   * one recycle silently killed the PRIMARY transcript-capture path and left
   * freshness to the 30-minute sweep backstop. Measured on a live daemon before
   * the fix: 47 ingests triggered, 16 succeeded, 31 errored, with `lastIngestAt`
   * 75 minutes stale while `lastErrorAt` was current.
   */
  test("re-resolves the handle after the persistence epoch moves", async () => {
    const first = { id: "before-recycle" } as unknown as Parameters<typeof Object.freeze>[0];
    const second = { id: "after-recycle" } as unknown as Parameters<typeof Object.freeze>[0];

    let epoch = 0;
    const handedOut: unknown[] = [];
    const watcher = new TranscriptWatcher({
      claudeProjectsDir: "/nonexistent",
      tracker: TranscriptWatcherTracker.resetForTest(),
      getEpoch: () => epoch,
      getDb: async () => {
        const db = epoch === 0 ? first : second;
        handedOut.push(db);
        return db as never;
      },
    });

    const resolve = (watcher as unknown as { resolveDb: () => Promise<unknown> }).resolveDb.bind(
      watcher
    );

    expect(await resolve()).toBe(first);
    // Cached within one epoch: the resolver is not called again.
    expect(await resolve()).toBe(first);
    expect(handedOut).toHaveLength(1);

    // The recycle.
    epoch = 1;

    expect(await resolve()).toBe(second);
    expect(handedOut).toHaveLength(2);
  });

  test("a null handle is not cached, so a not-yet-ready container is retried", async () => {
    let ready = false;
    const live = { id: "live" };
    const watcher = new TranscriptWatcher({
      claudeProjectsDir: "/nonexistent",
      tracker: TranscriptWatcherTracker.resetForTest(),
      getEpoch: () => 0,
      getDb: async () => (ready ? (live as never) : null),
    });

    const resolve = (watcher as unknown as { resolveDb: () => Promise<unknown> }).resolveDb.bind(
      watcher
    );

    expect(await resolve()).toBeNull();
    ready = true;
    expect(await resolve()).toBe(live);
  });
});
