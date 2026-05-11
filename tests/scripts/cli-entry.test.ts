/**
 * Unit tests for the cli-entry.ts bin entry logic (mt#1740).
 *
 * Tests the `computeBundleDecision` function via FsDeps/ExecDeps injection —
 * no real filesystem operations, no real git/bun shell-outs.
 *
 * What is NOT tested here:
 *  - The actual `await import()` at the entry point (top-level side effect;
 *    not exercisable in unit tests without a real module system)
 *  - Real bundle output correctness (out of scope for unit tests)
 */

import { describe, test, expect } from "bun:test";
import { computeBundleDecision } from "../../scripts/cli-entry";
import type { FsDeps, ExecDeps, StderrDeps } from "../../scripts/cli-entry";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const PACKAGE_ROOT = "/fake/package/root";
const BUNDLE_PATH = `${PACKAGE_ROOT}/dist/minsky.js`;
const STAMP_PATH = `${PACKAGE_ROOT}/dist/.build-stamp`;
const SOURCE_PATH = `${PACKAGE_ROOT}/src/cli.ts`;

const CURRENT_HEAD = "abc123def456abc123def456abc123def456abc1";
const OLD_HEAD = "000000000000000000000000000000000000dead";

/** Build a FsDeps mock with configurable state. */
function makeFsDeps(opts: {
  sourceExists?: boolean;
  bundleExists?: boolean;
  stampContent?: string | null; // null = throw (missing stamp)
  realpathResult?: string;
  writeFileThrows?: boolean;
}): FsDeps & { writtenFiles: Record<string, string> } {
  const writtenFiles: Record<string, string> = {};

  return {
    writtenFiles,

    existsSync(path: string): boolean {
      if (path === SOURCE_PATH) return opts.sourceExists ?? true;
      if (path === BUNDLE_PATH) {
        // After a write, reflect the written state
        if (path in writtenFiles) return true;
        return opts.bundleExists ?? false;
      }
      return false;
    },

    readFileSync(path: string): string {
      if (path === STAMP_PATH) {
        if (opts.stampContent === null || opts.stampContent === undefined) {
          throw new Error("ENOENT: no such file");
        }
        return opts.stampContent;
      }
      throw new Error(`Unexpected readFileSync path: ${path}`);
    },

    writeFileSync(path: string, data: string): void {
      if (opts.writeFileThrows) {
        throw new Error("EACCES: permission denied");
      }
      writtenFiles[path] = data;
    },

    realpathSync(path: string): string {
      return opts.realpathResult ?? path;
    },
  };
}

/** Build an ExecDeps mock. */
function makeExecDeps(opts: {
  gitHead?: string;
  bunBuildExitCode?: number;
}): ExecDeps & { buildCalls: Array<{ cwd: string; bundlePath: string; sourcePath: string }> } {
  const buildCalls: Array<{ cwd: string; bundlePath: string; sourcePath: string }> = [];

  return {
    buildCalls,

    gitRevParseHead(_cwd: string): string {
      return opts.gitHead ?? CURRENT_HEAD;
    },

    bunBuild(args): number {
      buildCalls.push(args);
      return opts.bunBuildExitCode ?? 0;
    },
  };
}

/** Build a StderrDeps mock. */
function makeStderrDeps(): StderrDeps & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    write(message: string): void {
      messages.push(message);
    },
  };
}

// ─── Source-install detection ─────────────────────────────────────────────────

describe("computeBundleDecision / source-install detection", () => {
  test("detects source install when src/cli.ts exists", () => {
    const fs = makeFsDeps({ sourceExists: true, bundleExists: true, stampContent: CURRENT_HEAD });
    const exec = makeExecDeps({});
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    expect(result.isSourceInstall).toBe(true);
  });

  test("detects published install when src/cli.ts is absent", () => {
    const fs = makeFsDeps({ sourceExists: false, bundleExists: true, stampContent: null });
    const exec = makeExecDeps({});
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    expect(result.isSourceInstall).toBe(false);
  });

  test("published install: does not attempt rebuild even if no bundle yet", () => {
    const fs = makeFsDeps({ sourceExists: false, bundleExists: false, stampContent: null });
    const exec = makeExecDeps({});
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    expect(result.rebuildAttempted).toBe(false);
    expect(exec.buildCalls).toHaveLength(0);
  });
});

// ─── Freshness check ─────────────────────────────────────────────────────────

describe("computeBundleDecision / freshness check", () => {
  test("stamp matches HEAD → skips rebuild, reports no rebuild", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: true,
      stampContent: CURRENT_HEAD,
    });
    const exec = makeExecDeps({ gitHead: CURRENT_HEAD });
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    expect(result.rebuildAttempted).toBe(false);
    expect(exec.buildCalls).toHaveLength(0);
  });

  test("stamp is stale (different HEAD) → triggers rebuild", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: false,
      stampContent: OLD_HEAD,
    });
    const exec = makeExecDeps({ gitHead: CURRENT_HEAD, bunBuildExitCode: 0 });
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    expect(result.rebuildAttempted).toBe(true);
    expect(exec.buildCalls).toHaveLength(1);
    expect(exec.buildCalls[0]).toEqual({
      cwd: PACKAGE_ROOT,
      bundlePath: BUNDLE_PATH,
      sourcePath: SOURCE_PATH,
    });
  });

  test("stamp missing (ENOENT) → treats as stale → triggers rebuild", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: false,
      stampContent: null, // throws ENOENT
    });
    const exec = makeExecDeps({ gitHead: CURRENT_HEAD, bunBuildExitCode: 0 });
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    expect(result.rebuildAttempted).toBe(true);
  });

  test("after successful rebuild, stamp is updated to current HEAD", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: false,
      stampContent: null,
    });
    const exec = makeExecDeps({ gitHead: CURRENT_HEAD, bunBuildExitCode: 0 });
    const stderr = makeStderrDeps();

    computeBundleDecision(PACKAGE_ROOT, BUNDLE_PATH, STAMP_PATH, SOURCE_PATH, fs, exec, stderr);

    expect(fs.writtenFiles[STAMP_PATH]).toBe(CURRENT_HEAD);
  });
});

// ─── Build failure handling ───────────────────────────────────────────────────

describe("computeBundleDecision / build failure", () => {
  test("build failure → rebuildSucceeded=false, logs error to stderr", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: false,
      stampContent: null,
    });
    const exec = makeExecDeps({ gitHead: CURRENT_HEAD, bunBuildExitCode: 1 });
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    expect(result.rebuildAttempted).toBe(true);
    expect(result.rebuildSucceeded).toBe(false);
    expect(stderr.messages.some((m) => m.includes("bundle build failed"))).toBe(true);
  });

  test("build failure → stamp is NOT updated", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: false,
      stampContent: null,
    });
    const exec = makeExecDeps({ gitHead: CURRENT_HEAD, bunBuildExitCode: 1 });
    const stderr = makeStderrDeps();

    computeBundleDecision(PACKAGE_ROOT, BUNDLE_PATH, STAMP_PATH, SOURCE_PATH, fs, exec, stderr);

    expect(fs.writtenFiles[STAMP_PATH]).toBeUndefined();
  });

  test("build failure with existing bundle → bundlePresent stays true (uses old bundle)", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: true, // old bundle present
      stampContent: OLD_HEAD, // stale → triggers rebuild
    });
    const exec = makeExecDeps({ gitHead: CURRENT_HEAD, bunBuildExitCode: 1 });
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    // Old bundle still present even though rebuild failed
    expect(result.bundlePresent).toBe(true);
  });
});

// ─── Bundle-missing fallback ─────────────────────────────────────────────────

describe("computeBundleDecision / bundle missing fallback", () => {
  test("no bundle and build failure → bundlePresent=false (caller should fall back to source)", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: false,
      stampContent: null,
    });
    const exec = makeExecDeps({ gitHead: CURRENT_HEAD, bunBuildExitCode: 1 });
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    expect(result.bundlePresent).toBe(false);
  });

  test("source install with no src present (hypothetical) → no rebuild attempted", () => {
    // This tests the published-install path: no src, only bundle present
    const fs = makeFsDeps({
      sourceExists: false,
      bundleExists: true,
      stampContent: null,
    });
    const exec = makeExecDeps({});
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    expect(result.rebuildAttempted).toBe(false);
    expect(result.bundlePresent).toBe(true);
  });
});

// ─── Git unavailable edge case ────────────────────────────────────────────────

describe("computeBundleDecision / git unavailable", () => {
  test("empty git HEAD → treats as stale → triggers rebuild", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: false,
      stampContent: CURRENT_HEAD, // has a stamp, but git returns empty
    });
    const exec = makeExecDeps({ gitHead: "" }); // git not available
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    // When head is empty, stale defaults to true → rebuild attempted
    expect(result.rebuildAttempted).toBe(true);
  });

  test("empty git HEAD and successful build → stamp NOT written (no head to write)", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: false,
      stampContent: null,
    });
    const exec = makeExecDeps({ gitHead: "", bunBuildExitCode: 0 });
    const stderr = makeStderrDeps();

    computeBundleDecision(PACKAGE_ROOT, BUNDLE_PATH, STAMP_PATH, SOURCE_PATH, fs, exec, stderr);

    // No stamp written when HEAD is empty (nothing to stamp with)
    expect(fs.writtenFiles[STAMP_PATH]).toBeUndefined();
  });
});

// ─── Stamp write failure edge case ───────────────────────────────────────────

describe("computeBundleDecision / stamp write failure", () => {
  test("stamp write fails → logs warning, but still marks rebuild as succeeded", () => {
    const fs = makeFsDeps({
      sourceExists: true,
      bundleExists: false,
      stampContent: null,
      writeFileThrows: true,
    });
    const exec = makeExecDeps({ gitHead: CURRENT_HEAD, bunBuildExitCode: 0 });
    const stderr = makeStderrDeps();

    const result = computeBundleDecision(
      PACKAGE_ROOT,
      BUNDLE_PATH,
      STAMP_PATH,
      SOURCE_PATH,
      fs,
      exec,
      stderr
    );

    expect(result.rebuildAttempted).toBe(true);
    // Stamp write failed but the build itself succeeded
    expect(result.rebuildSucceeded).toBe(true);
    expect(stderr.messages.some((m) => m.includes("could not write build stamp"))).toBe(true);
  });
});
