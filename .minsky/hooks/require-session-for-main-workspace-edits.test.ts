import { describe, expect, it } from "bun:test";
import {
  checkFilePathDenial,
  contentHasConflictMarkers,
  deriveMainWorkspace,
  deriveSessionWorkspaceRoot,
  MAIN_WORKSPACE,
  SESSION_WORKSPACE_ROOT,
} from "./require-session-for-main-workspace-edits";
import type { MergeDetectFs } from "./types";

// ---------------------------------------------------------------------------
// Helpers: injectable readFile implementations for testing
// ---------------------------------------------------------------------------

/** Returns a readFile that always returns the given content. */
function fakeReadFile(content: string): (path: string) => string {
  return (_path: string) => content;
}

/** Returns a readFile that always throws (simulates file not found). */
function fakeReadFileError(msg = "ENOENT: no such file or directory"): (path: string) => string {
  return (_path: string) => {
    throw new Error(msg);
  };
}

const CONFLICT_CONTENT = [
  "<<<<<<< HEAD",
  "const x = 1;",
  "=======",
  "const x = 2;",
  ">>>>>>> origin/main",
].join("\n");

const CLEAN_CONTENT = "const x = 1;\nconst y = 2;\n";

/** Canonical prefix of the main-workspace edit denial reason — hoisted to avoid duplication warnings. */
const MAIN_WORKSPACE_BLOCKED_MSG = "Main workspace edit blocked";

/**
 * In-memory `MergeDetectFs` for `deriveMainWorkspace`/`findRepoRoot` tests —
 * no real filesystem access, per the project's `no-real-fs-in-tests` lint
 * rule. Mirrors the `makeFakeFs` helper in `check-branch-fresh.test.ts`.
 */
function makeFakeFs(
  opts: { directories?: string[]; files?: Record<string, string> } = {}
): MergeDetectFs {
  const directories = new Set(opts.directories ?? []);
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const present = new Set<string>([...directories, ...files.keys()]);
  return {
    existsSync: (p) => present.has(p),
    statSync: (p) => ({
      isDirectory: () => directories.has(p),
      isFile: () => files.has(p),
    }),
    readFileSync: (p) => {
      const content = files.get(p);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: "ENOENT" });
      }
      return content;
    },
  };
}

// ---------------------------------------------------------------------------
// contentHasConflictMarkers — pure string checks
// ---------------------------------------------------------------------------

describe("contentHasConflictMarkers", () => {
  it("returns true when all three conflict markers are present", () => {
    expect(contentHasConflictMarkers(CONFLICT_CONTENT)).toBe(true);
  });

  it("returns false when file has no conflict markers", () => {
    expect(contentHasConflictMarkers(CLEAN_CONTENT)).toBe(false);
  });

  it("returns false when only the start marker is present", () => {
    expect(contentHasConflictMarkers("<<<<<<< HEAD\nconst x = 1;\n")).toBe(false);
  });

  it("returns false when start + separator are present but no end marker", () => {
    expect(contentHasConflictMarkers("<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n")).toBe(
      false
    );
  });

  it("returns false when only separator is present", () => {
    expect(contentHasConflictMarkers("just some\n=======\ncontent")).toBe(false);
  });

  it("returns true for multi-section conflict content", () => {
    const multiSection = [
      "<<<<<<< HEAD",
      "line A",
      "=======",
      "line B",
      ">>>>>>> feature/branch",
      "more content",
    ].join("\n");
    expect(contentHasConflictMarkers(multiSection)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkFilePathDenial — conflict-resolution carve-out (mt#1806)
// ---------------------------------------------------------------------------

describe("checkFilePathDenial — conflict-resolution carve-out", () => {
  it("permits Edit on a main-workspace file that contains conflict markers", () => {
    const r = checkFilePathDenial(
      "Edit",
      `${MAIN_WORKSPACE}/src/domain/session.ts`,
      fakeReadFile(CONFLICT_CONTENT)
    );
    expect(r.denied).toBe(false);
  });

  it("permits Write on a main-workspace file that contains conflict markers", () => {
    const r = checkFilePathDenial(
      "Write",
      `${MAIN_WORKSPACE}/src/new-file.ts`,
      fakeReadFile(CONFLICT_CONTENT)
    );
    expect(r.denied).toBe(false);
  });

  it("permits NotebookEdit on a main-workspace file that contains conflict markers", () => {
    const r = checkFilePathDenial(
      "NotebookEdit",
      `${MAIN_WORKSPACE}/notebooks/analysis.ipynb`,
      fakeReadFile(CONFLICT_CONTENT)
    );
    expect(r.denied).toBe(false);
  });

  it("denies Edit on a main-workspace file WITHOUT conflict markers (acceptance test #3)", () => {
    const r = checkFilePathDenial(
      "Edit",
      `${MAIN_WORKSPACE}/src/domain/session.ts`,
      fakeReadFile(CLEAN_CONTENT)
    );
    expect(r.denied).toBe(true);
    expect(r.reason).toContain("Main workspace edit blocked");
  });

  it("denies (fail-closed) when file cannot be read (ENOENT — Write creating new file)", () => {
    const r = checkFilePathDenial(
      "Write",
      `${MAIN_WORKSPACE}/src/brand-new-file.ts`,
      fakeReadFileError()
    );
    expect(r.denied).toBe(true);
    expect(r.reason).toContain(MAIN_WORKSPACE_BLOCKED_MSG);
  });

  it("denies (fail-closed) when file read throws a permission error", () => {
    const r = checkFilePathDenial(
      "Edit",
      `${MAIN_WORKSPACE}/src/domain/session.ts`,
      fakeReadFileError("EACCES: permission denied")
    );
    expect(r.denied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkFilePathDenial — existing behavior unchanged
// ---------------------------------------------------------------------------

describe("checkFilePathDenial", () => {
  describe("denies main-workspace edits", () => {
    it("blocks Edit on src/ file", () => {
      const r = checkFilePathDenial(
        "Edit",
        `${MAIN_WORKSPACE}/src/domain/session.ts`,
        fakeReadFile(CLEAN_CONTENT)
      );
      expect(r.denied).toBe(true);
      expect(r.reason).toContain("session_edit_file");
      expect(r.reason).toContain("mt#1103");
    });

    it("blocks Write on a new file under main workspace (file doesn't exist)", () => {
      const r = checkFilePathDenial(
        "Write",
        `${MAIN_WORKSPACE}/services/reviewer/new.ts`,
        fakeReadFileError()
      );
      expect(r.denied).toBe(true);
      expect(r.reason).toContain(MAIN_WORKSPACE_BLOCKED_MSG);
    });

    it("blocks NotebookEdit on main workspace", () => {
      const r = checkFilePathDenial(
        "NotebookEdit",
        `${MAIN_WORKSPACE}/notebooks/analysis.ipynb`,
        fakeReadFile(CLEAN_CONTENT)
      );
      expect(r.denied).toBe(true);
    });

    it("blocks edits to .claude/ directory under main workspace", () => {
      const r = checkFilePathDenial(
        "Edit",
        `${MAIN_WORKSPACE}/.claude/hooks/example.ts`,
        fakeReadFile(CLEAN_CONTENT)
      );
      expect(r.denied).toBe(true);
    });

    it("blocks edits to the workspace root itself", () => {
      const r = checkFilePathDenial("Edit", MAIN_WORKSPACE, fakeReadFileError());
      expect(r.denied).toBe(true);
    });
  });

  describe("allows session-workspace edits", () => {
    it("allows Edit inside a session workspace", () => {
      const r = checkFilePathDenial(
        "Edit",
        `${SESSION_WORKSPACE_ROOT}/abc-123/sessions/abc-123/src/foo.ts`
      );
      expect(r.denied).toBe(false);
    });

    it("allows Write inside a session workspace", () => {
      const r = checkFilePathDenial("Write", `${SESSION_WORKSPACE_ROOT}/abc-123/new-file.ts`);
      expect(r.denied).toBe(false);
    });
  });

  describe("allows edits outside the main repo", () => {
    it("allows /tmp/ paths", () => {
      expect(checkFilePathDenial("Edit", "/tmp/scratch.ts").denied).toBe(false);
    });

    it("allows home-directory memory files", () => {
      expect(
        checkFilePathDenial(
          "Edit",
          "/Users/edobry/.claude/projects/-Users-edobry-Projects-minsky/memory/MEMORY.md"
        ).denied
      ).toBe(false);
    });

    it("allows edits in other Projects/ directories", () => {
      expect(checkFilePathDenial("Edit", "/Users/edobry/Projects/raycast/index.ts").denied).toBe(
        false
      );
    });
  });

  describe("ignores non-file-editing tools", () => {
    it("allows Bash regardless of path", () => {
      expect(checkFilePathDenial("Bash", `${MAIN_WORKSPACE}/anything`).denied).toBe(false);
    });

    it("allows Read regardless of path", () => {
      expect(checkFilePathDenial("Read", `${MAIN_WORKSPACE}/src/foo.ts`).denied).toBe(false);
    });

    it("allows the MCP session_edit_file tool itself", () => {
      expect(
        checkFilePathDenial("mcp__minsky__session_edit_file", `${MAIN_WORKSPACE}/src/foo.ts`).denied
      ).toBe(false);
    });
  });

  describe("handles edge cases", () => {
    it("allows undefined file_path (pass-through, tool will handle)", () => {
      expect(checkFilePathDenial("Edit", undefined).denied).toBe(false);
    });

    it("allows relative paths (pass-through, Edit enforces absolute)", () => {
      expect(checkFilePathDenial("Edit", "relative/file.ts").denied).toBe(false);
    });

    it("does NOT match a path that merely contains the main workspace as a substring", () => {
      // e.g., a different project whose name starts with the same prefix
      expect(checkFilePathDenial("Edit", `${MAIN_WORKSPACE}-other/src/foo.ts`).denied).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// mt#2928 — machine-agnostic MAIN_WORKSPACE / SESSION_WORKSPACE_ROOT
// derivation (no more hardcoded /Users/edobry literals)
// ---------------------------------------------------------------------------

describe("deriveMainWorkspace", () => {
  it("resolves the repo root by walking up from the hook's own directory", () => {
    const repoRoot = "/mock/other-checkout/minsky";
    const fs = makeFakeFs({ directories: [`${repoRoot}/.git`] });
    expect(deriveMainWorkspace(`${repoRoot}/.minsky/hooks`, fs)).toBe(repoRoot);
  });

  it("resolves correctly for a repo checked out at a non-/Users/edobry absolute path (acceptance test)", () => {
    // e.g. a CI runner, a different user account, or a Linux deployment host.
    const repoRoot = "/opt/checkouts/minsky-fork";
    const fs = makeFakeFs({ directories: [`${repoRoot}/.git`] });
    expect(deriveMainWorkspace(`${repoRoot}/.claude/hooks`, fs)).toBe(repoRoot);
  });

  it("resolves correctly for a repo owned by a different user account", () => {
    const repoRoot = "/home/someoneelse/minsky";
    const fs = makeFakeFs({ directories: [`${repoRoot}/.git`] });
    expect(deriveMainWorkspace(`${repoRoot}/.minsky/hooks`, fs)).toBe(repoRoot);
  });

  it("falls back to the start directory when no .git is found anywhere up the tree", () => {
    const fs = makeFakeFs({});
    expect(deriveMainWorkspace("/mock/no-repo-here/.minsky/hooks", fs)).toBe(
      "/mock/no-repo-here/.minsky/hooks"
    );
  });
});

describe("deriveSessionWorkspaceRoot", () => {
  it("defaults to <home>/.local/state/minsky/sessions when no env override is set", () => {
    expect(deriveSessionWorkspaceRoot({}, "/Users/edobry")).toBe(
      "/Users/edobry/.local/state/minsky/sessions"
    );
  });

  it("resolves correctly for a different HOME (acceptance test)", () => {
    expect(deriveSessionWorkspaceRoot({}, "/home/someoneelse")).toBe(
      "/home/someoneelse/.local/state/minsky/sessions"
    );
  });

  it("prefers env.HOME over the injected home param when both are present", () => {
    expect(deriveSessionWorkspaceRoot({ HOME: "/home/from-env" }, "/home/from-param")).toBe(
      "/home/from-env/.local/state/minsky/sessions"
    );
  });

  it("honors MINSKY_STATE_DIR as the highest-precedence override", () => {
    expect(
      deriveSessionWorkspaceRoot({ MINSKY_STATE_DIR: "/custom/state/minsky" }, "/Users/edobry")
    ).toBe("/custom/state/minsky/sessions");
  });

  it("honors XDG_STATE_HOME when MINSKY_STATE_DIR is unset", () => {
    expect(
      deriveSessionWorkspaceRoot({ XDG_STATE_HOME: "/custom/xdg-state" }, "/Users/edobry")
    ).toBe("/custom/xdg-state/minsky/sessions");
  });

  it("MINSKY_STATE_DIR wins over XDG_STATE_HOME when both are set", () => {
    expect(
      deriveSessionWorkspaceRoot(
        { MINSKY_STATE_DIR: "/custom/state/minsky", XDG_STATE_HOME: "/custom/xdg-state" },
        "/Users/edobry"
      )
    ).toBe("/custom/state/minsky/sessions");
  });
});

describe("checkFilePathDenial — injected workspace roots (mt#2928 acceptance)", () => {
  it("classifies main-workspace vs session-workspace edits correctly under a mocked/temp repo root", () => {
    const mockMainWorkspace = "/opt/checkouts/minsky-fork";
    const mockSessionRoot = "/opt/checkouts/minsky-fork-sessions";

    // Edit under the mocked main workspace, no conflict markers -> denied.
    const mainEdit = checkFilePathDenial(
      "Edit",
      `${mockMainWorkspace}/src/domain/session.ts`,
      fakeReadFile(CLEAN_CONTENT),
      mockMainWorkspace,
      mockSessionRoot
    );
    expect(mainEdit.denied).toBe(true);
    expect(mainEdit.reason).toContain(MAIN_WORKSPACE_BLOCKED_MSG);

    // Edit under the mocked session-workspace root -> allowed.
    const sessionEdit = checkFilePathDenial(
      "Edit",
      `${mockSessionRoot}/abc-123/src/domain/session.ts`,
      fakeReadFile(CLEAN_CONTENT),
      mockMainWorkspace,
      mockSessionRoot
    );
    expect(sessionEdit.denied).toBe(false);
  });

  it("session-workspace-root detection still works when derived from a different HOME (acceptance test)", () => {
    const derivedSessionRoot = deriveSessionWorkspaceRoot({}, "/home/someoneelse");
    const r = checkFilePathDenial(
      "Write",
      `${derivedSessionRoot}/task-456/new-file.ts`,
      undefined,
      MAIN_WORKSPACE,
      derivedSessionRoot
    );
    expect(r.denied).toBe(false);
  });
});
