import { describe, it, expect } from "bun:test";
import { join } from "path";
import {
  StalenessDetector,
  discoverSourceRoots,
  type SourceRootsFs,
} from "../../../src/mcp/staleness-detector";

const GIT_REV_PARSE_HEAD = "git rev-parse HEAD";
const GIT_DIFF_NAME_ONLY = "git diff --name-only";

/** This repo's root, from this file's location — no cwd dependency. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const SRC_ROOT = "src/";
const DOMAIN_SRC_ROOT = "packages/domain/src/";
const SHARED_SRC_ROOT = "packages/shared/src/";
/** The root set discovery yields on this checkout (mt#5120). */
const WIDENED_ROOTS = [SRC_ROOT, DOMAIN_SRC_ROOT, SHARED_SRC_ROOT];
/** The pre-mt#5120 root set — the negative control below runs the defect against it. */
const SRC_ONLY_ROOTS = [SRC_ROOT];
/** A change under the entry tree, for the src-only cases. */
const SRC_CHANGE = ["src/mcp/server.ts"];
/** Absolute `<pkg>/src` paths in the in-memory layouts below. */
const REPO_DOMAIN_SRC = "/repo/packages/domain/src";
const REPO_SHARED_SRC = "/repo/packages/shared/src";

/** The exact changed-file list of PR #3741 (mt#5115), the merge that exposed the defect. */
const PACKAGES_ONLY_MERGE = [
  "packages/domain/src/compile/compile-service.test.ts",
  "packages/domain/src/compile/compile-service.ts",
  "packages/domain/src/compile/compile.test.ts",
];

/**
 * A fake git that HONORS PATHSPECS: `rev-parse` moves HEAD on the second call, and
 * `diff --name-only A B -- <specs>` returns the fixture's changed files filtered by the specs
 * the detector actually passed. The fakes in the first block answer every diff with the same
 * list, which cannot tell a widened pathspec from a narrow one; this one can, which is what
 * makes the three-way test below a test of the ROOT SET rather than of the fixture.
 */
function pathspecHonoringExec(changedFiles: string[]) {
  let revParseCalls = 0;
  const diffCommands: string[] = [];
  const exec = (cmd: string) => {
    if (cmd === GIT_REV_PARSE_HEAD) {
      revParseCalls++;
      return Buffer.from(revParseCalls === 1 ? "startupab\n" : "movedhead\n");
    }
    if (cmd.startsWith(GIT_DIFF_NAME_ONLY)) {
      diffCommands.push(cmd);
      const specs = cmd
        .slice(cmd.indexOf(" -- ") + " -- ".length)
        .split(" ")
        .filter(Boolean);
      const matched = changedFiles.filter((file) => specs.some((spec) => file.startsWith(spec)));
      return Buffer.from(matched.length === 0 ? "" : `${matched.join("\n")}\n`);
    }
    return Buffer.from("");
  };
  return { exec, diffCommands };
}

function detectorOver(changedFiles: string[], roots: string[]) {
  const git = pathspecHonoringExec(changedFiles);
  const detector = new StalenessDetector("/fake/path", git.exec as any, () => roots);
  // Reset lastCheckTime so the check actually runs (bypasses 60s debounce)
  (detector as any).lastCheckTime = 0;
  return { detector, git };
}

describe("StalenessDetector", () => {
  it("returns null warning when HEAD hasn't moved", () => {
    const fakeExec = (cmd: string) => {
      if (cmd === GIT_REV_PARSE_HEAD) return Buffer.from("abc123\n");
      return Buffer.from("");
    };
    const detector = new StalenessDetector("/fake/path", fakeExec as any);
    expect(detector.getStaleWarning()).toBeNull();
  });

  it("returns a warning when HEAD moved and src/ changed", () => {
    let callCount = 0;
    const fakeExec = (cmd: string) => {
      if (cmd === GIT_REV_PARSE_HEAD) {
        callCount++;
        return Buffer.from(callCount === 1 ? "oldhead1234\n" : "newhead5678\n");
      }
      if (cmd.includes(GIT_DIFF_NAME_ONLY)) {
        return Buffer.from("src/foo.ts\nsrc/bar.ts\n");
      }
      return Buffer.from("");
    };
    const detector = new StalenessDetector("/fake/path", fakeExec as any);
    // Reset lastCheckTime so the check actually runs (bypasses 60s debounce)
    (detector as any).lastCheckTime = 0;
    const warning = detector.getStaleWarning();
    expect(warning).not.toBeNull();
    expect(warning).toContain("MCP server was loaded from commit");
    expect(warning).toContain("oldhead1");
    expect(warning).toContain("newhead5");
  });

  it("returns null when HEAD moved but src/ didn't change", () => {
    let callCount = 0;
    const fakeExec = (cmd: string) => {
      if (cmd === GIT_REV_PARSE_HEAD) {
        callCount++;
        return Buffer.from(callCount === 1 ? "oldhead\n" : "newhead\n");
      }
      if (cmd.includes(GIT_DIFF_NAME_ONLY)) {
        return Buffer.from(""); // empty diff — no src/ changes
      }
      return Buffer.from("");
    };
    const detector = new StalenessDetector("/fake/path", fakeExec as any);
    (detector as any).lastCheckTime = 0;
    expect(detector.getStaleWarning()).toBeNull();
  });

  it("caches stale state once detected", () => {
    let callCount = 0;
    const fakeExec = (cmd: string) => {
      if (cmd === GIT_REV_PARSE_HEAD) {
        callCount++;
        return Buffer.from(callCount === 1 ? "old\n" : "new\n");
      }
      if (cmd.includes(GIT_DIFF_NAME_ONLY)) {
        return Buffer.from("src/x.ts\n");
      }
      return Buffer.from("");
    };
    const detector = new StalenessDetector("/fake/path", fakeExec as any);
    (detector as any).lastCheckTime = 0;
    const first = detector.getStaleWarning();
    // Second call returns cached result (isStale=true path, no re-check needed)
    const second = detector.getStaleWarning();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("isCurrentlyStale() reflects cached stale state", () => {
    let callCount = 0;
    const fakeExec = (cmd: string) => {
      if (cmd === GIT_REV_PARSE_HEAD) {
        callCount++;
        return Buffer.from(callCount === 1 ? "startHead\n" : "endHead\n");
      }
      if (cmd.includes(GIT_DIFF_NAME_ONLY)) {
        return Buffer.from("src/changed.ts\n");
      }
      return Buffer.from("");
    };
    const detector = new StalenessDetector("/fake/path", fakeExec as any);
    expect(detector.isCurrentlyStale()).toBe(false);
    (detector as any).lastCheckTime = 0;
    detector.getStaleWarning();
    expect(detector.isCurrentlyStale()).toBe(true);
  });
});

describe("StalenessDetector source roots (mt#5120)", () => {
  it("a merge confined to packages/domain/src/** is stale under the widened roots", () => {
    // The mt#5115 shape: PR #3741 changed only these three files and the daemon served the
    // pre-merge build until a manual restart, because the diff was `-- src/` alone.
    const { detector } = detectorOver(PACKAGES_ONLY_MERGE, WIDENED_ROOTS);
    const warning = detector.getStaleWarning();
    expect(warning).not.toBeNull();
    expect(warning).toContain("loaded from commit startupa");
    expect(warning).toContain("now at movedhea");
  });

  it("a merge confined to packages/shared/src/** is stale under the widened roots", () => {
    const { detector } = detectorOver(["packages/shared/src/logger.ts"], WIDENED_ROOTS);
    expect(detector.getStaleWarning()).not.toBeNull();
  });

  it("a merge confined to src/** is still stale", () => {
    const { detector } = detectorOver(SRC_CHANGE, WIDENED_ROOTS);
    expect(detector.getStaleWarning()).not.toBeNull();
  });

  it("a merge confined to docs/** or .minsky/hooks/** is not stale", () => {
    // Neither tree is in the server's import closure: `src/` does not import the hook tree
    // (mt#4010), and docs are never loaded.
    const docsOnly = detectorOver(["docs/mcp-source-freshness.md"], WIDENED_ROOTS);
    expect(docsOnly.detector.getStaleWarning()).toBeNull();
    expect(docsOnly.detector.isCurrentlyStale()).toBe(false);

    const hooksOnly = detectorOver([".minsky/hooks/registry.ts"], WIDENED_ROOTS);
    expect(hooksOnly.detector.getStaleWarning()).toBeNull();
    expect(hooksOnly.detector.isCurrentlyStale()).toBe(false);
  });

  it("negative control: the same packages-only merge under the old src/-only roots is NOT stale", () => {
    // Pins the defect this task fixes, and proves the fake honours pathspecs: with the
    // pre-mt#5120 root set the identical change is invisible.
    const { detector } = detectorOver(PACKAGES_ONLY_MERGE, SRC_ONLY_ROOTS);
    expect(detector.getStaleWarning()).toBeNull();
    expect(detector.isCurrentlyStale()).toBe(false);
  });

  it("a discovery that throws reads as not-stale instead of failing the tool call", () => {
    // `getStaleWarning` runs on the tools/call path; a filesystem error during discovery has
    // to degrade the way a failed `git diff` already does.
    const git = pathspecHonoringExec(PACKAGES_ONLY_MERGE);
    const detector = new StalenessDetector("/fake/path", git.exec as any, () => {
      throw new Error("EACCES");
    });
    (detector as any).lastCheckTime = 0;
    expect(detector.getStaleWarning()).toBeNull();
    expect(detector.isCurrentlyStale()).toBe(false);
    expect(git.diffCommands).toHaveLength(0);
  });

  it("never lets a root that is not shell-safe reach the command string (PR #3748 R1)", () => {
    // The diff is a SHELL string. Discovery already refuses such names; this is the sink-side
    // check, exercised through the injected seam that bypasses discovery.
    const hostile = [
      "src/",
      "packages/evil; rm -rf ~/src/",
      "packages/$(id)/src/",
      "packages/a b/src/",
    ];
    const { detector, git } = detectorOver(SRC_CHANGE, hostile);
    detector.getStaleWarning();
    expect(git.diffCommands).toHaveLength(1);
    expect(git.diffCommands[0]).toBe("git diff --name-only startupab movedhead -- src/");
  });

  it("issues no diff at all when every root was refused", () => {
    const { detector, git } = detectorOver(SRC_CHANGE, ["packages/$(id)/src/"]);
    expect(detector.getStaleWarning()).toBeNull();
    expect(git.diffCommands).toHaveLength(0);
  });

  it("hands git every discovered root as its own pathspec, in one diff", () => {
    const { detector, git } = detectorOver(SRC_CHANGE, WIDENED_ROOTS);
    detector.getStaleWarning();
    expect(git.diffCommands).toHaveLength(1);
    expect(git.diffCommands[0]).toBe(
      `git diff --name-only startupab movedhead -- ${WIDENED_ROOTS.join(" ")}`
    );
  });
});

describe("discoverSourceRoots (mt#5120)", () => {
  /** An in-memory layout: `packages/` holds these entries; `srcDirs` are the paths that are dirs. */
  function layoutFs(packageNames: string[] | null, srcDirs: string[]): SourceRootsFs {
    return {
      listDirectories: (dir) => {
        if (packageNames === null) throw new Error(`ENOENT: ${dir}`);
        expect(dir).toBe("/repo/packages");
        return packageNames;
      },
      isDirectory: (path) => srcDirs.includes(path),
    };
  }

  it("lists src/ first, then every packages/<pkg>/src/ that exists, sorted", () => {
    const fs = layoutFs(["shared", "domain", "no-src-here"], [REPO_DOMAIN_SRC, REPO_SHARED_SRC]);
    expect(discoverSourceRoots("/repo", fs)).toEqual(WIDENED_ROOTS);
  });

  it("degrades to src/ alone when packages/ is missing or unreadable", () => {
    expect(discoverSourceRoots("/repo", layoutFs(null, []))).toEqual(SRC_ONLY_ROOTS);
  });

  it("refuses a package directory whose name is not shell-safe (PR #3748 R1)", () => {
    // Directory names come off the live filesystem and end up in a shell command string; a
    // name carrying whitespace or a metacharacter is skipped, never escaped.
    const fs = layoutFs(
      ["domain", "evil; rm -rf ~", "$(id)", "sp ace", "shared", "ok-name.v2"],
      [
        REPO_DOMAIN_SRC,
        "/repo/packages/evil; rm -rf ~/src",
        "/repo/packages/$(id)/src",
        "/repo/packages/sp ace/src",
        REPO_SHARED_SRC,
        "/repo/packages/ok-name.v2/src",
      ]
    );
    expect(discoverSourceRoots("/repo", fs)).toEqual([
      SRC_ROOT,
      DOMAIN_SRC_ROOT,
      "packages/ok-name.v2/src/",
      SHARED_SRC_ROOT,
    ]);
  });

  it("covers a package nobody named in code", () => {
    // The reason the roots are discovered rather than listed: a hard-coded pair would drift
    // from the real closure the day a third workspace package appears.
    const fs = layoutFs(
      ["domain", "future", "shared"],
      [REPO_DOMAIN_SRC, "/repo/packages/future/src", REPO_SHARED_SRC]
    );
    expect(discoverSourceRoots("/repo", fs)).toContain("packages/future/src/");
  });

  it("on this checkout, discovery yields src/ plus every workspace package's src/", () => {
    // Repo-invariant, against the real layout: the root set the daemon diffs on THIS repo must
    // include both packages the entry point imports. If a package is added or renamed this
    // still passes — discovery is the point — but if discovery ever misses an existing
    // package's src/, this is where it shows.
    const roots = discoverSourceRoots(REPO_ROOT);
    expect(roots[0]).toBe(SRC_ROOT);
    expect(roots).toContain(DOMAIN_SRC_ROOT);
    expect(roots).toContain(SHARED_SRC_ROOT);
    for (const root of roots) expect(root.endsWith("/")).toBe(true);
  });
});
