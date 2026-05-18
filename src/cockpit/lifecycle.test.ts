/**
 * Tests for the cockpit lifecycle module — mt#1904.
 *
 * Covers:
 *   - workspace-key resolution (session workspace → session ID; main workspace → "main")
 *   - state-file write / read / remove round-trip
 *   - atomic write (temp-then-rename)
 *   - graceful handling of missing / malformed / wrong-shape state files
 *   - state-dir env-var override (MINSKY_STATE_DIR)
 *   - optional devChromiumPid field round-trip
 *
 * Real filesystem I/O is intentional in this file — the lifecycle module is
 * a thin wrapper over fs primitives, so mocked fs would test the mock rather
 * than the contract. Same posture as `src/cockpit/port-recovery.test.ts` and
 * `src/mcp/disconnect-tracker.test.ts`.
 */
/* eslint-disable custom/no-real-fs-in-tests -- testing real fs I/O IS the contract */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import {
  getCockpitStateDir,
  getCockpitStateFilePath,
  getStateDir,
  MAIN_WORKSPACE_KEY,
  readCockpitState,
  readCurrentCockpitState,
  removeCockpitState,
  removeCurrentCockpitState,
  resolveWorkspaceKey,
  writeCockpitState,
  writeCurrentCockpitState,
  type CockpitState,
} from "./lifecycle";

const STATE_DIR_ENV = "MINSKY_STATE_DIR";
const FAKE_MAIN_CWD = "/Users/test/proj";

let tmpStateDir: string;
let priorStateDir: string | undefined;

beforeEach(() => {
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-lifecycle-test-"));
  priorStateDir = process.env[STATE_DIR_ENV];
  process.env[STATE_DIR_ENV] = tmpStateDir;
});

afterEach(() => {
  if (priorStateDir === undefined) {
    delete process.env[STATE_DIR_ENV];
  } else {
    process.env[STATE_DIR_ENV] = priorStateDir;
  }
  try {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// State-dir resolution
// ---------------------------------------------------------------------------

describe("state dir resolution", () => {
  test(`getStateDir honours ${STATE_DIR_ENV}`, () => {
    expect(getStateDir()).toBe(tmpStateDir);
  });

  test("getCockpitStateDir is <stateDir>/cockpit", () => {
    expect(getCockpitStateDir()).toBe(path.join(tmpStateDir, "cockpit"));
  });

  test("getCockpitStateFilePath builds <stateDir>/cockpit/<key>.json", () => {
    expect(getCockpitStateFilePath("abc123")).toBe(
      path.join(tmpStateDir, "cockpit", "abc123.json")
    );
    expect(getCockpitStateFilePath("main")).toBe(path.join(tmpStateDir, "cockpit", "main.json"));
  });
});

// ---------------------------------------------------------------------------
// Workspace-key resolution
// ---------------------------------------------------------------------------

describe("resolveWorkspaceKey", () => {
  test('returns "main" for paths outside the sessions dir', () => {
    expect(resolveWorkspaceKey("/Users/edobry/Projects/minsky")).toBe(MAIN_WORKSPACE_KEY);
    expect(resolveWorkspaceKey("/tmp/whatever")).toBe(MAIN_WORKSPACE_KEY);
  });

  test("extracts the session ID from a session workspace path", () => {
    // getSessionsDir() respects XDG; default is `${homedir}/.local/state/minsky/sessions`.
    // Build a path under it explicitly to keep the test platform-portable.
    const sessionsDir = path.join(
      process.env["HOME"] || os.homedir(),
      ".local",
      "state",
      "minsky",
      "sessions"
    );
    const sessionId = "abc-123-session";
    const wsPath = path.join(sessionsDir, sessionId);
    expect(resolveWorkspaceKey(wsPath)).toBe(sessionId);
  });

  test("extracts the session ID even when cwd is a subdirectory of the session workspace", () => {
    const sessionsDir = path.join(
      process.env["HOME"] || os.homedir(),
      ".local",
      "state",
      "minsky",
      "sessions"
    );
    const sessionId = "deep-session";
    const wsSubdir = path.join(sessionsDir, sessionId, "src", "cockpit");
    expect(resolveWorkspaceKey(wsSubdir)).toBe(sessionId);
  });

  test('returns "main" for the sessions dir itself (no session ID segment)', () => {
    const sessionsDir = path.join(
      process.env["HOME"] || os.homedir(),
      ".local",
      "state",
      "minsky",
      "sessions"
    );
    expect(resolveWorkspaceKey(sessionsDir)).toBe(MAIN_WORKSPACE_KEY);
  });
});

// ---------------------------------------------------------------------------
// State-file lifecycle
// ---------------------------------------------------------------------------

function sampleState(over: Partial<CockpitState> = {}): CockpitState {
  return {
    pid: 12345,
    port: 3737,
    url: "http://localhost:3737",
    workspaceId: "main",
    workspacePath: "/Users/test/proj",
    startedAt: "2026-05-18T18:00:00.000Z",
    ...over,
  };
}

describe("state-file lifecycle", () => {
  test("write + read round-trips with the expected shape", () => {
    const state = sampleState();
    writeCockpitState(state);
    const read = readCockpitState("main");
    expect(read).toEqual(state);
  });

  test("write creates the state dir if missing", () => {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
    expect(fs.existsSync(tmpStateDir)).toBe(false);
    writeCockpitState(sampleState());
    expect(fs.existsSync(getCockpitStateFilePath("main"))).toBe(true);
  });

  test("write is atomic (no .tmp.* file leftover after write)", () => {
    writeCockpitState(sampleState());
    const dirContents = fs.readdirSync(getCockpitStateDir());
    const tmpFiles = dirContents.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toEqual([]);
  });

  test("write supports concurrent workspace keys without collision", () => {
    writeCockpitState(sampleState({ workspaceId: "session-a", port: 3001 }));
    writeCockpitState(sampleState({ workspaceId: "session-b", port: 3002 }));
    const a = readCockpitState("session-a");
    const b = readCockpitState("session-b");
    expect(a?.port).toBe(3001);
    expect(b?.port).toBe(3002);
  });

  test("read on missing file returns null", () => {
    expect(readCockpitState("nonexistent")).toBeNull();
  });

  test("read on malformed JSON returns null (does not throw)", () => {
    const p = getCockpitStateFilePath("bad");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not json {{{");
    expect(readCockpitState("bad")).toBeNull();
  });

  test("read on wrong-shape JSON returns null", () => {
    const p = getCockpitStateFilePath("wrong-shape");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ pid: "not-a-number" }));
    expect(readCockpitState("wrong-shape")).toBeNull();
  });

  test("remove clears the file", () => {
    writeCockpitState(sampleState());
    expect(fs.existsSync(getCockpitStateFilePath("main"))).toBe(true);
    removeCockpitState("main");
    expect(fs.existsSync(getCockpitStateFilePath("main"))).toBe(false);
  });

  test("remove is silent on missing file", () => {
    expect(() => removeCockpitState("never-existed")).not.toThrow();
  });

  test("devChromiumPid is round-tripped when present", () => {
    writeCockpitState(sampleState({ devChromiumPid: 98765 }));
    expect(readCockpitState("main")?.devChromiumPid).toBe(98765);
  });

  test("devChromiumPid is absent when not provided", () => {
    writeCockpitState(sampleState());
    const read = readCockpitState("main");
    expect(read?.devChromiumPid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Current-workspace convenience helpers
// ---------------------------------------------------------------------------

describe("writeCurrentCockpitState / readCurrentCockpitState / removeCurrentCockpitState", () => {
  test("writes under main key when cwd is not in a session workspace", () => {
    const cwd = FAKE_MAIN_CWD;
    const state = writeCurrentCockpitState(
      { pid: 11, port: 3737, url: "http://localhost:3737" },
      cwd
    );
    expect(state.workspaceId).toBe(MAIN_WORKSPACE_KEY);
    expect(state.workspacePath).toBe(cwd);
    expect(readCurrentCockpitState(cwd)?.port).toBe(3737);
  });

  test("writes under session ID when cwd is in a session workspace", () => {
    const sessionsDir = path.join(
      process.env["HOME"] || os.homedir(),
      ".local",
      "state",
      "minsky",
      "sessions"
    );
    const sessionId = "live-session-id";
    const cwd = path.join(sessionsDir, sessionId);
    const state = writeCurrentCockpitState(
      { pid: 22, port: 3838, url: "http://localhost:3838" },
      cwd
    );
    expect(state.workspaceId).toBe(sessionId);
    expect(readCurrentCockpitState(cwd)?.port).toBe(3838);
  });

  test("write fills startedAt with an ISO timestamp by default", () => {
    const cwd = FAKE_MAIN_CWD;
    const before = new Date().toISOString();
    const state = writeCurrentCockpitState(
      { pid: 33, port: 3737, url: "http://localhost:3737" },
      cwd
    );
    const after = new Date().toISOString();
    // Lexicographic comparison is valid for ISO-8601 strings.
    expect(state.startedAt >= before).toBe(true);
    expect(state.startedAt <= after).toBe(true);
  });

  test("remove clears the current workspace's file", () => {
    const cwd = FAKE_MAIN_CWD;
    writeCurrentCockpitState({ pid: 44, port: 3737, url: "http://localhost:3737" }, cwd);
    expect(readCurrentCockpitState(cwd)).not.toBeNull();
    removeCurrentCockpitState(cwd);
    expect(readCurrentCockpitState(cwd)).toBeNull();
  });
});
