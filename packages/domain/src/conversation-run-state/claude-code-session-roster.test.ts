/**
 * Claude Code live-session roster reader tests (mt#4869).
 *
 * Every case drives `classifyConversationHolder` against an in-memory fake
 * `RosterFs` — never a real directory (`custom/no-real-fs-in-tests`) — and a
 * fake `ProcessProbe` — never `spyOn` on `process.kill` or a real `ps`
 * (testing-standards §Testable Design). `now` is injected too, so the 24h
 * cap is exercised without a real clock.
 */
import { describe, test, expect } from "bun:test";
import {
  classifyConversationHolder,
  resolveClaudeSessionsDir,
  type ProcessProbe,
  type RosterFs,
} from "./claude-code-session-roster";

const CONVERSATION_ID = "6b6b34c2-8e2d-4e2b-98ff-54ff3f848394";
const SESSIONS_DIR = "/mock/claude/sessions"; // fixed mock path, never touched on disk
const PROC_START = "Wed Sep  2 08:00:00 2026";
const NOW = new Date("2026-09-02T12:00:00.000Z");
const NOW_MS = NOW.getTime();

type FakeEntries = Record<string, unknown | { __oversized: true }>;

/** An in-memory `RosterFs` over a fixed set of `<pid>.json` entries, keyed by filename. */
function fakeFs(entries: FakeEntries, dir: string = SESSIONS_DIR): RosterFs {
  return {
    async readdir(requestedDir) {
      if (requestedDir !== dir) throw new Error(`ENOENT: ${requestedDir}`);
      return Object.keys(entries);
    },
    async statSize(path) {
      const filename = path.slice(dir.length + 1);
      const value = entries[filename];
      if (value && typeof value === "object" && "__oversized" in value) {
        return 2 * 1024 * 1024;
      }
      return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
    },
    async readFile(path) {
      const filename = path.slice(dir.length + 1);
      const value = entries[filename];
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}

/** A `RosterFs` whose `readdir` always rejects — simulates an unreadable/missing directory. */
function unreadableFs(): RosterFs {
  return {
    readdir: () => Promise.reject(new Error("ENOENT")),
    statSize: () => Promise.reject(new Error("unreachable")),
    readFile: () => Promise.reject(new Error("unreachable")),
  };
}

/** A probe that reports every pid alive with a matching procStart, unless overridden. */
function fakeProbe(overrides: Partial<ProcessProbe> = {}): ProcessProbe {
  return {
    isAlive: () => true,
    startTimeOf: () => PROC_START,
    ...overrides,
  };
}

describe("classifyConversationHolder (mt#4869)", () => {
  test("alive pid with matching procStart and fresh updatedAt -> running, holder identified", async () => {
    const fs = fakeFs({
      "4242.json": {
        pid: 4242,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        updatedAt: NOW_MS - 1000,
        startedAt: NOW_MS - 60_000,
        kind: "interactive",
        entrypoint: "cli",
        name: "roster-probe",
        status: "idle",
        statusUpdatedAt: NOW_MS - 5000,
      },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      fs
    );

    expect(result.liveness).toBe("running");
    expect(result.holder).toEqual({
      surface: "terminal",
      name: "roster-probe",
      pid: 4242,
      idleForMs: 5000,
    });
  });

  test("dead pid -> not_running", async () => {
    const fs = fakeFs({
      "4243.json": {
        pid: 4243,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        updatedAt: NOW_MS - 1000,
      },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe({ isAlive: () => false }),
      fs
    );

    expect(result.liveness).toBe("not_running");
    expect(result.holder).toBeNull();
  });

  test("pid-reuse mismatch on procStart -> not_running, not running", async () => {
    const fs = fakeFs({
      "4244.json": {
        pid: 4244,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        updatedAt: NOW_MS - 1000,
      },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe({ startTimeOf: () => "Wed Sep  2 09:30:00 2026" }),
      fs
    );

    expect(result.liveness).toBe("not_running");
    expect(result.basis).toMatch(/reused/i);
  });

  test("entry older than 24h by updatedAt, alive pid -> not counted (not_running)", async () => {
    const fs = fakeFs({
      "4245.json": {
        pid: 4245,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        updatedAt: NOW_MS - 25 * 60 * 60 * 1000, // 25h old
        startedAt: NOW_MS - 26 * 60 * 60 * 1000,
      },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      fs
    );

    expect(result.liveness).toBe("not_running");
  });

  test("unparseable entry -> unknown for the whole registry, never not_running", async () => {
    const fs: RosterFs = {
      async readdir() {
        return ["4246.json", "4247.json"];
      },
      async statSize() {
        return 40;
      },
      async readFile(path) {
        if (path.endsWith("4246.json")) {
          return JSON.stringify({
            pid: 4246,
            sessionId: "some-other-conversation",
            procStart: PROC_START,
            updatedAt: NOW_MS - 1000,
          });
        }
        // A second, malformed entry — the vendor's registry treats this as
        // uninterpretable in its entirety, not "skip this one file".
        return "{ not valid json";
      },
    };

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      fs
    );

    expect(result.liveness).toBe("unknown");
    expect(result.holder).toBeNull();
  });

  test("missing roster directory -> unknown", async () => {
    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      unreadableFs()
    );

    expect(result.liveness).toBe("unknown");
    expect(result.basis).toMatch(/could not be read/i);
  });

  test("no matching roster entry -> not_running (conversation simply isn't held)", async () => {
    const fs = fakeFs({
      "4248.json": {
        pid: 4248,
        sessionId: "a-totally-different-conversation",
        procStart: PROC_START,
        updatedAt: NOW_MS - 1000,
      },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      fs
    );

    expect(result.liveness).toBe("not_running");
  });

  test("entry over 1 MB -> unknown for the whole registry", async () => {
    const fs = fakeFs({
      "4249.json": { __oversized: true },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      fs
    );

    expect(result.liveness).toBe("unknown");
    expect(result.basis).toMatch(/1 MB/);
  });

  test("ANY kind counts, not just interactive (writerLivenessFor semantics)", async () => {
    const fs = fakeFs({
      "4250.json": {
        pid: 4250,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        updatedAt: NOW_MS - 1000,
        kind: "bg",
        entrypoint: "cli",
      },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      fs
    );

    expect(result.liveness).toBe("running");
    expect(result.holder?.surface).toBe("background");
  });

  test("entry with no procStart to verify -> unknown, never assumed running or not_running", async () => {
    const fs = fakeFs({
      "4251.json": {
        pid: 4251,
        sessionId: CONVERSATION_ID,
        updatedAt: NOW_MS - 1000,
      },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      fs
    );

    expect(result.liveness).toBe("unknown");
  });

  test("a live process whose actual start time cannot be determined -> unknown", async () => {
    const fs = fakeFs({
      "4252.json": {
        pid: 4252,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        updatedAt: NOW_MS - 1000,
      },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe({ startTimeOf: () => null }),
      fs
    );

    expect(result.liveness).toBe("unknown");
  });

  test("filters non-roster filenames (^\\d+\\.json$ only)", async () => {
    const fs = fakeFs({
      "not-a-pid.json": { pid: 1, sessionId: CONVERSATION_ID, procStart: PROC_START },
      ".DS_Store": "not json at all",
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      fs
    );

    // Neither filename matches ^\d+\.json$, so both are skipped entirely —
    // not read, not counted toward "unparseable".
    expect(result.liveness).toBe("not_running");
  });
});

describe("resolveClaudeSessionsDir", () => {
  test("defaults to <home>/.claude/sessions", () => {
    expect(resolveClaudeSessionsDir({}, "/Users/test")).toBe("/Users/test/.claude/sessions");
  });

  test("honors CLAUDE_CONFIG_DIR when set", () => {
    expect(resolveClaudeSessionsDir({ CLAUDE_CONFIG_DIR: "/custom/dir" }, "/Users/test")).toBe(
      "/custom/dir/sessions"
    );
  });
});
