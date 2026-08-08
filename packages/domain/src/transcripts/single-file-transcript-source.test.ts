/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp JSONL files exercise the real single-file read/parse/cwd-recovery path the source exists to provide */
/**
 * Tests for {@link SingleFileTranscriptSource} (mt#2320).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversationId } from "../ids";
import { SingleFileTranscriptSource } from "./single-file-transcript-source";
import type { RawTurnLine } from "./transcript-source";
import { SIDECAR_LINE_TYPES } from "./transcript-source";

/** Mint a ConversationId from a literal — the documented cast path (`ids.ts`). */
const conv = (id: string) => id as ConversationId;

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
/**
 * mt#3836: the real shape of a `last-prompt` sidecar row — `{type, leafUuid}`
 * with NO `timestamp` and NO `uuid`. The missing timestamp is load-bearing: it
 * is why every storage path drops the row on its own, and why it must not be
 * counted toward `lineIndex`.
 */
const LAST_PROMPT_LINE = JSON.stringify({ type: "last-prompt", leafUuid: "leaf-1" });
/**
 * mt#3260: the verified real shape of a `queue-operation` line — `{type,
 * operation, timestamp, sessionId}`, with NO `message` and NO `uuid`, unlike
 * every other retained type. Measured across the local transcript corpus
 * 2026-07-26 (present in 170 of 1003 files).
 */
const QUEUE_OPERATION_LINE = JSON.stringify({
  type: "queue-operation",
  operation: "enqueue",
  timestamp: "2026-06-18T00:00:02.000Z",
  sessionId: "abc-123",
});

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
    expect(d.agentSessionId).toBe(conv("abc-123"));
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
    expect(d.agentSessionId).toBe(conv("agent-deadbeef"));
  });

  test("readSession yields only retained line types", async () => {
    await writeFile(file, `${USER_LINE}\n${SUMMARY_LINE}\n${ASSISTANT_LINE}\n`);
    const src = new SingleFileTranscriptSource(file);

    const lines: RawTurnLine[] = [];
    for await (const line of src.readSession(conv("ignored-id"))) lines.push(line);

    expect(lines.map((l) => l.type)).toEqual(["user", "assistant"]);
  });

  test("readSession retains queue-operation lines (mt#3260)", async () => {
    await writeFile(file, `${USER_LINE}\n${QUEUE_OPERATION_LINE}\n${ASSISTANT_LINE}\n`);
    const src = new SingleFileTranscriptSource(file);

    const lines: RawTurnLine[] = [];
    for await (const line of src.readSession(conv("ignored-id"))) lines.push(line);

    // Before mt#3260 this line was dropped and queued-message state was
    // unrecoverable downstream.
    expect(lines.map((l) => l.type)).toEqual(["user", "queue-operation", "assistant"]);
  });

  test("readSession retains last-prompt sidecar lines (mt#3836)", async () => {
    await writeFile(file, `${USER_LINE}\n${LAST_PROMPT_LINE}\n${ASSISTANT_LINE}\n`);
    const src = new SingleFileTranscriptSource(file);

    const lines: RawTurnLine[] = [];
    for await (const line of src.readSession(conv("ignored-id"))) lines.push(line);

    // mt#3656 shipped a divergence detector that reads these rows at ingest;
    // the source dropped them, so it could never fire in production. Retaining
    // the line is what makes that detector reachable at all.
    expect(lines.map((l) => l.type)).toEqual(["user", "last-prompt", "assistant"]);
    expect(lines[1]?.leafUuid).toBe("leaf-1");
  });

  test("EVERY declared sidecar type is actually retained by the source (mt#3836 R1)", async () => {
    // The invariant the reviewer asked for. `isSidecarLineType` and each
    // source's `RETAINED_TYPES` are separate lists, so a type could be declared
    // sidecar — and therefore skipped for `lineIndex` — while the source still
    // drops it, silently starving whatever reader wanted it. That is exactly
    // the mt#3836 defect in miniature. Iterating the declared set means adding
    // a sidecar type without retaining it fails here rather than in production.
    for (const type of SIDECAR_LINE_TYPES) {
      await writeFile(file, `${USER_LINE}\n${JSON.stringify({ type })}\n${ASSISTANT_LINE}\n`);
      const src = new SingleFileTranscriptSource(file);

      const seen: RawTurnLine[] = [];
      for await (const line of src.readSession(conv("ignored-id"))) seen.push(line);

      expect(seen.map((l) => l.type)).toContain(type);
    }
  });

  test("a retained queue-operation line keeps its fields despite having no message", async () => {
    await writeFile(file, `${QUEUE_OPERATION_LINE}\n`);
    const src = new SingleFileTranscriptSource(file);

    const lines: RawTurnLine[] = [];
    for await (const line of src.readSession(conv("ignored-id"))) lines.push(line);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBeUndefined();
    expect(lines[0]?.uuid).toBeUndefined();
    expect(lines[0]?.["operation"]).toBe("enqueue");
    expect(lines[0]?.timestamp).toBe("2026-06-18T00:00:02.000Z");
  });

  test("widening the set did not start retaining genuinely unretained types", async () => {
    await writeFile(file, `${SUMMARY_LINE}\n${QUEUE_OPERATION_LINE}\n`);
    const src = new SingleFileTranscriptSource(file);

    const lines: RawTurnLine[] = [];
    for await (const line of src.readSession(conv("ignored-id"))) lines.push(line);

    expect(lines.map((l) => l.type)).toEqual(["queue-operation"]);
  });

  test("readSession ignores the agentSessionId argument (reads the bound path)", async () => {
    await writeFile(file, `${USER_LINE}\n`);
    const src = new SingleFileTranscriptSource(file);

    const lines: RawTurnLine[] = [];
    for await (const line of src.readSession(conv("a-totally-different-id"))) lines.push(line);
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
    for await (const line of src.readSession(conv("id"))) lines.push(line);
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
