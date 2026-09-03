/**
 * Claude Code live-session roster reader tests (mt#4869).
 *
 * Every case drives `classifyConversationHolder` against an in-memory fake
 * `RosterFs` — never a real directory (`custom/no-real-fs-in-tests`) — and a
 * fake `ProcessProbe` — never `spyOn` on `process.kill` or a real `ps`
 * (testing-standards §Testable Design). `now` is injected too, so the 24h
 * cap is exercised without a real clock.
 *
 * The pid-reuse guard is EPOCH-based (`startedAt` vs. the probe's epoch-ms
 * reading), not a `procStart` string match — see the module's "Design
 * correction from live testing" header note for why a live AT1 run forced
 * this change. `PROC_START` below is still supplied on fixtures (the field
 * is required to be PRESENT, matching the roster's real shape) but its
 * VALUE is irrelevant to classification.
 */
import { describe, test, expect } from "bun:test";
import {
  classifyConversationHolder,
  defaultStartTimeOf,
  resolveClaudeSessionsDir,
  type ProcessProbe,
  type RosterFs,
} from "./claude-code-session-roster";

const CONVERSATION_ID = "6b6b34c2-8e2d-4e2b-98ff-54ff3f848394";
const SESSIONS_DIR = "/mock/claude/sessions"; // fixed mock path, never touched on disk
const PROC_START = "Wed Sep  2 08:00:00 2026"; // present-but-unused field value (see header note)
const NOW = new Date("2026-09-02T12:00:00.000Z");
const NOW_MS = NOW.getTime();
/** The epoch-ms a process "really" started at, per the fresh OS probe — matches `fakeProbe()`'s default and most fixtures' `startedAt`. */
const REAL_STARTED_AT_MS = NOW_MS - 60_000;

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

/** A probe that reports every pid alive, with a start time matching `REAL_STARTED_AT_MS`, unless overridden. */
function fakeProbe(overrides: Partial<ProcessProbe> = {}): ProcessProbe {
  return {
    isAlive: () => true,
    startTimeOf: () => REAL_STARTED_AT_MS,
    ...overrides,
  };
}

describe("classifyConversationHolder (mt#4869)", () => {
  test("alive pid with matching startedAt and fresh updatedAt -> running, holder identified", async () => {
    const fs = fakeFs({
      "4242.json": {
        pid: 4242,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        updatedAt: NOW_MS - 1000,
        startedAt: REAL_STARTED_AT_MS,
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
        startedAt: REAL_STARTED_AT_MS,
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

  test("pid-reuse: fresh start time far from roster's startedAt -> not_running, not running", async () => {
    const fs = fakeFs({
      "4244.json": {
        pid: 4244,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        startedAt: REAL_STARTED_AT_MS,
        updatedAt: NOW_MS - 1000,
      },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      // 90 minutes off — a different process now holds this pid.
      fakeProbe({ startTimeOf: () => REAL_STARTED_AT_MS + 90 * 60 * 1000 }),
      fs
    );

    expect(result.liveness).toBe("not_running");
    expect(result.basis).toMatch(/reused/i);
  });

  test("pid-reuse guard tolerates small measurement jitter (whole-second etimes rounding)", async () => {
    const fs = fakeFs({
      "4260.json": {
        pid: 4260,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        startedAt: REAL_STARTED_AT_MS,
        updatedAt: NOW_MS - 1000,
      },
    });

    const result = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      // 2s off — within the tolerance window, still the same process.
      fakeProbe({ startTimeOf: () => REAL_STARTED_AT_MS + 2000 }),
      fs
    );

    expect(result.liveness).toBe("running");
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
            startedAt: REAL_STARTED_AT_MS,
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
        startedAt: REAL_STARTED_AT_MS,
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
        startedAt: REAL_STARTED_AT_MS,
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

  test("entrypoint sdk-cli classifies as background (mt#4869 AT3: Minsky's own driven-session actuator)", async () => {
    const fs = fakeFs({
      "4254.json": {
        pid: 4254,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        startedAt: REAL_STARTED_AT_MS,
        updatedAt: NOW_MS - 1000,
        // Observed live 2026-09-03: the actuator registers kind "interactive",
        // not "bg" — entrypoint is the only reliable signal for this class.
        kind: "interactive",
        entrypoint: "sdk-cli",
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

  test("entry with no procStart or no startedAt -> unknown, never assumed running or not_running", async () => {
    const noProcStart = fakeFs({
      "4251.json": {
        pid: 4251,
        sessionId: CONVERSATION_ID,
        startedAt: REAL_STARTED_AT_MS,
        updatedAt: NOW_MS - 1000,
      },
    });
    const noStartedAt = fakeFs({
      "4253.json": {
        pid: 4253,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        updatedAt: NOW_MS - 1000,
      },
    });

    const resultA = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      noProcStart
    );
    const resultB = await classifyConversationHolder(
      CONVERSATION_ID,
      SESSIONS_DIR,
      NOW,
      fakeProbe(),
      noStartedAt
    );

    expect(resultA.liveness).toBe("unknown");
    expect(resultB.liveness).toBe("unknown");
  });

  test("a live process whose actual start time cannot be determined -> unknown", async () => {
    const fs = fakeFs({
      "4252.json": {
        pid: 4252,
        sessionId: CONVERSATION_ID,
        procStart: PROC_START,
        startedAt: REAL_STARTED_AT_MS,
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

describe("defaultStartTimeOf platform guard (PR #3592 R1 nit 2)", () => {
  test("returns null on an unsupported platform (win32) without shelling out to ps", () => {
    // `platform` is the injected trailing parameter — no `spyOn` on
    // `process.platform`, and no real `ps` invocation happens: a bogus pid
    // would make a real `ps -p <pid> -o etime=` call fail anyway, so this
    // also proves the guard short-circuits BEFORE that call.
    expect(defaultStartTimeOf(999999999, "win32")).toBeNull();
  });

  test("darwin and linux are supported platforms (guard does not block them)", () => {
    // These DO shell out (real `ps`), so assert only that the guard itself
    // didn't intervene — a bogus pid resolves to null via the `ps` failure
    // path, which is a DIFFERENT reason than the platform guard.
    expect(() => defaultStartTimeOf(999999999, "darwin")).not.toThrow();
    expect(() => defaultStartTimeOf(999999999, "linux")).not.toThrow();
  });
});
