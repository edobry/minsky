/**
 * Tests for the shared sweeper repo-target resolution (mt#4759).
 *
 * Covers:
 *   - parseCoverageRepositories: "owner/repo" parsing, malformed-entry skip.
 *   - resolveRepoTargets: explicit-override branch (no network call),
 *     multi-repo enumeration, the selection:"all" branch, and the
 *     coverage-call-failure fail-safe fallback (never returns zero targets).
 */

import { describe, test, expect, mock } from "bun:test";
import {
  parseCoverageRepositories,
  resolveRepoTargets,
  type GetInstallationCoverageFn,
  type InstallationCoverageResult,
} from "./sweeper-repo-targets";
import { captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";

const FALLBACK: { owner: string; repo: string } = { owner: "edobry", repo: "minsky" };
const PEEZOMBIE_FULL_NAME = "edobry/peezombie.me";
const SOURCE_FALLBACK_DEFAULT = "fallback-default";

function coverageFn(result: InstallationCoverageResult): GetInstallationCoverageFn {
  return () => Promise.resolve(result);
}

function throwingCoverageFn(err: unknown): GetInstallationCoverageFn {
  return () => Promise.reject(err);
}

describe("parseCoverageRepositories", () => {
  test("parses well-formed owner/repo entries", () => {
    const result = parseCoverageRepositories(["edobry/minsky", "edobry/peezombie.me"]);
    expect(result).toEqual([
      { owner: "edobry", repo: "minsky" },
      { owner: "edobry", repo: "peezombie.me" },
    ]);
  });

  test("skips malformed entries (no slash, empty owner, empty repo)", () => {
    const result = parseCoverageRepositories(["no-slash-here", "/repo", "owner/", "edobry/minsky"]);
    expect(result).toEqual([{ owner: "edobry", repo: "minsky" }]);
  });

  test("returns empty array for empty input", () => {
    expect(parseCoverageRepositories([])).toEqual([]);
  });
});

describe("resolveRepoTargets — explicit-env-override branch", () => {
  test("returns the explicit pair verbatim and never calls getInstallationCoverage", async () => {
    const getInstallationCoverage = mock(() =>
      Promise.reject(new Error("should not be called"))
    ) as unknown as GetInstallationCoverageFn;

    const result = await resolveRepoTargets({
      explicitTarget: { owner: "someorg", repo: "somerepo" },
      fallbackTarget: FALLBACK,
      getInstallationCoverage,
      logPrefix: "sweeper",
    });

    expect(result.source).toBe("explicit-env");
    expect(result.targets).toEqual([{ owner: "someorg", repo: "somerepo" }]);
    expect(getInstallationCoverage).not.toHaveBeenCalled();
  });
});

describe("resolveRepoTargets — multi-repo enumeration", () => {
  test("resolves multiple repos from a 'selected' installation", async () => {
    const result = await resolveRepoTargets({
      explicitTarget: null,
      fallbackTarget: FALLBACK,
      getInstallationCoverage: coverageFn({
        selection: "selected",
        repositories: ["edobry/minsky", PEEZOMBIE_FULL_NAME],
      }),
      logPrefix: "sweeper",
    });

    expect(result.source).toBe("installation-coverage");
    expect(result.targets).toEqual([
      { owner: "edobry", repo: "minsky" },
      { owner: "edobry", repo: "peezombie.me" },
    ]);
  });
});

describe('resolveRepoTargets — selection: "all" branch', () => {
  test("resolves the full repository list when selection is 'all'", async () => {
    const result = await resolveRepoTargets({
      explicitTarget: null,
      fallbackTarget: FALLBACK,
      getInstallationCoverage: coverageFn({
        selection: "all",
        repositories: ["edobry/minsky", PEEZOMBIE_FULL_NAME, "edobry/other-repo"],
      }),
      logPrefix: "sweeper",
    });

    expect(result.source).toBe("installation-coverage");
    expect(result.targets).toHaveLength(3);
    expect(result.targets.map((t) => `${t.owner}/${t.repo}`)).toEqual([
      "edobry/minsky",
      PEEZOMBIE_FULL_NAME,
      "edobry/other-repo",
    ]);
  });
});

describe("resolveRepoTargets — coverage-call-failure fallback (fail-safe)", () => {
  test("falls back to the single fallback pair when the coverage call throws, and logs loudly", async () => {
    const { logs, restore } = captureConsoleLogs();
    let result;
    try {
      result = await resolveRepoTargets({
        explicitTarget: null,
        fallbackTarget: FALLBACK,
        getInstallationCoverage: throwingCoverageFn(new Error("GitHub 500")),
        logPrefix: "sweeper",
      });
    } finally {
      restore();
    }

    // FAIL SAFE: never an empty target list.
    expect(result.targets).toEqual([FALLBACK]);
    expect(result.source).toBe(SOURCE_FALLBACK_DEFAULT);
    expect(result.targets.length).toBeGreaterThan(0);

    const errorLog = findLogEvent(logs, "sweeper.repo_target_resolution_failed");
    expect(errorLog).not.toBeNull();
    expect(errorLog?.error).toContain("GitHub 500");
  });

  test("falls back when coverage resolves with zero parseable repositories", async () => {
    const { logs, restore } = captureConsoleLogs();
    let result;
    try {
      result = await resolveRepoTargets({
        explicitTarget: null,
        fallbackTarget: FALLBACK,
        getInstallationCoverage: coverageFn({ selection: "selected", repositories: [] }),
        logPrefix: "merge_state_sweeper",
      });
    } finally {
      restore();
    }

    expect(result.targets).toEqual([FALLBACK]);
    expect(result.source).toBe(SOURCE_FALLBACK_DEFAULT);
    expect(findLogEvent(logs, "merge_state_sweeper.repo_target_resolution_failed")).not.toBeNull();
  });

  test("falls back when coverage resolves with only malformed entries", async () => {
    const result = await resolveRepoTargets({
      explicitTarget: null,
      fallbackTarget: FALLBACK,
      getInstallationCoverage: coverageFn({
        selection: "selected",
        repositories: ["malformed-no-slash"],
      }),
      logPrefix: "sweeper",
    });

    expect(result.targets).toEqual([FALLBACK]);
    expect(result.source).toBe(SOURCE_FALLBACK_DEFAULT);
  });
});
