/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp dirs for hermetic JSONL discovery tests */
/**
 * Unit tests for ClaudeCodeTranscriptSource.
 *
 * @see mt#1350 — TranscriptSource interface + ClaudeCodeTranscriptSource adapter
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ClaudeCodeTranscriptSource } from "./claude-code-transcript-source";
import type { RawTurnLine } from "./transcript-source";

const PROJECT_DIR_NAME = "-Users-edobry-Projects-minsky";
const PROJECT_DIR_GLOB = `${PROJECT_DIR_NAME}*`;
const TOP_SESSION_ID = "abc-123";
const SUB_SESSION_ID = "agent-deadbeef";

const USER_LINE = JSON.stringify({
  type: "user",
  message: { role: "user", content: "hello" },
  uuid: "u1",
  timestamp: "2026-01-01T00:00:00.000Z",
});

const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  uuid: "u2",
  timestamp: "2026-01-01T00:00:01.000Z",
});

const PERMISSION_LINE = JSON.stringify({
  type: "permission-mode",
  permissionMode: "auto",
});

let projectsRoot: string;
let projectDir: string;

beforeAll(async () => {
  projectsRoot = await mkdtemp(join(tmpdir(), "minsky-cc-source-test-"));
  projectDir = join(projectsRoot, PROJECT_DIR_NAME);
  await mkdir(projectDir);

  await writeFile(
    join(projectDir, `${TOP_SESSION_ID}.jsonl`),
    `${[USER_LINE, PERMISSION_LINE, ASSISTANT_LINE].join("\n")}\n`
  );

  const subagentsDir = join(projectDir, TOP_SESSION_ID, "subagents");
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(join(subagentsDir, `${SUB_SESSION_ID}.jsonl`), `${USER_LINE}\n`);
});

afterAll(async () => {
  await rm(projectsRoot, { recursive: true, force: true });
});

function makeSource() {
  return new ClaudeCodeTranscriptSource({
    claudeProjectsDir: projectsRoot,
    projectDirGlob: PROJECT_DIR_GLOB,
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("ClaudeCodeTranscriptSource.discoverSessions", () => {
  test("enumerates top-level + subagent JSONL files", async () => {
    const sessions = await collect(makeSource().discoverSessions());
    const ids = sessions.map((s) => s.agentSessionId).sort();
    expect(ids).toEqual([SUB_SESSION_ID, TOP_SESSION_ID].sort());
  });

  test("flags subagent files via isSubagent", async () => {
    const sessions = await collect(makeSource().discoverSessions());
    const sub = sessions.find((s) => s.agentSessionId === SUB_SESSION_ID);
    const top = sessions.find((s) => s.agentSessionId === TOP_SESSION_ID);
    expect(sub?.isSubagent).toBe(true);
    expect(top?.isSubagent).toBe(false);
  });

  test("populates harness, jsonlPath, and mtime", async () => {
    const sessions = await collect(makeSource().discoverSessions());
    for (const s of sessions) {
      expect(s.harness).toBe("claude_code");
      expect(s.jsonlPath.endsWith(".jsonl")).toBe(true);
      expect(s.mtime).toBeInstanceOf(Date);
    }
  });

  test("returns empty when no project dirs match the glob", async () => {
    const empty = await mkdtemp(join(tmpdir(), "minsky-cc-source-empty-"));
    try {
      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: empty,
        projectDirGlob: "-no-such-project*",
      });
      expect(await collect(src.discoverSessions())).toHaveLength(0);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("returns empty when project dir exists but contains no JSONL files", async () => {
    const empty = await mkdtemp(join(tmpdir(), "minsky-cc-source-empty-proj-"));
    try {
      await mkdir(join(empty, PROJECT_DIR_NAME));
      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: empty,
        projectDirGlob: PROJECT_DIR_GLOB,
      });
      expect(await collect(src.discoverSessions())).toHaveLength(0);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("ClaudeCodeTranscriptSource.readSession", () => {
  test("yields one RawTurnLine per retained line, in source order", async () => {
    const lines = await collect(makeSource().readSession(TOP_SESSION_ID));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.type).toBe("user");
    expect(lines[1]?.type).toBe("assistant");
  });

  test("filters out non-retained types (e.g. permission-mode)", async () => {
    const lines = await collect(makeSource().readSession(TOP_SESSION_ID));
    expect(lines.every((l) => l.type === "user" || l.type === "assistant")).toBe(true);
  });

  test("yields nothing for unknown session id", async () => {
    const lines = await collect(makeSource().readSession("does-not-exist"));
    expect(lines).toHaveLength(0);
  });

  test("preserves pass-through fields (uuid, message)", async () => {
    const lines = await collect(makeSource().readSession(TOP_SESSION_ID));
    expect(lines[0]?.uuid).toBe("u1");
    expect((lines[0]?.message as { role?: string } | undefined)?.role).toBe("user");
  });

  test("skips malformed JSON lines without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minsky-cc-source-malformed-"));
    try {
      const proj = join(dir, PROJECT_DIR_NAME);
      await mkdir(proj);
      await writeFile(
        join(proj, "bad.jsonl"),
        `${["not json at all", USER_LINE, "{also not json"].join("\n")}\n`
      );
      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: dir,
        projectDirGlob: PROJECT_DIR_GLOB,
      });
      const lines = await collect(src.readSession("bad"));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.type).toBe("user");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty file produces zero turn lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minsky-cc-source-empty-file-"));
    try {
      const proj = join(dir, PROJECT_DIR_NAME);
      await mkdir(proj);
      await writeFile(join(proj, "empty.jsonl"), "");
      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: dir,
        projectDirGlob: PROJECT_DIR_GLOB,
      });
      expect(await collect(src.readSession("empty"))).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ClaudeCodeTranscriptSource.getJsonlTimestamp", () => {
  const src = new ClaudeCodeTranscriptSource();

  test("returns ISO timestamp when present and valid", () => {
    expect(src.getJsonlTimestamp({ type: "user", timestamp: "2026-01-01T00:00:00.000Z" })).toBe(
      "2026-01-01T00:00:00.000Z"
    );
  });

  test("returns undefined when timestamp field is absent", () => {
    expect(src.getJsonlTimestamp({ type: "user" })).toBeUndefined();
  });

  test("returns undefined for an unparseable timestamp string", () => {
    expect(src.getJsonlTimestamp({ type: "user", timestamp: "not-a-date" })).toBeUndefined();
  });

  test("returns undefined when timestamp is a non-string value", () => {
    // Cast through unknown because RawTurnLine declares timestamp as TimestampISO,
    // but the upstream JSONL has no runtime validation — exercise the type guard.
    expect(
      src.getJsonlTimestamp({ type: "user", timestamp: 1735689600000 } as unknown as RawTurnLine)
    ).toBeUndefined();
    expect(
      src.getJsonlTimestamp({ type: "user", timestamp: null } as unknown as RawTurnLine)
    ).toBeUndefined();
  });
});

describe("ClaudeCodeTranscriptSource.discoverSessions — defensive", () => {
  test("returns empty when claudeProjectsDir does not exist", async () => {
    const nonExistent = join(tmpdir(), "definitely-not-a-real-claude-projects-dir-mt1350");
    const src = new ClaudeCodeTranscriptSource({
      claudeProjectsDir: nonExistent,
      projectDirGlob: "*",
    });
    const sessions: unknown[] = [];
    for await (const session of src.discoverSessions()) {
      sessions.push(session);
    }
    expect(sessions).toEqual([]);
  });
});
