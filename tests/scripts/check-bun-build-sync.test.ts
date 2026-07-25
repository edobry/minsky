/**
 * mt#3091 — unit tests for the pure predicates behind
 * `scripts/check-bun-build-sync.ts`: does package.json's `scripts.build` (or
 * the Dockerfile's generated block) contain the canonical bun-build
 * invocation?
 */

import { describe, test, expect } from "bun:test";
import {
  packageJsonBuildScriptMatches,
  dockerfileRunLineMatches,
  extractBunBuildSegment,
} from "../../scripts/check-bun-build-sync";
import {
  BUN_BUILD_BLOCK_START,
  BUN_BUILD_BLOCK_END,
} from "../../src/hooks/dockerfile-bun-build-detector";

const CANONICAL =
  "bun build --target=bun --outdir=dist --entry-naming minsky.js --sourcemap=external --minify src/cli.ts";

describe("packageJsonBuildScriptMatches", () => {
  test("true when the build script contains the canonical invocation verbatim", () => {
    const buildScript = `bun run build:completion-manifest && ${CANONICAL} && bun run build:copy-migrations`;
    expect(packageJsonBuildScriptMatches(buildScript, CANONICAL)).toBe(true);
  });

  test("false when a flag is missing", () => {
    const drifted = CANONICAL.replace(" --minify", "");
    const buildScript = `bun run build:completion-manifest && ${drifted} && bun run build:copy-migrations`;
    expect(packageJsonBuildScriptMatches(buildScript, CANONICAL)).toBe(false);
  });

  test("false on an empty build script", () => {
    expect(packageJsonBuildScriptMatches("", CANONICAL)).toBe(false);
  });

  // Reviewer-bot mt#3091 PR #2305 R1 BLOCKING: a substring `.includes()`
  // check would report "in sync" even though an EXTRA flag was appended
  // after the canonical invocation — the actual build behavior diverged.
  test("false when an extra flag is appended after the canonical invocation", () => {
    const drifted = `${CANONICAL} --define FOO=1`;
    const buildScript = `bun run build:completion-manifest && ${drifted} && bun run build:copy-migrations`;
    expect(packageJsonBuildScriptMatches(buildScript, CANONICAL)).toBe(false);
  });

  test("true regardless of incidental whitespace around && separators", () => {
    const buildScript = `bun run build:completion-manifest &&   ${CANONICAL}   && bun run build:copy-migrations`;
    expect(packageJsonBuildScriptMatches(buildScript, CANONICAL)).toBe(true);
  });
});

describe("extractBunBuildSegment", () => {
  test("extracts the bun-build segment from a && pipeline", () => {
    const script = `bun run a && ${CANONICAL} && bun run b`;
    expect(extractBunBuildSegment(script)).toBe(CANONICAL);
  });

  test("returns null when no segment starts with 'bun build '", () => {
    expect(extractBunBuildSegment("bun run a && bun run b")).toBeNull();
  });
});

describe("dockerfileRunLineMatches", () => {
  function dockerfileWithBlock(runLine: string): string {
    return [
      "FROM oven/bun:1.2-slim AS base",
      BUN_BUILD_BLOCK_START,
      runLine,
      BUN_BUILD_BLOCK_END,
      "CMD bun run dist/minsky.js",
    ].join("\n");
  }

  test("true when the generated block's RUN line matches canonical", () => {
    expect(dockerfileRunLineMatches(dockerfileWithBlock(`RUN ${CANONICAL}`), CANONICAL)).toBe(true);
  });

  test("false when the RUN line inside the block has drifted", () => {
    const drifted = CANONICAL.replace(" --minify", "");
    expect(dockerfileRunLineMatches(dockerfileWithBlock(`RUN ${drifted}`), CANONICAL)).toBe(false);
  });

  test("false when the marker block is entirely absent", () => {
    const text = ["FROM oven/bun:1.2-slim AS base", `RUN ${CANONICAL}`].join("\n");
    expect(dockerfileRunLineMatches(text, CANONICAL)).toBe(false);
  });

  // Reviewer-bot mt#3091 PR #2305 R1 BLOCKING: same extra-flag drift class
  // as packageJsonBuildScriptMatches above, for the Dockerfile side.
  test("false when an extra flag is appended on the RUN line", () => {
    const drifted = `RUN ${CANONICAL} --define FOO=1`;
    expect(dockerfileRunLineMatches(dockerfileWithBlock(drifted), CANONICAL)).toBe(false);
  });
});
