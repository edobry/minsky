// Tests for mcp-daemon-staleness-detector.ts (mt#1717)
//
// All tests use in-memory FsDeps mocks and stub GitDeps per
// `custom/no-real-fs-in-tests`.

import { describe, expect, test } from "bun:test";
import {
  buildWarning,
  decideAndUpdate,
  getDaemonStatePath,
  encodeProjectDir,
  OPT_OUT_ENV,
  readDaemonStateFile,
  readTracker,
  resolveMinskyHomeDir,
  resolveTrackerPath,
  writeTracker,
  MAX_PATHS_LISTED,
  type FsDeps,
  type GitDeps,
  type SessionTracker,
} from "./mcp-daemon-staleness-detector";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const PROJECT_DIR = "/p/repo";
const HOME_DIR = "/h";
const SESSION_ID = "sess-1";
const MINSKY_HOME = "/minsky-home";

const COMMIT_A = "aaaaaaaabbbbbbbbcccccccc1111111111111111";
const COMMIT_B = "bbbbbbbbccccccccdddddddd2222222222222222";

const STATE_DIR = "/state";
const STATE_PATH = `${STATE_DIR}/mcp-daemon-state.json`;
const TRACKER_PATH = `${HOME_DIR}/.claude/mcp-daemon-staleness/p-repo/${SESSION_ID}.json`;

const DAEMON_STATE_OBJ = {
  startCommit: COMMIT_A,
  startTimestamp: "2026-01-01T00:00:00.000Z",
  pid: 12345,
  serverName: "minsky",
};

// ---------------------------------------------------------------------------
// Test helper: require non-null
// ---------------------------------------------------------------------------

function requireNotNull<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected non-null: ${message}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// In-memory FS fixture
// ---------------------------------------------------------------------------

interface InMemoryEntry {
  kind: "file" | "dir";
  content?: string;
}

function makeFs(initial: Record<string, InMemoryEntry> = {}): FsDeps & {
  setFile: (path: string, content: string) => void;
  files: Record<string, InMemoryEntry>;
} {
  const files: Record<string, InMemoryEntry> = { ...initial };

  const setFile = (path: string, content = "") => {
    files[path] = { kind: "file", content };
  };

  return {
    files,
    setFile,
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      const entry = files[p];
      if (!entry || entry.kind !== "file") throw new Error(`ENOENT: ${p}`);
      return entry.content ?? "";
    },
    writeFileSync: (p, data) => {
      files[p] = { kind: "file", content: data };
    },
    mkdirSync: (p) => {
      if (!(p in files)) {
        files[p] = { kind: "dir" };
      }
    },
    renameSync: (from, to) => {
      const entry = files[from];
      if (!entry) throw new Error(`ENOENT: ${from}`);
      files[to] = entry;
      delete files[from];
    },
  };
}

// ---------------------------------------------------------------------------
// Stub GitDeps factory
// ---------------------------------------------------------------------------

function makeGit(opts: { head?: string | null; changed?: string[] | null }): GitDeps {
  return {
    resolveHead: () => opts.head ?? null,
    diffNames: () => opts.changed ?? null,
  };
}

// ---------------------------------------------------------------------------
// Test env factory
// ---------------------------------------------------------------------------

function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    MINSKY_STATE_DIR: STATE_DIR,
    MINSKY_HOME,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getDaemonStatePath
// ---------------------------------------------------------------------------

describe("getDaemonStatePath", () => {
  test("uses MINSKY_STATE_DIR when set", () => {
    const path = getDaemonStatePath({ MINSKY_STATE_DIR: "/custom/state" });
    expect(path).toBe("/custom/state/mcp-daemon-state.json");
  });

  test("falls back to ~/.local/state/minsky when env not set", () => {
    const path = getDaemonStatePath({});
    expect(path).toContain(".local/state/minsky/mcp-daemon-state.json");
  });
});

// ---------------------------------------------------------------------------
// encodeProjectDir
// ---------------------------------------------------------------------------

describe("encodeProjectDir", () => {
  test("replaces forward slashes with dashes and strips leading dash", () => {
    expect(encodeProjectDir("/Users/edobry/Projects/minsky")).toBe("Users-edobry-Projects-minsky");
  });

  test("handles Windows-style backslash paths", () => {
    expect(encodeProjectDir("C:\\Users\\edobry")).toBe("C:-Users-edobry");
  });
});

// ---------------------------------------------------------------------------
// resolveTrackerPath
// ---------------------------------------------------------------------------

describe("resolveTrackerPath", () => {
  test("composes home + mcp-daemon-staleness + encoded-cwd + session-id.json", () => {
    const path = resolveTrackerPath("/p/repo", "abc-123", "/home/user");
    expect(path).toBe("/home/user/.claude/mcp-daemon-staleness/p-repo/abc-123.json");
  });
});

// ---------------------------------------------------------------------------
// resolveMinskyHomeDir
// ---------------------------------------------------------------------------

describe("resolveMinskyHomeDir", () => {
  test("returns MINSKY_HOME env var when set", () => {
    const result = resolveMinskyHomeDir({ MINSKY_HOME: "/custom/minsky" }, makeFs());
    expect(result).toBe("/custom/minsky");
  });

  test("returns bun global path when it exists in fs", () => {
    const memFs = makeFs();
    const bunPath = `${require("os").homedir()}/.bun/install/global/node_modules/minsky`;
    memFs.setFile(bunPath, "");
    const result = resolveMinskyHomeDir({}, memFs);
    expect(result).toBe(bunPath);
  });

  test("returns null when no env override and bun path missing", () => {
    const result = resolveMinskyHomeDir({}, makeFs());
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readDaemonStateFile
// ---------------------------------------------------------------------------

describe("readDaemonStateFile", () => {
  test("returns null when file does not exist", () => {
    const result = readDaemonStateFile(STATE_PATH, makeFs());
    expect(result).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const memFs = makeFs();
    memFs.setFile(STATE_PATH, "not json");
    expect(readDaemonStateFile(STATE_PATH, memFs)).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    const memFs = makeFs();
    memFs.setFile(STATE_PATH, JSON.stringify({ startCommit: "abc" }));
    expect(readDaemonStateFile(STATE_PATH, memFs)).toBeNull();
  });

  test("returns parsed state when shape is valid", () => {
    const memFs = makeFs();
    memFs.setFile(STATE_PATH, JSON.stringify(DAEMON_STATE_OBJ));
    const result = readDaemonStateFile(STATE_PATH, memFs);
    expect(result).toEqual(DAEMON_STATE_OBJ);
  });
});

// ---------------------------------------------------------------------------
// readTracker / writeTracker round-trip
// ---------------------------------------------------------------------------

describe("tracker persistence", () => {
  test("readTracker returns null when file does not exist", () => {
    expect(readTracker("/missing.json", makeFs())).toBeNull();
  });

  test("readTracker returns null for malformed JSON", () => {
    const memFs = makeFs();
    memFs.setFile("/t.json", "bad json");
    expect(readTracker("/t.json", memFs)).toBeNull();
  });

  test("readTracker returns null pair when lastReportedPair is null", () => {
    const memFs = makeFs();
    memFs.setFile("/t.json", JSON.stringify({ lastReportedPair: null }));
    expect(readTracker("/t.json", memFs)).toEqual({ lastReportedPair: null });
  });

  test("writeTracker + readTracker round-trips", () => {
    const memFs = makeFs();
    const tracker: SessionTracker = {
      lastReportedPair: { startCommit: COMMIT_A, currentHead: COMMIT_B },
    };
    writeTracker("/state/sess.json", tracker, memFs);
    const recovered = readTracker("/state/sess.json", memFs);
    expect(recovered).toEqual(tracker);
  });
});

// ---------------------------------------------------------------------------
// buildWarning
// ---------------------------------------------------------------------------

describe("buildWarning", () => {
  test("includes abbreviated commits and timestamps", () => {
    const text = buildWarning(COMMIT_A, "2026-01-01T00:00:00.000Z", COMMIT_B, ["src/foo.ts"]);
    expect(text).toContain(COMMIT_A.slice(0, 9));
    expect(text).toContain(COMMIT_B.slice(0, 9));
    expect(text).toContain("2026-01-01T00:00:00.000Z");
    expect(text).toContain("1 file");
    expect(text).toContain("src/foo.ts");
    expect(text).toContain("/mcp");
  });

  test("shows plural files", () => {
    const text = buildWarning(COMMIT_A, "ts", COMMIT_B, ["src/a.ts", "src/b.ts"]);
    expect(text).toContain("2 files");
  });

  test("caps listed paths and shows overflow", () => {
    const paths = Array.from({ length: MAX_PATHS_LISTED + 3 }, (_, i) => `src/f${i}.ts`);
    const text = buildWarning(COMMIT_A, "ts", COMMIT_B, paths);
    const listedCount = (text.match(/^ {2}- /gm) ?? []).length;
    expect(listedCount).toBe(MAX_PATHS_LISTED);
    expect(text).toContain("+ 3 more");
  });
});

// ---------------------------------------------------------------------------
// decideAndUpdate — 7 acceptance test cases
// ---------------------------------------------------------------------------

describe("decideAndUpdate", () => {
  // Helper to seed the daemon state file
  function seedDaemonState(
    memFs: ReturnType<typeof makeFs>,
    state: typeof DAEMON_STATE_OBJ = DAEMON_STATE_OBJ
  ) {
    memFs.setFile(STATE_PATH, JSON.stringify(state));
  }

  // Helper to seed the tracker file
  function seedTracker(
    memFs: ReturnType<typeof makeFs>,
    tracker: SessionTracker,
    path: string = TRACKER_PATH
  ) {
    memFs.setFile(path, JSON.stringify(tracker));
  }

  // Case 1: First invocation writes baseline tracker; no warning
  test("case 1: first invocation writes tracker with null pair; no warning", () => {
    const memFs = makeFs();
    seedDaemonState(memFs);
    // No tracker file yet.
    const git = makeGit({ head: COMMIT_B, changed: ["src/foo.ts"] });

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: makeEnv(),
      fs: memFs,
      git,
      homeOverride: HOME_DIR,
    });

    // Should warn (drift detected, no tracker suppression yet)
    const injection = requireNotNull(result.injection, "should have injection");
    expect(injection).toContain("stale");
    expect(result.newTracker?.lastReportedPair?.startCommit).toBe(COMMIT_A);
    expect(result.newTracker?.lastReportedPair?.currentHead).toBe(COMMIT_B);
  });

  // Case 2: No-change turn (commits match): no warning
  test("case 2: no-change turn — commits match, no warning", () => {
    const memFs = makeFs();
    // Daemon state with startCommit == currentHead
    memFs.setFile(STATE_PATH, JSON.stringify({ ...DAEMON_STATE_OBJ, startCommit: COMMIT_B }));
    // git HEAD is also COMMIT_B → no drift
    const git = makeGit({ head: COMMIT_B, changed: [] });

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: makeEnv(),
      fs: memFs,
      git,
      homeOverride: HOME_DIR,
    });

    expect(result.injection).toBeNull();
    expect(result.log.skipReason).toBe("no-drift");
  });

  // Case 3: Daemon-state mismatch with src/ changes: warning emitted
  test("case 3: mismatch + src/ changes → warning emitted", () => {
    const memFs = makeFs();
    seedDaemonState(memFs);
    const git = makeGit({ head: COMMIT_B, changed: ["src/foo.ts", "src/bar.ts"] });

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: makeEnv(),
      fs: memFs,
      git,
      homeOverride: HOME_DIR,
    });

    const injection = requireNotNull(result.injection, "should have injection");
    expect(injection).toContain("stale");
    expect(injection).toContain("src/foo.ts");
    expect(injection).toContain("src/bar.ts");
    expect(result.log.changedSrcCount).toBe(2);
    expect(result.log.warned).toBe(true);
  });

  // Case 4: Daemon-state mismatch but ONLY non-src/ changes: no warning
  test("case 4: mismatch but only docs/ changes → no warning", () => {
    const memFs = makeFs();
    seedDaemonState(memFs);
    const git = makeGit({
      head: COMMIT_B,
      changed: ["docs/README.md", ".github/workflows/ci.yml"],
    });

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: makeEnv(),
      fs: memFs,
      git,
      homeOverride: HOME_DIR,
    });

    expect(result.injection).toBeNull();
    expect(result.log.skipReason).toBe("no-src-changes");
  });

  // Case 5: Re-warn suppression and re-warn on new pair
  test("case 5a: same commit pair → re-warn suppressed", () => {
    const memFs = makeFs();
    seedDaemonState(memFs);
    seedTracker(memFs, {
      lastReportedPair: { startCommit: COMMIT_A, currentHead: COMMIT_B },
    });
    const git = makeGit({ head: COMMIT_B, changed: ["src/foo.ts"] });

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: makeEnv(),
      fs: memFs,
      git,
      homeOverride: HOME_DIR,
    });

    expect(result.injection).toBeNull();
    expect(result.log.skipReason).toBe("already-reported");
  });

  test("case 5b: different pair → warns again", () => {
    const COMMIT_C = "ccccccccddddddddeeeeeeee3333333333333333";
    const memFs = makeFs();
    // Daemon state still at COMMIT_A
    seedDaemonState(memFs);
    // Tracker says we last reported (COMMIT_A → COMMIT_B)
    seedTracker(memFs, {
      lastReportedPair: { startCommit: COMMIT_A, currentHead: COMMIT_B },
    });
    // Now HEAD has advanced to COMMIT_C
    const git = makeGit({ head: COMMIT_C, changed: ["src/new.ts"] });

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: makeEnv(),
      fs: memFs,
      git,
      homeOverride: HOME_DIR,
    });

    const injection = requireNotNull(result.injection, "should warn again");
    expect(injection).toContain("stale");
    expect(result.newTracker?.lastReportedPair?.currentHead).toBe(COMMIT_C);
  });

  // Case 6: Daemon-state file missing: silent skip
  test("case 6: daemon state file missing → silent skip", () => {
    const memFs = makeFs();
    // No state file seeded
    const git = makeGit({ head: COMMIT_B, changed: ["src/foo.ts"] });

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: makeEnv(),
      fs: memFs,
      git,
      homeOverride: HOME_DIR,
    });

    expect(result.injection).toBeNull();
    expect(result.log.skipReason).toBe("no-daemon-state");
  });

  // Case 7: Opt-out env var set: silent skip
  test("case 7: opt-out env var → silent skip", () => {
    const memFs = makeFs();
    seedDaemonState(memFs);
    const git = makeGit({ head: COMMIT_B, changed: ["src/foo.ts"] });

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: makeEnv({ [OPT_OUT_ENV]: "1" }),
      fs: memFs,
      git,
      homeOverride: HOME_DIR,
    });

    expect(result.injection).toBeNull();
    expect(result.log.skipReason).toBe("opt-out");
  });

  test("opt-out accepts truthy: true, yes (case-insensitive)", () => {
    for (const v of ["true", "TRUE", "yes", "Yes"]) {
      const memFs = makeFs();
      const result = decideAndUpdate({
        projectDir: PROJECT_DIR,
        sessionId: SESSION_ID,
        env: makeEnv({ [OPT_OUT_ENV]: v }),
        fs: memFs,
        git: makeGit({ head: COMMIT_B, changed: [] }),
        homeOverride: HOME_DIR,
      });
      expect(result.log.skipReason).toBe("opt-out");
    }
  });

  // Additional: git diff failure → silent skip
  test("git diff failure → silent skip", () => {
    const memFs = makeFs();
    seedDaemonState(memFs);
    const git = makeGit({ head: COMMIT_B, changed: null }); // null = failure

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: makeEnv(),
      fs: memFs,
      git,
      homeOverride: HOME_DIR,
    });

    expect(result.injection).toBeNull();
    expect(result.log.skipReason).toBe("diff-failed");
  });

  // Additional: minsky home not resolvable → silent skip
  test("minsky home not found → silent skip", () => {
    const memFs = makeFs();
    seedDaemonState(memFs);
    const git = makeGit({ head: COMMIT_B, changed: ["src/foo.ts"] });

    // No MINSKY_HOME, no bun path in fs
    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: { MINSKY_STATE_DIR: STATE_DIR }, // no MINSKY_HOME
      fs: memFs,
      git,
      homeOverride: HOME_DIR,
    });

    expect(result.injection).toBeNull();
    expect(result.log.skipReason).toBe("no-minsky-home");
  });
});
