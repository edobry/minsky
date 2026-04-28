/**
 * Tests for the nested-workspace install path added in mt#1379.
 *
 * Covers:
 *   - readRootWorkspacePatterns: array form, object-with-packages form,
 *     missing field, malformed JSON, missing package.json
 *   - isCoveredByWorkspacePattern: literal match, glob match, no match
 *   - discoverNestedPackages: services/ and packages/ scanning, workspace
 *     skipping, missing-package.json skipping, missing readdirSync
 *   - installNestedDependencies: best-effort orchestration, partial-failure
 *     handling, no-op when nothing discovered, never throws
 *
 * All tests use injected fs/process deps — no real filesystem, no
 * `bun install` calls.
 */

import { describe, expect, test } from "bun:test";
import {
  readRootWorkspacePatterns,
  isCoveredByWorkspacePattern,
  discoverNestedPackages,
  installNestedDependencies,
  NESTED_PACKAGE_PARENTS,
  type PackageManagerDependencies,
} from "./package-manager";

// ---------------------------------------------------------------------------
// Shared test fixtures (extracted to avoid magic-string duplication warnings)
// ---------------------------------------------------------------------------

const REPO = "/repo";
const ROOT_PKG = `${REPO}/package.json`;
const SVC_REVIEWER = `${REPO}/services/reviewer`;
const SVC_REVIEWER_PKG = `${SVC_REVIEWER}/package.json`;
const PKG_CORE = `${REPO}/packages/core`;
const PKG_CORE_PKG = `${PKG_CORE}/package.json`;
const SVC_BROKEN = `${REPO}/services/broken`;
const SVC_HEALTHY = `${REPO}/services/healthy`;

// ---------------------------------------------------------------------------
// Fixture: build a deps object backed by an in-memory filesystem map
// ---------------------------------------------------------------------------

interface FakeFsState {
  files: Map<string, string>;
  dirs: Map<string, string[]>;
}

function buildDeps(opts: {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  installResults?: Map<string, { success: boolean; error?: string }>;
  installCalls?: string[];
  installShouldThrow?: Map<string, Error>;
  logCalls?: { debug: string[]; error: string[] };
}): PackageManagerDependencies {
  const state: FakeFsState = {
    files: new Map(Object.entries(opts.files ?? {})),
    dirs: new Map(Object.entries(opts.dirs ?? {})),
  };

  const installCalls = opts.installCalls ?? [];
  const installResults = opts.installResults ?? new Map();
  const installShouldThrow = opts.installShouldThrow ?? new Map();

  const debug = opts.logCalls?.debug ?? [];
  const error = opts.logCalls?.error ?? [];

  return {
    fs: {
      existsSync: (path: string) => state.files.has(path) || state.dirs.has(path),
      readdirSync: (path: string) => state.dirs.get(path) ?? [],
      readFileSync: ((path: string, _encoding: BufferEncoding) => {
        const content = state.files.get(path);
        if (content === undefined) {
          throw new Error(`ENOENT: no such file: ${path}`);
        }
        return content;
      }) as PackageManagerDependencies["fs"]["readFileSync"],
    },
    process: {
      execSync: ((command: string, options?: { cwd?: string; stdio?: string | string[] }) => {
        const cwd = options?.cwd ?? "";
        installCalls.push(`${command} @ ${cwd}`);
        const willThrow = installShouldThrow.get(cwd);
        if (willThrow) throw willThrow;
        const r = installResults.get(cwd);
        if (r && !r.success) {
          throw new Error(r.error ?? "install failed");
        }
        return Buffer.from("ok");
      }) as PackageManagerDependencies["process"]["execSync"],
    },
    logger: {
      debug: (msg: string) => debug.push(msg),
      error: (msg: string) => error.push(msg),
    },
  };
}

// ---------------------------------------------------------------------------
// readRootWorkspacePatterns
// ---------------------------------------------------------------------------

describe("readRootWorkspacePatterns", () => {
  test("returns empty array when root package.json is missing", () => {
    const deps = buildDeps({});
    expect(readRootWorkspacePatterns("/repo", deps)).toEqual([]);
  });

  test("parses array-form workspaces", () => {
    const deps = buildDeps({
      files: {
        [ROOT_PKG]: JSON.stringify({
          workspaces: ["services/*", "packages/*"],
        }),
      },
    });
    expect(readRootWorkspacePatterns("/repo", deps)).toEqual(["services/*", "packages/*"]);
  });

  test("parses object-form workspaces (workspaces.packages)", () => {
    const deps = buildDeps({
      files: {
        [ROOT_PKG]: JSON.stringify({
          workspaces: { packages: ["apps/*", "tools/*"], nohoist: ["**/foo"] },
        }),
      },
    });
    expect(readRootWorkspacePatterns("/repo", deps)).toEqual(["apps/*", "tools/*"]);
  });

  test("returns empty array when workspaces field is absent", () => {
    const deps = buildDeps({
      files: {
        [ROOT_PKG]: JSON.stringify({ name: "minsky", version: "1.0.0" }),
      },
    });
    expect(readRootWorkspacePatterns("/repo", deps)).toEqual([]);
  });

  test("returns empty array on malformed JSON (does not throw)", () => {
    const deps = buildDeps({
      files: { [ROOT_PKG]: "{ not valid json" },
    });
    expect(readRootWorkspacePatterns("/repo", deps)).toEqual([]);
  });

  test("returns empty array when readFileSync is missing on deps", () => {
    const deps: PackageManagerDependencies = {
      fs: { existsSync: () => true },
      process: { execSync: () => null },
    };
    expect(readRootWorkspacePatterns("/repo", deps)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isCoveredByWorkspacePattern
// ---------------------------------------------------------------------------

describe("isCoveredByWorkspacePattern", () => {
  test("matches literal pattern", () => {
    expect(isCoveredByWorkspacePattern("services/foo", ["services/foo"])).toBe(true);
  });

  test("matches trailing-* glob pattern", () => {
    expect(isCoveredByWorkspacePattern("services/foo", ["services/*"])).toBe(true);
    expect(isCoveredByWorkspacePattern("packages/bar", ["packages/*"])).toBe(true);
  });

  test("does NOT match when prefix is different", () => {
    expect(isCoveredByWorkspacePattern("services/foo", ["packages/*"])).toBe(false);
    expect(isCoveredByWorkspacePattern("services/foo", ["other/*"])).toBe(false);
  });

  test("returns false for empty pattern list", () => {
    expect(isCoveredByWorkspacePattern("services/foo", [])).toBe(false);
  });

  test("matches when one of multiple patterns hits", () => {
    expect(isCoveredByWorkspacePattern("services/foo", ["packages/*", "services/foo"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// discoverNestedPackages
// ---------------------------------------------------------------------------

describe("discoverNestedPackages", () => {
  test("discovers package.json under services/", () => {
    const deps = buildDeps({
      files: {
        [SVC_REVIEWER_PKG]: "{}",
      },
      dirs: {
        "/repo/services": ["reviewer"],
      },
    });
    expect(discoverNestedPackages("/repo", deps)).toEqual([SVC_REVIEWER]);
  });

  test("scans both services/ and packages/", () => {
    const deps = buildDeps({
      files: {
        [SVC_REVIEWER_PKG]: "{}",
        [PKG_CORE_PKG]: "{}",
      },
      dirs: {
        "/repo/services": ["reviewer"],
        "/repo/packages": ["core"],
      },
    });
    const found = discoverNestedPackages("/repo", deps);
    expect(found).toContain(SVC_REVIEWER);
    expect(found).toContain("/repo/packages/core");
    expect(found).toHaveLength(2);
  });

  test("skips a nested directory covered by a root workspaces pattern (glob)", () => {
    const deps = buildDeps({
      files: {
        [ROOT_PKG]: JSON.stringify({ workspaces: ["packages/*"] }),
        [PKG_CORE_PKG]: "{}",
        [SVC_REVIEWER_PKG]: "{}",
      },
      dirs: {
        "/repo/services": ["reviewer"],
        "/repo/packages": ["core"],
      },
    });
    // packages/core is covered by "packages/*" → skipped.
    // services/reviewer is NOT covered → discovered.
    expect(discoverNestedPackages("/repo", deps)).toEqual([SVC_REVIEWER]);
  });

  test("skips directories without a package.json (silent no-op)", () => {
    const deps = buildDeps({
      files: {
        // services/legacy-archive exists as a dir but no package.json
        [SVC_REVIEWER_PKG]: "{}",
      },
      dirs: {
        "/repo/services": ["legacy-archive", "reviewer"],
      },
    });
    expect(discoverNestedPackages("/repo", deps)).toEqual([SVC_REVIEWER]);
  });

  test("returns empty when no parent directories exist", () => {
    const deps = buildDeps({});
    expect(discoverNestedPackages("/repo", deps)).toEqual([]);
  });

  test("returns empty when readdirSync is missing on deps", () => {
    const deps: PackageManagerDependencies = {
      fs: {
        existsSync: () => true,
      },
      process: { execSync: () => null },
    };
    expect(discoverNestedPackages("/repo", deps)).toEqual([]);
  });

  test("returns deterministic alphabetical order within a parent", () => {
    const deps = buildDeps({
      files: {
        "/repo/services/zeta/package.json": "{}",
        "/repo/services/alpha/package.json": "{}",
        "/repo/services/mike/package.json": "{}",
      },
      dirs: {
        "/repo/services": ["zeta", "alpha", "mike"],
      },
    });
    expect(discoverNestedPackages("/repo", deps)).toEqual([
      "/repo/services/alpha",
      "/repo/services/mike",
      "/repo/services/zeta",
    ]);
  });

  test("scans services/ before packages/ (matches NESTED_PACKAGE_PARENTS order)", () => {
    expect(NESTED_PACKAGE_PARENTS[0]).toBe("services");
    expect(NESTED_PACKAGE_PARENTS[1]).toBe("packages");

    const deps = buildDeps({
      files: {
        [SVC_REVIEWER_PKG]: "{}",
        [PKG_CORE_PKG]: "{}",
      },
      dirs: {
        "/repo/services": ["reviewer"],
        "/repo/packages": ["core"],
      },
    });
    const found = discoverNestedPackages("/repo", deps);
    expect(found[0]).toBe(SVC_REVIEWER);
    expect(found[1]).toBe("/repo/packages/core");
  });
});

// ---------------------------------------------------------------------------
// installNestedDependencies
// ---------------------------------------------------------------------------

describe("installNestedDependencies", () => {
  test("returns attempted=0 when no nested packages discovered", async () => {
    const deps = buildDeps({});
    const summary = await installNestedDependencies("/repo", { quiet: true }, deps);
    expect(summary.attempted).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results).toEqual([]);
  });

  test("installs each nested package and reports succeeded count", async () => {
    const installCalls: string[] = [];
    const deps = buildDeps({
      files: {
        [SVC_REVIEWER_PKG]: "{}",
        "/repo/services/reviewer/bun.lock": "",
        [PKG_CORE_PKG]: "{}",
        "/repo/packages/core/bun.lock": "",
      },
      dirs: {
        "/repo/services": ["reviewer"],
        "/repo/packages": ["core"],
      },
      installCalls,
    });

    const summary = await installNestedDependencies("/repo", { quiet: true }, deps);

    expect(summary.attempted).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(installCalls).toContain("bun install @ /repo/services/reviewer");
    expect(installCalls).toContain("bun install @ /repo/packages/core");
  });

  test("partial failure: one nested install fails, another succeeds — orchestration continues", async () => {
    const installCalls: string[] = [];
    const installShouldThrow = new Map([[SVC_BROKEN, new Error("execSync failed: ETIMEDOUT")]]);
    const logErrors: string[] = [];

    const deps = buildDeps({
      files: {
        "/repo/services/broken/package.json": "{}",
        "/repo/services/broken/bun.lock": "",
        "/repo/services/healthy/package.json": "{}",
        "/repo/services/healthy/bun.lock": "",
      },
      dirs: {
        "/repo/services": ["broken", "healthy"],
      },
      installCalls,
      installShouldThrow,
      logCalls: { debug: [], error: logErrors },
    });

    const summary = await installNestedDependencies("/repo", { quiet: true }, deps);

    // Both packages were attempted
    expect(summary.attempted).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);

    // The healthy package was installed despite the broken one failing first
    // (alphabetical order: broken comes before healthy)
    expect(installCalls).toContain("bun install @ /repo/services/broken");
    expect(installCalls).toContain("bun install @ /repo/services/healthy");

    // The failure was logged with the directory path
    const failureLog = logErrors.find((l) => l.includes(SVC_BROKEN) && l.includes("ETIMEDOUT"));
    expect(failureLog).toBeDefined();

    // The result array carries per-path success state
    const brokenResult = summary.results.find((r) => r.path === SVC_BROKEN);
    expect(brokenResult?.success).toBe(false);
    expect(brokenResult?.error).toContain("ETIMEDOUT");
    const healthyResult = summary.results.find((r) => r.path === SVC_HEALTHY);
    expect(healthyResult?.success).toBe(true);
  });

  test("does not throw even when every nested install fails", async () => {
    const installShouldThrow = new Map([
      ["/repo/services/a", new Error("a failed")],
      ["/repo/services/b", new Error("b failed")],
    ]);

    const deps = buildDeps({
      files: {
        "/repo/services/a/package.json": "{}",
        "/repo/services/a/bun.lock": "",
        "/repo/services/b/package.json": "{}",
        "/repo/services/b/bun.lock": "",
      },
      dirs: {
        "/repo/services": ["a", "b"],
      },
      installShouldThrow,
    });

    let didThrow = false;
    let summary: Awaited<ReturnType<typeof installNestedDependencies>> | undefined;
    try {
      summary = await installNestedDependencies("/repo", { quiet: true }, deps);
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(false);
    expect(summary?.attempted).toBe(2);
    expect(summary?.succeeded).toBe(0);
    expect(summary?.failed).toBe(2);
  });

  test("respects root workspace declarations — declared packages NOT installed twice", async () => {
    const installCalls: string[] = [];
    const deps = buildDeps({
      files: {
        // Root declares packages/* as workspaces
        [ROOT_PKG]: JSON.stringify({ workspaces: ["packages/*"] }),
        [PKG_CORE_PKG]: "{}",
        "/repo/packages/core/bun.lock": "",
        // services/reviewer is NOT a root workspace
        [SVC_REVIEWER_PKG]: "{}",
        "/repo/services/reviewer/bun.lock": "",
      },
      dirs: {
        "/repo/services": ["reviewer"],
        "/repo/packages": ["core"],
      },
      installCalls,
    });

    const summary = await installNestedDependencies("/repo", { quiet: true }, deps);

    expect(summary.attempted).toBe(1); // only services/reviewer
    expect(installCalls).toContain("bun install @ /repo/services/reviewer");
    expect(installCalls).not.toContain("bun install @ /repo/packages/core");
  });
});
