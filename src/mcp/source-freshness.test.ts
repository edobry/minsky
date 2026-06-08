/**
 * Tests for the loaded-source freshness signal (mt#2335).
 *
 * Exercises the pure `getSourceFreshness` logic with injected env + git deps:
 * bundleFresh match/mismatch, unknown-commit degradation, missing-package-root
 * degradation, and runMode normalization.
 */

import { describe, expect, test } from "bun:test";

import {
  getSourceFreshness,
  LOADED_COMMIT_ENV,
  RUN_MODE_ENV,
  PACKAGE_ROOT_ENV,
  type SourceFreshnessDeps,
} from "./source-freshness";

const SHA_A = "3b837462dc28ba0b29a2b63a1372e5f8f0f7797f";
const SHA_B = "137d64025b4b42a5f46203bf9e941baa26c0a85a";

/** Build deps from a fixed env map and a fixed HEAD (null = git failure). */
function deps(env: Record<string, string | undefined>, head: string | null): SourceFreshnessDeps {
  return {
    readEnv: (name) => env[name],
    gitRevParseHead: () => head,
  };
}

describe("getSourceFreshness (mt#2335)", () => {
  test("bundleFresh=true when loadedCommit matches current HEAD", () => {
    const r = getSourceFreshness(
      deps(
        { [LOADED_COMMIT_ENV]: SHA_A, [RUN_MODE_ENV]: "bundle", [PACKAGE_ROOT_ENV]: "/repo" },
        SHA_A
      )
    );
    expect(r).toEqual({
      loadedCommit: SHA_A,
      currentHead: SHA_A,
      bundleFresh: true,
      runMode: "bundle",
    });
  });

  test("bundleFresh=false when loadedCommit lags HEAD (rebuild pending)", () => {
    const r = getSourceFreshness(
      deps(
        { [LOADED_COMMIT_ENV]: SHA_B, [RUN_MODE_ENV]: "bundle", [PACKAGE_ROOT_ENV]: "/repo" },
        SHA_A
      )
    );
    expect(r.bundleFresh).toBe(false);
    expect(r.loadedCommit).toBe(SHA_B);
    expect(r.currentHead).toBe(SHA_A);
  });

  test("source-fallback runMode is preserved", () => {
    const r = getSourceFreshness(
      deps(
        {
          [LOADED_COMMIT_ENV]: SHA_A,
          [RUN_MODE_ENV]: "source-fallback",
          [PACKAGE_ROOT_ENV]: "/repo",
        },
        SHA_A
      )
    );
    expect(r.runMode).toBe("source-fallback");
    expect(r.bundleFresh).toBe(true);
  });

  test("bundleFresh=null when loadedCommit is unknown", () => {
    const r = getSourceFreshness(
      deps({ [RUN_MODE_ENV]: "bundle", [PACKAGE_ROOT_ENV]: "/repo" }, SHA_A)
    );
    expect(r.loadedCommit).toBeNull();
    expect(r.bundleFresh).toBeNull();
    expect(r.currentHead).toBe(SHA_A);
  });

  test("currentHead=null and bundleFresh=null when package root is missing", () => {
    const r = getSourceFreshness(
      deps({ [LOADED_COMMIT_ENV]: SHA_A, [RUN_MODE_ENV]: "bundle" }, SHA_A)
    );
    expect(r.currentHead).toBeNull();
    expect(r.bundleFresh).toBeNull();
    expect(r.loadedCommit).toBe(SHA_A);
  });

  test("currentHead=null when git fails, bundleFresh=null", () => {
    const r = getSourceFreshness(
      deps(
        { [LOADED_COMMIT_ENV]: SHA_A, [RUN_MODE_ENV]: "bundle", [PACKAGE_ROOT_ENV]: "/repo" },
        null
      )
    );
    expect(r.currentHead).toBeNull();
    expect(r.bundleFresh).toBeNull();
  });

  test("unrecognized / missing runMode normalizes to 'unknown'", () => {
    expect(getSourceFreshness(deps({ [RUN_MODE_ENV]: "weird" }, null)).runMode).toBe("unknown");
    expect(getSourceFreshness(deps({}, null)).runMode).toBe("unknown");
  });

  test("blank loadedCommit string is treated as unknown", () => {
    const r = getSourceFreshness(
      deps({ [LOADED_COMMIT_ENV]: "   ", [PACKAGE_ROOT_ENV]: "/repo" }, SHA_A)
    );
    expect(r.loadedCommit).toBeNull();
    expect(r.bundleFresh).toBeNull();
  });
});
