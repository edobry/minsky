/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp JSONL files exercise the real single-file read/parse/cwd-recovery path the source exists to provide */
/**
 * Tests for {@link SingleFileTranscriptSource} (mt#2320).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SingleFileTranscriptSource } from "./single-file-transcript-source";
import type { RawTurnLine } from "./transcript-source";

const USER_LINE = JSON.stringify({
  type: "user",
  message: { role: "user", content: "hello" },
  cwd: "/Users/me/Projects/minsky",
  timestamp: "2026-06-18T00:00:00.000Z",
});
const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  timestamp: "2026-06-18T00:00:01.000Z",
});
const SUMMARY_LINE = JSON.stringify({ type: "summary", summary: "ignored" });

describe("SingleFileTranscriptSource", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "single-file-src-"));
    file = join(dir, "abc-123.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("discovered() derives id from filename, recovers cwd, and sets harness", async () => {
    await writeFile(file, `${USER_LINE}\n${ASSISTANT_LINE}\n`);
    const src = new SingleFileTranscriptSource(file);

    const d = await src.discovered();
    expect(d.agentSessionId).toBe("abc-123");
    expect(d.jsonlPath).toBe(file);
    expect(d.harness).toBe("claude_code");
    expect(d.isSubagent).toBe(false);
    expect(d.cwd).toBe("/Users/me/Projects/minsky");
    expect(d.mtime).toBeInstanceOf(Date);
  });

  test("detects subagent transcripts by path segment", async () => {
    const subDir = join(dir, "session-uuid", "subagents");
    await mkdir(subDir, { recursive: true });
    const subFile = join(subDir, "agent-deadbeef.jsonl");
    await writeFile(subFile, `${USER_LINE}\n`);

    const d = await new SingleFileTranscriptSource(subFile).discovered();
    expect(d.isSubagent).toBe(true);
    expect(d.agentSessionId).toBe("agent-deadbeef");
  });

  test("readSession yields only retained line types", async () => {
    await writeFile(file, `${USER_LINE}\n${SUMMARY_LINE}\n${ASSISTANT_LINE}\n`);
    const src = new SingleFileTranscriptSource(file);

    const lines: RawTurnLine[] = [];
    for await (const line of src.readSession("ignored-id")) lines.push(line);

    expect(lines.map((l) => l.type)).toEqual(["user", "assistant"]);
  });

  test("readSession ignores the agentSessionId argument (reads the bound path)", async () => {
    await writeFile(file, `${USER_LINE}\n`);
    const src = new SingleFileTranscriptSource(file);

    const lines: RawTurnLine[] = [];
    for await (const line of src.readSession("a-totally-different-id")) lines.push(line);
    expect(lines).toHaveLength(1);
  });

  test("getJsonlTimestamp validates the timestamp field", () => {
    const src = new SingleFileTranscriptSource(file);
    expect(src.getJsonlTimestamp({ type: "user", timestamp: "2026-06-18T00:00:00.000Z" })).toBe(
      "2026-06-18T00:00:00.000Z"
    );
    expect(src.getJsonlTimestamp({ type: "user", timestamp: "not-a-date" })).toBeUndefined();
    expect(src.getJsonlTimestamp({ type: "user" })).toBeUndefined();
  });

  test("cwd is undefined when no line records one", async () => {
    await writeFile(file, `${ASSISTANT_LINE}\n`); // assistant line has no cwd
    const d = await new SingleFileTranscriptSource(file).discovered();
    expect(d.cwd).toBeUndefined();
  });

  test("skips blank and malformed lines without throwing", async () => {
    await writeFile(file, `${USER_LINE}\n\nnot json\n${ASSISTANT_LINE}\n`);
    const src = new SingleFileTranscriptSource(file);

    const lines: RawTurnLine[] = [];
    for await (const line of src.readSession("id")) lines.push(line);
    expect(lines.map((l) => l.type)).toEqual(["user", "assistant"]);
  });

  test("discoverSessions yields the single session, or nothing if the file is gone", async () => {
    await writeFile(file, `${USER_LINE}\n`);
    const present: string[] = [];
    for await (const s of new SingleFileTranscriptSource(file).discoverSessions()) {
      present.push(s.agentSessionId);
    }
    expect(present).toEqual(["abc-123"]);

    const missing: string[] = [];
    for await (const s of new SingleFileTranscriptSource(
      join(dir, "gone.jsonl")
    ).discoverSessions()) {
      missing.push(s.agentSessionId);
    }
    expect(missing).toEqual([]);
  });
});
