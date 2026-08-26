/**
 * Rebuilding a reaped conversation's `.jsonl` from `transcript_lines` (mt#4573).
 *
 * The filesystem is injected (`RehydrationFs`) rather than touched: the
 * contract under test is "never clobber a live transcript", and a fake is the
 * only way to make the file EXIST for the branch that matters — as well as what
 * `custom/no-real-fs-in-tests` requires.
 */

import { describe, expect, test } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  encodeProjectDirName,
  reconstructJsonl,
  rehydrateTranscript,
  transcriptPathFor,
  type RehydrationFs,
} from "./transcript-rehydration";

const SESSION = "aaaaaaaa-0000-0000-0000-000000000001";
const CWD = "/Users/dev/Projects/minsky";
const HOME = "/Users/dev";

/** Minimal fake of the `.select().from().where().orderBy()` chain. */
function makeDb(lines: unknown[]): PostgresJsDatabase {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(lines.map((line) => ({ line }))),
        }),
      }),
    }),
  } as unknown as PostgresJsDatabase;
}

function makeFs(existing: Set<string>): RehydrationFs & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    exists: (p) => Promise.resolve(existing.has(p)),
    ensureDir: () => Promise.resolve(),
    writeNew: (p, c) => {
      if (existing.has(p)) return Promise.reject(new Error("EEXIST"));
      written.set(p, c);
      return Promise.resolve();
    },
  };
}

describe("project-directory encoding (mt#4573)", () => {
  test("replaces BOTH slashes and dots with dashes", () => {
    expect(encodeProjectDirName("/Users/edobry/Projects/minsky")).toBe(
      "-Users-edobry-Projects-minsky"
    );
    // The dot is the part that is easy to miss, and getting it wrong writes the
    // file somewhere the harness will never look. mt#3434's capture notes hit
    // this during the 2026-07-31 archive work and recorded it explicitly.
    expect(encodeProjectDirName("/Users/edobry/Projects/dobry.me")).toBe(
      "-Users-edobry-Projects-dobry-me"
    );
  });

  test("builds the path the harness reads from", () => {
    expect(transcriptPathFor(CWD, SESSION, HOME)).toBe(
      `/Users/dev/.claude/projects/-Users-dev-Projects-minsky/${SESSION}.jsonl`
    );
  });
});

describe("reconstructJsonl (mt#4573)", () => {
  test("emits one JSON object per line, in ordinal order, with a trailing newline", async () => {
    const db = makeDb([
      { type: "user", uuid: "u1" },
      { type: "assistant", uuid: "a1" },
    ]);

    const out = await reconstructJsonl(db, SESSION);

    expect(out).not.toBeNull();
    const lines = (out as string).split("\n");
    // Trailing newline → a final empty element. The harness APPENDS to this
    // file, so without it a resumed session's first write lands on our last line.
    expect(lines[lines.length - 1]).toBe("");
    expect(JSON.parse(lines[0] as string)).toEqual({ type: "user", uuid: "u1" });
    expect(JSON.parse(lines[1] as string)).toEqual({ type: "assistant", uuid: "a1" });
  });

  test("round-trips the parentUuid DAG, not just the text", async () => {
    // The DAG is what resume actually reads; a linearization bug would still
    // produce valid-looking JSONL, so assert the edges survive.
    const db = makeDb([
      { type: "user", uuid: "root", parentUuid: null },
      { type: "assistant", uuid: "childA", parentUuid: "root" },
      { type: "assistant", uuid: "childB", parentUuid: "root" },
    ]);

    const out = (await reconstructJsonl(db, SESSION)) as string;
    const parsed = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { uuid: string; parentUuid: string | null });

    expect(parsed.map((p) => p.parentUuid)).toEqual([null, "root", "root"]);
  });

  test("returns null — not an empty string — when nothing was captured", async () => {
    // Distinct on purpose: writing an EMPTY transcript is worse than writing
    // none, because the harness accepts it and resumes into nothing.
    expect(await reconstructJsonl(makeDb([]), SESSION)).toBeNull();
  });
});

describe("rehydrateTranscript (mt#4573)", () => {
  test("writes the reconstructed transcript when the file is gone", async () => {
    const db = makeDb([{ type: "user", uuid: "u1" }]);
    const fs = makeFs(new Set());

    const outcome = await rehydrateTranscript(db, SESSION, CWD, { home: HOME, fs });

    expect(outcome).toMatchObject({ status: "rehydrated", lineCount: 1 });
    expect(fs.written.size).toBe(1);
  });

  test("NEVER overwrites a transcript that already exists", async () => {
    // An existing file is a LIVE conversation the harness may be appending to.
    // Replacing it would discard everything past our last capture — silently,
    // since both files are valid JSONL.
    const path = transcriptPathFor(CWD, SESSION, HOME);
    const db = makeDb([{ type: "user", uuid: "u1" }]);
    const fs = makeFs(new Set([path]));

    const outcome = await rehydrateTranscript(db, SESSION, CWD, { home: HOME, fs });

    expect(outcome).toEqual({ status: "already-present", path });
    expect(fs.written.size).toBe(0);
  });

  test("writes nothing when the session has no captured lines", async () => {
    const fs = makeFs(new Set());

    const outcome = await rehydrateTranscript(makeDb([]), SESSION, CWD, { home: HOME, fs });

    expect(outcome).toEqual({ status: "nothing-captured" });
    expect(fs.written.size).toBe(0);
  });
});
