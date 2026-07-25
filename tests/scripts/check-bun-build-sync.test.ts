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
});
