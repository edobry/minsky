/**
 * Tests for POST /api/conversations/:id/rehydrate (mt#4573).
 *
 * HARD sandbox constraint, mirroring `agent-focus.test.ts`: no test here ever
 * touches a real `~/.claude/projects/`. Every test injects a fake
 * `RehydrationFs` via the route's `fs` option, so the route never falls through
 * to `realRehydrationFs`.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "http";
import express from "express";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { RehydrationFs } from "@minsky/domain/transcripts/transcript-rehydration";

import { mountConversationRehydrateRoutes } from "./conversation-rehydrate";

const CONVERSATION = "aaaaaaaa-0000-0000-0000-000000000001";
const HOME = "/fake-home";
const CWD = "/Users/dev/Projects/minsky";
/** The path the harness would read — both `/` and `.` encode to `-`. */
const EXPECTED_PATH = `${HOME}/.claude/projects/-Users-dev-Projects-minsky/${CONVERSATION}.jsonl`;

/**
 * Fake covering both queries the route path issues: the route's own cwd lookup
 * (`.limit()`) and `reconstructJsonl`'s line read (`.orderBy()`).
 */
function makeFakeDb(cwdRows: unknown[], lineRows: unknown[]): PostgresJsDatabase {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(cwdRows),
    orderBy: () => Promise.resolve(lineRows),
  };
  return { select: () => chain } as unknown as PostgresJsDatabase;
}

function makeFs(existing: Set<string>): RehydrationFs & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    exists: (p) => Promise.resolve(existing.has(p)),
    ensureDir: () => Promise.resolve(),
    writeNew: (p, c) => {
      written.set(p, c);
      return Promise.resolve();
    },
  };
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function request(
  db: PostgresJsDatabase,
  fs: RehydrationFs,
  id = CONVERSATION
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  mountConversationRehydrateRoutes(app, { getDb: () => Promise.resolve(db), fs, home: HOME });
  const listening = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  server = listening;
  const addr = listening.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${id}/rehydrate`, {
    method: "POST",
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/conversations/:id/rehydrate (mt#4573)", () => {
  test("rebuilds the transcript when the file is gone", async () => {
    const db = makeFakeDb([{ cwd: CWD }], [{ line: { type: "user" } }]);
    const fs = makeFs(new Set());

    const { status, body } = await request(db, fs);

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "rehydrated", lineCount: 1 });
    // The path must be the harness's own encoding — both `/` and `.` → `-`.
    expect(body.path).toBe(EXPECTED_PATH);
    expect(fs.written.size).toBe(1);
  });

  test("reports already-present as 200 and writes nothing", async () => {
    // Success-shaped on purpose: the caller asked whether this conversation is
    // resumable, and it is. Treating it as a conflict would push a UI toward
    // offering a "force" that must never exist — an existing file is a LIVE
    // conversation the harness may be appending to.
    const path = EXPECTED_PATH;
    const db = makeFakeDb([{ cwd: CWD }], [{ line: { type: "user" } }]);
    const fs = makeFs(new Set([path]));

    const { status, body } = await request(db, fs);

    expect(status).toBe(200);
    expect(body).toEqual({ status: "already-present", path });
    expect(fs.written.size).toBe(0);
  });

  test("404s for a conversation that was never ingested", async () => {
    const { status } = await request(makeFakeDb([], []), makeFs(new Set()));
    expect(status).toBe(404);
  });

  test("422s when the conversation has no recorded cwd", async () => {
    // `claude --resume` keys its transcript directory off the cwd, so without
    // one there is no path to write to — and guessing would put the file
    // somewhere the harness never reads.
    const db = makeFakeDb([{ cwd: null }], [{ line: { type: "user" } }]);
    const fs = makeFs(new Set());

    const { status, body } = await request(db, fs);

    expect(status).toBe(422);
    expect(body.outcome).toBe("no-recorded-cwd");
    expect(fs.written.size).toBe(0);
  });

  test("422s when nothing was captured for the conversation", async () => {
    const db = makeFakeDb([{ cwd: CWD }], []);
    const fs = makeFs(new Set());

    const { status, body } = await request(db, fs);

    expect(status).toBe(422);
    expect(body).toEqual({ status: "nothing-captured" });
    expect(fs.written.size).toBe(0);
  });
});
