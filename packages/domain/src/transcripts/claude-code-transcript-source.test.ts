/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp dirs for hermetic JSONL discovery tests */
/**
 * Unit tests for ClaudeCodeTranscriptSource.
 *
 * @see mt#1350 — TranscriptSource interface + ClaudeCodeTranscriptSource adapter
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  ClaudeCodeTranscriptSource,
  MAX_SUBAGENT_TREE_DEPTH,
} from "./claude-code-transcript-source";
import type { ConversationId } from "../ids";
import type { RawTurnLine } from "./transcript-source";

/** Mint a ConversationId from a literal — the documented cast path (`ids.ts`). */
const conv = (id: string) => id as ConversationId;

const PROJECT_DIR_NAME = "-Users-edobry-Projects-minsky";
const PROJECT_DIR_GLOB = `${PROJECT_DIR_NAME}*`;
/** What `PROJECT_DIR_NAME` derives to via the project-dir fallback (`-` → `/`). */
const DERIVED_PROJECT_CWD = "/Users/edobry/Projects/minsky";
const TOP_SESSION_ID = conv("abc-123");
const SUB_SESSION_ID = conv("agent-deadbeef");
/** Mirrors `SUBAGENTS_DIR` in the source; the fixtures build real paths. */
const SUBAGENTS_DIR_NAME = "subagents";

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

  test("populates cwd from project-dir convention when JSONL has no cwd field (mt#1445)", async () => {
    // Existing fixture USER_LINE has no `cwd` field, so the source falls back
    // to the project-dir-derivation path: PROJECT_DIR_NAME =
    // "-Users-edobry-Projects-minsky" decodes to "/Users/edobry/Projects/minsky".
    const sessions = await collect(makeSource().discoverSessions());
    const top = sessions.find((s) => s.agentSessionId === TOP_SESSION_ID);
    expect(top?.cwd).toBe("/Users/edobry/Projects/minsky");
  });

  test("subagent sessions also get the project-dir cwd fallback when JSONL has no cwd (mt#1445 R1 BLOCKING)", async () => {
    // Subagent transcripts live at <projectDir>/<sessionId>/subagents/<file>.jsonl,
    // so scanDir passes the `subagents/` directory to recoverCwd. The fallback
    // must walk up two levels to find the project dir whose basename starts
    // with `-`. R1 caught that the original implementation only checked the
    // immediate parent — subagents would silently get cwd=undefined.
    const sessions = await collect(makeSource().discoverSessions());
    const sub = sessions.find((s) => s.agentSessionId === SUB_SESSION_ID);
    expect(sub?.cwd).toBe(DERIVED_PROJECT_CWD);
  });

  test("populates cwd from JSONL turn when present, preferring it over the project-dir fallback (mt#1445)", async () => {
    // Stand up a fresh fixture in a separate temp root so we can write a
    // user line that includes the explicit cwd field.
    const altRoot = await mkdtemp(join(tmpdir(), "minsky-cc-source-cwd-"));
    try {
      const altProjectDirName = "-Users-foo-Projects-bar";
      const altProjectDir = join(altRoot, altProjectDirName);
      await mkdir(altProjectDir);
      const sessionWithCwd = "session-with-cwd";
      const userLineWithCwd = JSON.stringify({
        type: "user",
        message: { role: "user", content: "hi" },
        cwd: "/Users/foo/Projects/bar-with-dashes",
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      await writeFile(join(altProjectDir, `${sessionWithCwd}.jsonl`), `${userLineWithCwd}\n`);

      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: altRoot,
        projectDirGlob: `${altProjectDirName}*`,
      });
      const sessions = await collect(src.discoverSessions());
      const session = sessions.find((s) => s.agentSessionId === sessionWithCwd);
      // The JSONL-recorded cwd is preferred — note it contains a `-` that
      // would have been mangled by the fallback derivation.
      expect(session?.cwd).toBe("/Users/foo/Projects/bar-with-dashes");
    } finally {
      await rm(altRoot, { recursive: true, force: true });
    }
  });

  test("returns undefined cwd when JSONL has no cwd and project-dir doesn't match the convention (mt#1445)", async () => {
    // A project dir whose name doesn't start with "-" can't be reverse-mapped.
    const altRoot = await mkdtemp(join(tmpdir(), "minsky-cc-source-no-cwd-"));
    try {
      const oddProjectDirName = "no-leading-dash-here";
      const oddProjectDir = join(altRoot, oddProjectDirName);
      await mkdir(oddProjectDir);
      const sessionId = "session-no-cwd";
      const lineWithoutCwd = JSON.stringify({
        type: "user",
        message: { role: "user", content: "hi" },
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      await writeFile(join(oddProjectDir, `${sessionId}.jsonl`), `${lineWithoutCwd}\n`);

      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: altRoot,
        projectDirGlob: oddProjectDirName,
      });
      const sessions = await collect(src.discoverSessions());
      const session = sessions.find((s) => s.agentSessionId === sessionId);
      expect(session?.cwd).toBeUndefined();
    } finally {
      await rm(altRoot, { recursive: true, force: true });
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

describe("ClaudeCodeTranscriptSource — nested subagent transcripts (mt#3294)", () => {
  const NESTED_ID = "agent-nested-wf";
  const DEEPER_ID = "agent-nested-twice";

  async function makeNestedFixture(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "minsky-cc-source-nested-"));
    const proj = join(dir, PROJECT_DIR_NAME);
    // The real shape the harness produces:
    // <projectDir>/<sessionId>/subagents/workflows/<wf-id>/<agent>.jsonl
    const wfDir = join(proj, "parent-session", SUBAGENTS_DIR_NAME, "workflows", "wf_abc123");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, `${NESTED_ID}.jsonl`), `${USER_LINE}\n`);
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  test("discovers a transcript under subagents/workflows/<wf-id>/", async () => {
    const { dir, cleanup } = await makeNestedFixture();
    try {
      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: dir,
        projectDirGlob: PROJECT_DIR_GLOB,
      });
      const sessions = await collect(src.discoverSessions());
      const found = sessions.find((s) => s.agentSessionId === NESTED_ID);

      expect(found).toBeDefined();
      // Everything under `subagents/` is a subagent transcript, at any depth.
      expect(found?.isSubagent).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("skips a Workflow run journal, which is not a conversation (mt#4480)", async () => {
    // The Workflow tool writes `journal.jsonl` beside the agent transcripts in
    // the same `subagents/workflows/<wf-id>/` directory mt#3294 taught this
    // walk to recurse into. Discovery yielded it as a session whose id was the
    // literal string "journal", which then showed up permanently in
    // `transcripts list --check-disk-coverage` as an on-disk conversation that
    // had never been ingested and never could be.
    const dir = await mkdtemp(join(tmpdir(), "minsky-cc-source-journal-"));
    try {
      const wfDir = join(
        dir,
        PROJECT_DIR_NAME,
        "parent-session",
        SUBAGENTS_DIR_NAME,
        "workflows",
        "wf_abc123"
      );
      await mkdir(wfDir, { recursive: true });
      await writeFile(join(wfDir, "journal.jsonl"), `${USER_LINE}\n`);
      await writeFile(join(wfDir, `${NESTED_ID}.jsonl`), `${USER_LINE}\n`);

      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: dir,
        projectDirGlob: PROJECT_DIR_GLOB,
      });
      const sessions = await collect(src.discoverSessions());

      expect(sessions.find((s) => s.agentSessionId === "journal")).toBeUndefined();
      // The real transcript in the SAME directory is still discovered — the
      // exclusion is one filename, not the directory it lives in.
      expect(sessions.find((s) => s.agentSessionId === NESTED_ID)).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers cwd for a nested transcript via the project-dir fallback", async () => {
    // The fallback walks UP to the project dir. Before mt#3294 its hop budget
    // was 3, which stops one directory short for this depth — so discovery
    // finding the file would not have been enough on its own.
    const dir = await mkdtemp(join(tmpdir(), "minsky-cc-source-nested-cwd-"));
    try {
      const wfDir = join(
        dir,
        PROJECT_DIR_NAME,
        "parent-session",
        SUBAGENTS_DIR_NAME,
        "workflows",
        "wf_abc123"
      );
      await mkdir(wfDir, { recursive: true });
      // No `cwd` on any line, so recovery must fall through to the project dir.
      await writeFile(join(wfDir, `${DEEPER_ID}.jsonl`), `${USER_LINE}\n`);

      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: dir,
        projectDirGlob: PROJECT_DIR_GLOB,
      });
      const sessions = await collect(src.discoverSessions());
      expect(sessions.find((s) => s.agentSessionId === DEEPER_ID)?.cwd).toBe(DERIVED_PROJECT_CWD);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("still finds transcripts directly under subagents/ (no regression)", async () => {
    const sessions = await collect(makeSource().discoverSessions());
    const sub = sessions.find((s) => s.agentSessionId === SUB_SESSION_ID);
    expect(sub).toBeDefined();
    expect(sub?.isSubagent).toBe(true);
  });

  // PR #2377 R1. A symlink under subagents/ can point anywhere, including at a
  // cycle or an unrelated tree. Nothing in scanSubagentTree checks for symlinks
  // explicitly — it relies on readdir's lstat semantics, where a symlink is
  // reported as isSymbolicLink() and not isDirectory(). This test locks that
  // platform behavior, because the safety of the walk depends on it and it is
  // not visible at the call site.
  test("does not descend into a symlinked directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minsky-cc-source-symlink-"));
    try {
      const subagents = join(dir, PROJECT_DIR_NAME, "parent-session", SUBAGENTS_DIR_NAME);
      await mkdir(subagents, { recursive: true });

      // A real directory elsewhere, holding a transcript, linked into the tree.
      const outside = join(dir, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "agent-via-symlink.jsonl"), `${USER_LINE}\n`);
      await symlink(outside, join(subagents, "linked"));

      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: dir,
        projectDirGlob: PROJECT_DIR_GLOB,
      });
      const sessions = await collect(src.discoverSessions());
      expect(sessions.find((s) => s.agentSessionId === "agent-via-symlink")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // PR #2377 R2: pin BOTH sides of the bound in one fixture. Asserting only
  // that some very deep file is missing shows the walk stops somewhere, not
  // where — a cap that was accidentally 1 or 10 would pass that just as
  // happily. Placing a transcript at every level and asserting exactly which
  // ones are found makes an off-by-one in either direction fail.
  test("descends exactly MAX_SUBAGENT_TREE_DEPTH levels below subagents/, and no further", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minsky-cc-source-depth-"));
    try {
      const subagents = join(dir, PROJECT_DIR_NAME, "parent-session", SUBAGENTS_DIR_NAME);
      // One transcript per level: level 0 is subagents/ itself, then one per
      // nested directory, one level BEYOND the cap.
      const levels = MAX_SUBAGENT_TREE_DEPTH + 1;
      let current = subagents;
      for (let level = 0; level <= levels; level++) {
        await mkdir(current, { recursive: true });
        await writeFile(join(current, `agent-level-${level}.jsonl`), `${USER_LINE}\n`);
        current = join(current, `d${level + 1}`);
      }

      const src = new ClaudeCodeTranscriptSource({
        claudeProjectsDir: dir,
        projectDirGlob: PROJECT_DIR_GLOB,
      });
      const found = (await collect(src.discoverSessions()))
        .map((s) => s.agentSessionId)
        .filter((id) => id.startsWith("agent-level-"))
        .sort();

      // Levels 0..MAX inclusive are reachable; the next one is not.
      const expected = Array.from({ length: MAX_SUBAGENT_TREE_DEPTH + 1 }, (_, level) =>
        conv(`agent-level-${level}`)
      ).sort();
      expect(found).toEqual(expected);
      expect(found).not.toContain(`agent-level-${MAX_SUBAGENT_TREE_DEPTH + 1}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ClaudeCodeTranscriptSource.readSession — jsonlPath passthrough (mt#3288)", () => {
  test("reads the given path directly, without resolving the id through discovery", async () => {
    // The file lives OUTSIDE the configured projects dir, so discovery can never
    // find it. Lines coming back therefore prove the path was used as-is — which
    // is the whole point: `ingestAll` must not pay a corpus scan per session.
    const outside = await mkdtemp(join(tmpdir(), "minsky-cc-source-outside-"));
    try {
      const path = join(outside, "elsewhere.jsonl");
      await writeFile(path, `${[USER_LINE, ASSISTANT_LINE].join("\n")}\n`);

      const viaPath = await collect(makeSource().readSession(conv("unfindable-id"), path));
      expect(viaPath.map((l) => l.type)).toEqual(["user", "assistant"]);

      // Same id without the path finds nothing — confirms the id really is
      // unresolvable via discovery, so the assertion above isn't vacuous.
      expect(await collect(makeSource().readSession(conv("unfindable-id")))).toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("still resolves by id when no path is given (ad-hoc callers keep working)", async () => {
    const lines = await collect(makeSource().readSession(TOP_SESSION_ID));
    expect(lines).toHaveLength(2);
  });
});

describe("ClaudeCodeTranscriptSource cwd recovery — incremental read (mt#3288)", () => {
  const byteLength = (s: string) => new TextEncoder().encode(s).length;
  const CHUNK = 64 * 1024;

  async function discoverOne(dir: string) {
    const src = new ClaudeCodeTranscriptSource({
      claudeProjectsDir: dir,
      projectDirGlob: PROJECT_DIR_GLOB,
    });
    const sessions = await collect(src.discoverSessions());
    return sessions[0];
  }

  test("recovers a cwd whose line sits past the first chunk, with a multi-byte character straddling the chunk boundary", async () => {
    // Two regressions in one fixture. (1) A bounded read that stopped at one
    // chunk would miss this cwd entirely and silently fall back to the lossy
    // project-dir derivation. (2) Decoding each chunk independently would split
    // the multi-byte character across the boundary and yield a replacement
    // character inside the recovered path.
    const dir = await mkdtemp(join(tmpdir(), "minsky-cc-source-cwd-boundary-"));
    try {
      const proj = join(dir, PROJECT_DIR_NAME);
      await mkdir(proj);

      const cwdValue = "/Users/edobry/Projects/café-ünïcode";
      const cwdLine = JSON.stringify({
        type: "user",
        cwd: cwdValue,
        message: { role: "user", content: "hi" },
        uuid: "u-boundary",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      // Place the first multi-byte character so it begins at CHUNK-1 and
      // therefore spans the boundary between read 1 and read 2.
      const markerCharIndex = cwdLine.indexOf("é");
      const markerByteOffset = byteLength(cwdLine.slice(0, markerCharIndex));
      const paddingBytes = CHUNK - 1 - markerByteOffset;

      const padPrefix = '{"type":"system","pad":"';
      const padSuffix = '"}\n';
      const padding =
        padPrefix + "x".repeat(paddingBytes - padPrefix.length - padSuffix.length) + padSuffix;
      expect(byteLength(padding)).toBe(paddingBytes);

      await writeFile(join(proj, "boundary.jsonl"), `${padding}${cwdLine}\n`);

      expect((await discoverOne(dir))?.cwd).toBe(cwdValue);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the project-dir derivation when no line carries a cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minsky-cc-source-cwd-absent-"));
    try {
      const proj = join(dir, PROJECT_DIR_NAME);
      await mkdir(proj);
      await writeFile(join(proj, "nocwd.jsonl"), `${[USER_LINE, ASSISTANT_LINE].join("\n")}\n`);

      expect((await discoverOne(dir))?.cwd).toBe(DERIVED_PROJECT_CWD);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers a cwd from a final line with no trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minsky-cc-source-cwd-no-eol-"));
    try {
      const proj = join(dir, PROJECT_DIR_NAME);
      await mkdir(proj);
      const line = JSON.stringify({
        type: "user",
        cwd: "/tmp/no-trailing-newline",
        uuid: "u-eol",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      await writeFile(join(proj, "noeol.jsonl"), line);

      expect((await discoverOne(dir))?.cwd).toBe("/tmp/no-trailing-newline");
    } finally {
      await rm(dir, { recursive: true, force: true });
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
    const lines = await collect(makeSource().readSession(conv("does-not-exist")));
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
      const lines = await collect(src.readSession(conv("bad")));
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
      expect(await collect(src.readSession(conv("empty")))).toHaveLength(0);
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

describe("ClaudeCodeTranscriptSource.readSession — defensive", () => {
  test("yields nothing when the session file is missing or unreadable", async () => {
    // Construct a source that would resolve any agentSessionId by faking
    // discoverSessions, then point at a path that does not exist on disk.
    const fakePath = join(tmpdir(), "mt1350-readsession-missing-file-test.jsonl");
    class StubSource extends ClaudeCodeTranscriptSource {
      async *discoverSessions() {
        yield {
          agentSessionId: conv("fake"),
          jsonlPath: fakePath,
          harness: "claude_code",
          isSubagent: false,
          mtime: new Date(),
        };
      }
    }
    const src = new StubSource();
    const lines: unknown[] = [];
    for await (const line of src.readSession(conv("fake"))) {
      lines.push(line);
    }
    expect(lines).toEqual([]);
  });
});
