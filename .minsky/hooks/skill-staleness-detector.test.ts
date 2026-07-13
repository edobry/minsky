// Tests for skill-staleness-detector.ts (mt#1622)
//
// All tests use in-memory FsDeps mocks per `custom/no-real-fs-in-tests`.

import { describe, expect, test } from "bun:test";
import {
  buildWarning,
  decideAndUpdate,
  detectStaleness,
  encodeProjectDir,
  MAX_FILES_LISTED,
  OPT_OUT_ENV,
  readBaseline,
  resolveBaselinePath,
  snapshotMtimes,
  WATCH_ROOTS,
  writeBaseline,
  type FsDeps,
  type SessionBaseline,
} from "./skill-staleness-detector";

// ---------------------------------------------------------------------------
// Test constants — extracted to dedupe magic strings per
// `custom/no-magic-string-duplication`
// ---------------------------------------------------------------------------

const PROJECT_DIR = "/p/repo";
const HOME_DIR = "/h";
const SESSION_ID = "sess-1";

const SKILLS_DIR_ABS = `${PROJECT_DIR}/.claude/skills`;
const AGENTS_DIR_ABS = `${PROJECT_DIR}/.claude/agents`;
const RULES_DIR_ABS = `${PROJECT_DIR}/.minsky/rules`;

const SKILL_VERIFY_TASK_REL = ".claude/skills/verify-task/SKILL.md";
const SKILL_VERIFY_TASK_ABS = `${PROJECT_DIR}/${SKILL_VERIFY_TASK_REL}`;
const AGENT_REVIEWER_REL = ".claude/agents/reviewer.md";
const AGENT_REVIEWER_ABS = `${PROJECT_DIR}/${AGENT_REVIEWER_REL}`;

const BASELINE_PATH_FOR_SESS_1 = `${HOME_DIR}/.claude/skill-staleness/p-repo/${SESSION_ID}.json`;

/**
 * Test helper: assert that a value is not null and return it with the null
 * branch narrowed away. Replaces non-null assertions in test bodies per
 * `@typescript-eslint/no-non-null-assertion`.
 */
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
  mtimeMs: number;
  size: number;
  content?: string;
  children?: string[];
}

function makeFs(initial: Record<string, InMemoryEntry> = {}): FsDeps & {
  setFile: (path: string, mtimeMs: number, content?: string) => void;
  setDir: (path: string, children: string[]) => void;
  remove: (path: string) => void;
  files: Record<string, InMemoryEntry>;
} {
  const files: Record<string, InMemoryEntry> = { ...initial };

  const setFile = (path: string, mtimeMs: number, content = "") => {
    files[path] = { kind: "file", mtimeMs, size: content.length, content };
  };
  const setDir = (path: string, children: string[]) => {
    files[path] = { kind: "dir", mtimeMs: 0, size: 0, children };
  };
  const remove = (path: string) => {
    delete files[path];
  };

  return {
    files,
    setFile,
    setDir,
    remove,
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      const entry = files[p];
      if (!entry || entry.kind !== "file") throw new Error(`ENOENT: ${p}`);
      return entry.content ?? "";
    },
    writeFileSync: (p, data) => {
      files[p] = { kind: "file", mtimeMs: Date.now(), size: data.length, content: data };
    },
    readdirSync: (p) => {
      const entry = files[p];
      if (!entry || entry.kind !== "dir") throw new Error(`ENOENT: ${p}`);
      const children = entry.children ?? [];
      return children.map((name) => {
        const child = files[`${p}/${name}`];
        const isDir = child?.kind === "dir";
        const isFile = child?.kind === "file";
        return {
          name,
          isDirectory: () => isDir,
          isFile: () => isFile,
          isSymbolicLink: () => false,
        };
      });
    },
    statSync: (p) => {
      const entry = files[p];
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return { mtimeMs: entry.mtimeMs, size: entry.size };
    },
    mkdirSync: (p) => {
      if (!(p in files)) {
        files[p] = { kind: "dir", mtimeMs: 0, size: 0, children: [] };
      }
    },
    appendFileSync: () => {
      // Logging is exercised via integration; unit tests skip log writes.
    },
    renameSync: (from, to) => {
      const entry = files[from];
      if (!entry) throw new Error(`ENOENT: ${from}`);
      files[to] = entry;
      delete files[from];
    },
    unlinkSync: (p) => {
      delete files[p];
    },
  };
}

// ---------------------------------------------------------------------------
// encodeProjectDir
// ---------------------------------------------------------------------------

describe("encodeProjectDir", () => {
  test("replaces forward slashes with dashes and strips leading dash", () => {
    expect(encodeProjectDir("/Users/edobry/Projects/minsky")).toBe("Users-edobry-Projects-minsky");
  });

  test("replaces backslashes with dashes (Windows-style paths)", () => {
    expect(encodeProjectDir("C:\\Users\\edobry\\Projects\\minsky")).toBe(
      "C:-Users-edobry-Projects-minsky"
    );
  });
});

// ---------------------------------------------------------------------------
// resolveBaselinePath
// ---------------------------------------------------------------------------

describe("resolveBaselinePath", () => {
  test("composes home + skill-staleness + encoded-cwd + session-id.json", () => {
    const path = resolveBaselinePath("/p/repo", "abc-123", "/home/user");
    expect(path).toBe("/home/user/.claude/skill-staleness/p-repo/abc-123.json");
  });
});

// ---------------------------------------------------------------------------
// snapshotMtimes
// ---------------------------------------------------------------------------

describe("snapshotMtimes", () => {
  test("walks the watch roots and records relative paths with mtimes", () => {
    const memFs = makeFs();
    memFs.setDir(SKILLS_DIR_ABS, ["alpha", "beta"]);
    memFs.setDir(`${SKILLS_DIR_ABS}/alpha`, ["SKILL.md"]);
    memFs.setFile(`${SKILLS_DIR_ABS}/alpha/SKILL.md`, 100, "alpha");
    memFs.setDir(`${SKILLS_DIR_ABS}/beta`, ["SKILL.md"]);
    memFs.setFile(`${SKILLS_DIR_ABS}/beta/SKILL.md`, 200, "beta");
    memFs.setDir(AGENTS_DIR_ABS, ["one.md"]);
    memFs.setFile(`${AGENTS_DIR_ABS}/one.md`, 300, "one");
    memFs.setDir(RULES_DIR_ABS, ["a.mdc"]);
    memFs.setFile(`${RULES_DIR_ABS}/a.mdc`, 400, "a");

    const result = snapshotMtimes(PROJECT_DIR, memFs);
    expect(result).toEqual({
      ".claude/skills/alpha/SKILL.md": 100,
      ".claude/skills/beta/SKILL.md": 200,
      ".claude/agents/one.md": 300,
      ".minsky/rules/a.mdc": 400,
    });
  });

  test("excludes test/spec files and non-matching suffixes", () => {
    const memFs = makeFs();
    memFs.setDir(AGENTS_DIR_ABS, ["real.md", "real.test.ts", "fixtures.spec.md", "image.png"]);
    memFs.setFile(`${AGENTS_DIR_ABS}/real.md`, 100);
    memFs.setFile(`${AGENTS_DIR_ABS}/real.test.ts`, 200);
    memFs.setFile(`${AGENTS_DIR_ABS}/fixtures.spec.md`, 300);
    memFs.setFile(`${AGENTS_DIR_ABS}/image.png`, 400);

    const result = snapshotMtimes(PROJECT_DIR, memFs);
    expect(Object.keys(result)).toEqual([".claude/agents/real.md"]);
  });

  test("excludes .test.mdc and .spec.mdc rule fixtures", () => {
    // Reviewer-bot mt#1622 R1 BLOCKING: rules dir uses `.mdc`, but the original
    // skip regex only covered `.md`. Verify the alternation now drops `.mdc`
    // test/spec files too.
    const memFs = makeFs();
    memFs.setDir(RULES_DIR_ABS, ["real.mdc", "fixtures.spec.mdc", "broken.test.mdc"]);
    memFs.setFile(`${RULES_DIR_ABS}/real.mdc`, 100);
    memFs.setFile(`${RULES_DIR_ABS}/fixtures.spec.mdc`, 200);
    memFs.setFile(`${RULES_DIR_ABS}/broken.test.mdc`, 300);

    const result = snapshotMtimes(PROJECT_DIR, memFs);
    expect(Object.keys(result)).toEqual([".minsky/rules/real.mdc"]);
  });

  test("returns empty when watch roots don't exist", () => {
    const memFs = makeFs();
    expect(snapshotMtimes("/empty/repo", memFs)).toEqual({});
  });

  test("skips symlinks (defends against loops)", () => {
    const memFs = makeFs();
    memFs.setDir(AGENTS_DIR_ABS, ["real.md", "loop"]);
    memFs.setFile(`${AGENTS_DIR_ABS}/real.md`, 100);
    // Symlink emulation: readdir reports it but isSymbolicLink() returns true
    memFs.files[`${AGENTS_DIR_ABS}/loop`] = {
      kind: "file",
      mtimeMs: 200,
      size: 0,
    };
    const fsWithSymlink: FsDeps = {
      ...memFs,
      readdirSync: (p) => {
        const result = memFs.readdirSync(p, { withFileTypes: true });
        return result.map((e) =>
          e.name === "loop"
            ? {
                name: e.name,
                isDirectory: () => false,
                isFile: () => false,
                isSymbolicLink: () => true,
              }
            : e
        );
      },
    };

    const result = snapshotMtimes(PROJECT_DIR, fsWithSymlink);
    expect(result).toEqual({ ".claude/agents/real.md": 100 });
  });
});

// ---------------------------------------------------------------------------
// readBaseline / writeBaseline round-trip
// ---------------------------------------------------------------------------

describe("baseline persistence", () => {
  test("readBaseline returns null when file does not exist", () => {
    const memFs = makeFs();
    expect(readBaseline("/missing.json", memFs)).toBeNull();
  });

  test("readBaseline returns null for malformed JSON", () => {
    const memFs = makeFs();
    memFs.setFile("/b.json", 0, "not json");
    expect(readBaseline("/b.json", memFs)).toBeNull();
  });

  test("readBaseline returns null when shape is wrong", () => {
    const memFs = makeFs();
    memFs.setFile("/b.json", 0, JSON.stringify({ baseline: "wrong" }));
    expect(readBaseline("/b.json", memFs)).toBeNull();
  });

  test("writeBaseline + readBaseline round-trips", () => {
    const memFs = makeFs();
    const baseline: SessionBaseline = {
      baseline: { "a.md": 100, "b.md": 200 },
      lastReported: { "a.md": 150 },
    };
    writeBaseline("/state/sess.json", baseline, memFs);
    const recovered = readBaseline("/state/sess.json", memFs);
    expect(recovered).toEqual(baseline);
  });

  test("writeBaseline creates the parent directory via dirname (not join '..')", () => {
    // Reviewer-bot mt#1622 R1 BLOCKING: original used `join(path, "..")` which
    // produces `<path>/..` rather than the actual parent. POSIX resolves the
    // `..` segment so smoke passed, but the path is technically wrong and
    // breaks on stricter fs surfaces. Verify mkdir is called with the actual
    // parent directory string.
    const mkdirCalls: string[] = [];
    const memFs = makeFs();
    const spyingFs: FsDeps = {
      ...memFs,
      mkdirSync: (p, options) => {
        mkdirCalls.push(p);
        memFs.mkdirSync(p, options);
      },
    };
    const baseline: SessionBaseline = { baseline: { "a.md": 100 }, lastReported: {} };
    writeBaseline("/home/u/.claude/skill-staleness/repo/sess-1.json", baseline, spyingFs);

    expect(mkdirCalls).toContain("/home/u/.claude/skill-staleness/repo");
    // And specifically NOT the broken `<path>/..` form
    expect(mkdirCalls.find((p) => p.endsWith("/.."))).toBeUndefined();
  });

  test("readBaseline tolerates missing lastReported (older file format)", () => {
    const memFs = makeFs();
    memFs.setFile("/b.json", 0, JSON.stringify({ baseline: { "a.md": 100 } }));
    expect(readBaseline("/b.json", memFs)).toEqual({
      baseline: { "a.md": 100 },
      lastReported: {},
    });
  });
});

// ---------------------------------------------------------------------------
// detectStaleness
// ---------------------------------------------------------------------------

describe("detectStaleness", () => {
  test("returns empty when no files have changed", () => {
    const baseline: SessionBaseline = {
      baseline: { "a.md": 100 },
      lastReported: {},
    };
    expect(detectStaleness(baseline, { "a.md": 100 })).toEqual([]);
  });

  test("flags files whose mtime advanced beyond baseline", () => {
    const baseline: SessionBaseline = {
      baseline: { "a.md": 100 },
      lastReported: {},
    };
    const stale = detectStaleness(baseline, { "a.md": 200 });
    expect(stale).toEqual([{ path: "a.md", kind: "modified", currentMtime: 200 }]);
  });

  test("suppresses re-warning when mtime equals lastReported", () => {
    const baseline: SessionBaseline = {
      baseline: { "a.md": 100 },
      lastReported: { "a.md": 200 },
    };
    expect(detectStaleness(baseline, { "a.md": 200 })).toEqual([]);
  });

  test("re-warns when file changes again past lastReported", () => {
    const baseline: SessionBaseline = {
      baseline: { "a.md": 100 },
      lastReported: { "a.md": 200 },
    };
    const stale = detectStaleness(baseline, { "a.md": 300 });
    expect(stale).toEqual([{ path: "a.md", kind: "modified", currentMtime: 300 }]);
  });

  test("flags deletions", () => {
    const baseline: SessionBaseline = {
      baseline: { "a.md": 100, "b.md": 200 },
      lastReported: {},
    };
    const stale = detectStaleness(baseline, { "b.md": 200 });
    expect(stale).toEqual([{ path: "a.md", kind: "deleted", currentMtime: 0 }]);
  });

  test("does not flag deletions already reported (sentinel mtime 0)", () => {
    const baseline: SessionBaseline = {
      baseline: { "a.md": 100 },
      lastReported: { "a.md": 0 },
    };
    expect(detectStaleness(baseline, {})).toEqual([]);
  });

  test("ignores files newly added since baseline", () => {
    const baseline: SessionBaseline = {
      baseline: { "a.md": 100 },
      lastReported: {},
    };
    expect(detectStaleness(baseline, { "a.md": 100, "new.md": 500 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildWarning
// ---------------------------------------------------------------------------

describe("buildWarning", () => {
  test("returns empty string when stale list is empty", () => {
    expect(buildWarning([])).toBe("");
  });

  test("formats single file", () => {
    const text = buildWarning([
      { path: ".claude/skills/x/SKILL.md", kind: "modified", currentMtime: 100 },
    ]);
    expect(text).toContain("1 skill/agent/rule file changed");
    expect(text).toContain(".claude/skills/x/SKILL.md (modified)");
    expect(text).toContain("fresh session");
    expect(text.startsWith("<system-reminder>")).toBe(true);
    expect(text.endsWith("</system-reminder>")).toBe(true);
  });

  test("formats multiple files with plural", () => {
    const text = buildWarning([
      { path: "a.md", kind: "modified", currentMtime: 100 },
      { path: "b.md", kind: "deleted", currentMtime: 0 },
    ]);
    expect(text).toContain("2 skill/agent/rule files changed");
    expect(text).toContain("a.md (modified)");
    expect(text).toContain("b.md (deleted)");
  });

  test("caps the listed file count and surfaces overflow", () => {
    const stale = Array.from({ length: MAX_FILES_LISTED + 5 }, (_, i) => ({
      path: `f${i}.md`,
      kind: "modified" as const,
      currentMtime: i,
    }));
    const text = buildWarning(stale);
    expect(text).toContain(`${stale.length} skill/agent/rule files changed`);
    expect(text).toContain("+ 5 more");
    // Listed count should be exactly MAX_FILES_LISTED
    const listedMatches = text.match(/^\s+- /gm) ?? [];
    expect(listedMatches.length).toBe(MAX_FILES_LISTED);
  });
});

// ---------------------------------------------------------------------------
// decideAndUpdate (full decision tree)
// ---------------------------------------------------------------------------

describe("decideAndUpdate", () => {
  function setupProject(memFs: ReturnType<typeof makeFs>) {
    memFs.setDir(SKILLS_DIR_ABS, ["verify-task"]);
    memFs.setDir(`${SKILLS_DIR_ABS}/verify-task`, ["SKILL.md"]);
    memFs.setFile(SKILL_VERIFY_TASK_ABS, 100, "v1");
    memFs.setDir(AGENTS_DIR_ABS, ["reviewer.md"]);
    memFs.setFile(AGENT_REVIEWER_ABS, 200, "rv");
  }

  function seedBaselineFile(
    memFs: ReturnType<typeof makeFs>,
    baseline: SessionBaseline,
    path: string = BASELINE_PATH_FOR_SESS_1
  ) {
    memFs.setFile(path, 0, JSON.stringify(baseline));
  }

  const PRISTINE_BASELINE: SessionBaseline = {
    baseline: { [SKILL_VERIFY_TASK_REL]: 100, [AGENT_REVIEWER_REL]: 200 },
    lastReported: {},
  };

  test("first invocation initializes baseline and emits no warning", () => {
    const memFs = makeFs();
    setupProject(memFs);

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: {},
      fs: memFs,
      homeOverride: "/home/u",
    });

    expect(result.injection).toBeNull();
    expect(result.newBaseline).not.toBeNull();
    expect(result.newBaseline?.baseline).toEqual({
      [SKILL_VERIFY_TASK_REL]: 100,
      [AGENT_REVIEWER_REL]: 200,
    });
    expect(result.newBaseline?.lastReported).toEqual({});
    expect(result.log.skipReason).toBe("baseline-init");
    expect(result.log.baselineExisted).toBe(false);
    expect(result.log.watchedFileCount).toBe(2);
  });

  test("opt-out env var short-circuits before any fs work", () => {
    const memFs = makeFs();
    // Project is intentionally empty — proves we don't even snapshot when opted out.
    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: { [OPT_OUT_ENV]: "1" },
      fs: memFs,
      homeOverride: "/home/u",
    });

    expect(result.injection).toBeNull();
    expect(result.newBaseline).toBeNull();
    expect(result.log.skipReason).toBe("opt-out");
  });

  test("opt-out accepts truthy values: 1, true, yes (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "Yes"]) {
      const memFs = makeFs();
      const result = decideAndUpdate({
        projectDir: PROJECT_DIR,
        sessionId: "s",
        env: { [OPT_OUT_ENV]: v },
        fs: memFs,
        homeOverride: HOME_DIR,
      });
      expect(result.log.skipReason).toBe("opt-out");
    }
  });

  test("opt-out rejects falsy values: 0, false, empty", () => {
    for (const v of ["0", "false", ""]) {
      const memFs = makeFs();
      setupProject(memFs);
      const result = decideAndUpdate({
        projectDir: PROJECT_DIR,
        sessionId: "s",
        env: { [OPT_OUT_ENV]: v },
        fs: memFs,
        homeOverride: HOME_DIR,
      });
      // Should NOT short-circuit; should baseline-init instead
      expect(result.log.skipReason).toBe("baseline-init");
    }
  });

  test("subsequent invocation with no changes emits no warning", () => {
    const memFs = makeFs();
    setupProject(memFs);
    seedBaselineFile(memFs, PRISTINE_BASELINE);

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: {},
      fs: memFs,
      homeOverride: HOME_DIR,
    });

    expect(result.injection).toBeNull();
    expect(result.newBaseline).toBeNull();
    expect(result.log.skipReason).toBe("no-change");
    expect(result.log.staleCount).toBe(0);
  });

  test("file change since baseline produces warning + updated lastReported", () => {
    const memFs = makeFs();
    setupProject(memFs);
    memFs.setFile(SKILL_VERIFY_TASK_ABS, 999, "v2"); // changed
    seedBaselineFile(memFs, PRISTINE_BASELINE);

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: {},
      fs: memFs,
      homeOverride: HOME_DIR,
    });

    const injection = requireNotNull(result.injection, "injection should be present");
    expect(injection).toContain(`${SKILL_VERIFY_TASK_REL} (modified)`);
    expect(result.newBaseline?.lastReported).toEqual({
      [SKILL_VERIFY_TASK_REL]: 999,
    });
    // Baseline itself preserved (not advanced)
    expect(result.newBaseline?.baseline[SKILL_VERIFY_TASK_REL]).toBe(100);
    expect(result.log.warned).toBe(true);
    expect(result.log.staleCount).toBe(1);
  });

  test("re-warning suppression: same change reported twice → second turn no warning", () => {
    const memFs = makeFs();
    setupProject(memFs);
    memFs.setFile(SKILL_VERIFY_TASK_ABS, 999, "v2");
    seedBaselineFile(memFs, {
      baseline: PRISTINE_BASELINE.baseline,
      lastReported: { [SKILL_VERIFY_TASK_REL]: 999 },
    });

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: {},
      fs: memFs,
      homeOverride: HOME_DIR,
    });

    expect(result.injection).toBeNull();
    expect(result.log.staleCount).toBe(0);
  });

  test("batch change: multiple files change → ONE consolidated message", () => {
    const memFs = makeFs();
    memFs.setDir(SKILLS_DIR_ABS, ["a", "b", "c"]);
    memFs.setDir(`${SKILLS_DIR_ABS}/a`, ["SKILL.md"]);
    memFs.setDir(`${SKILLS_DIR_ABS}/b`, ["SKILL.md"]);
    memFs.setDir(`${SKILLS_DIR_ABS}/c`, ["SKILL.md"]);
    memFs.setFile(`${SKILLS_DIR_ABS}/a/SKILL.md`, 999);
    memFs.setFile(`${SKILLS_DIR_ABS}/b/SKILL.md`, 999);
    memFs.setFile(`${SKILLS_DIR_ABS}/c/SKILL.md`, 999);
    seedBaselineFile(memFs, {
      baseline: {
        ".claude/skills/a/SKILL.md": 100,
        ".claude/skills/b/SKILL.md": 200,
        ".claude/skills/c/SKILL.md": 300,
      },
      lastReported: {},
    });

    const result = decideAndUpdate({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      env: {},
      fs: memFs,
      homeOverride: HOME_DIR,
    });

    const injection = requireNotNull(result.injection, "injection should be present");
    // One block with 3 entries — count occurrences of "(modified)"
    const matches = injection.match(/\(modified\)/g) ?? [];
    expect(matches.length).toBe(3);
    expect(result.log.staleCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Sanity: WATCH_ROOTS shape
// ---------------------------------------------------------------------------

describe("WATCH_ROOTS", () => {
  test("covers the three documented watch surfaces", () => {
    const dirs = WATCH_ROOTS.map((r) => r.dir);
    expect(dirs).toContain(".claude/skills");
    expect(dirs).toContain(".claude/agents");
    expect(dirs).toContain(".minsky/rules");
  });
});
