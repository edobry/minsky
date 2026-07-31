#!/usr/bin/env bun
/**
 * Verify the `bun build` invocation embedded in package.json's `build`
 * script (and, as a defense-in-depth backstop, the root Dockerfile's
 * generated `RUN` line) matches `scripts/cli-entry.ts`'s canonical
 * `bunBuildCommand()` (mt#3091).
 *
 * This is the CHECK-based half of mt#3091's drift fix. It exists because
 * package.json's `build` script is a flat JSON string, not TypeScript —
 * `scripts/cli-entry.ts`'s exported `bunBuildArgs()`/`bunBuildCommand()`
 * can't be *imported* by it the way the Dockerfile generator or
 * `scripts/cli-entry.ts` itself can consume the canonical source directly.
 * Auto-rewriting a JSON string value in place (parse, mutate, re-stringify,
 * re-stage — mirroring the Dockerfile marker-block auto-regen) was
 * considered and rejected for this site: JSON.stringify round-tripping
 * risks reordering keys or altering whitespace/formatting outside the one
 * field being changed, a risk the Dockerfile's comment-delimited-block
 * substitution doesn't carry. A blocking check with an actionable error
 * message is simpler and just as effective at satisfying mt#3091's
 * acceptance criterion ("a deliberate divergence ... is caught").
 *
 * The Dockerfile half is checked here too even though
 * `scripts/generate-dockerfile-bun-build.ts` + pre-commit already make it
 * "impossible to diverge" in the normal commit flow — this is the backstop
 * for the case where pre-commit was bypassed (`--no-verify`) or the
 * generator has a bug, so `bun run check:bun-build-sync` is a meaningful
 * standalone CI gate on its own, not just a pre-commit convenience.
 *
 * Wired into `src/hooks/pre-commit.ts`'s `runBunBuildSyncCheck` step
 * (BLOCKS the commit on mismatch, unlike the auto-fix-and-restage steps —
 * matches the "compile --check" family's block-instead-of-auto-fix shape
 * for content a generator can't safely rewrite).
 *
 * Exit codes: 0 if both sites match the canonical command, 1 on any
 * mismatch or read failure.
 */

import { join } from "path";

import { readTextFileSync } from "@minsky/shared/fs";
import {
  BUN_BUILD_BLOCK_START,
  BUN_BUILD_BLOCK_END,
} from "../src/hooks/dockerfile-bun-build-detector";
import { bunBuildCommand } from "./cli-entry";

export interface BunBuildSyncCheckResult {
  ok: boolean;
  errors: string[];
}

/**
 * Extract the `bun build ...` sub-command from a `&&`-joined script
 * pipeline (e.g. package.json's `scripts.build`), or `null` if none of the
 * `&&`-separated segments starts with `bun build `. Segments are trimmed,
 * so incidental whitespace around `&&` doesn't affect extraction. Exported
 * for unit testing.
 */
export function extractBunBuildSegment(script: string): string | null {
  const segments = script.split("&&").map((s) => s.trim());
  return segments.find((s) => s.startsWith("bun build ")) ?? null;
}

/**
 * Pure check: does `packageJsonBuildScript` (the `scripts.build` string)
 * contain a `bun build ...` segment that EXACTLY equals the canonical
 * command? Deliberately exact, not `.includes()` — a substring check would
 * pass for a segment with EXTRA flags appended after the canonical
 * invocation (e.g. `bun build --target=bun ... src/cli.ts --some-flag`),
 * silently missing that class of drift (reviewer-bot mt#3091 PR #2305 R1
 * BLOCKING). Isolating the specific `&&`-delimited segment first (via
 * {@link extractBunBuildSegment}) means formatting elsewhere in the
 * pipeline — spacing around `&&`, the other scripts it's chained with —
 * doesn't affect the comparison. Exported for unit testing.
 */
export function packageJsonBuildScriptMatches(
  packageJsonBuildScript: string,
  canonicalCommand: string
): boolean {
  return extractBunBuildSegment(packageJsonBuildScript) === canonicalCommand;
}

/**
 * Pure check: does the Dockerfile's generated bun-build block contain a
 * line that EXACTLY equals `RUN <canonicalCommand>`? Deliberately an exact
 * per-line match, not `.includes()` on the whole block — the same
 * extra-flags-appended drift class {@link packageJsonBuildScriptMatches}
 * guards against (reviewer-bot mt#3091 PR #2305 R1 BLOCKING). Exported for
 * unit testing.
 */
export function dockerfileRunLineMatches(
  dockerfileText: string,
  canonicalCommand: string
): boolean {
  const startIdx = dockerfileText.indexOf(BUN_BUILD_BLOCK_START);
  const endIdx = dockerfileText.indexOf(BUN_BUILD_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return false;
  }
  const block = dockerfileText.slice(startIdx, endIdx);
  const runLine = block.split("\n").find((line) => line.startsWith("RUN "));
  return runLine === `RUN ${canonicalCommand}`;
}

function main(): void {
  const repoRoot = join(import.meta.dir, "..");
  const canonicalCommand = bunBuildCommand();
  const errors: string[] = [];

  // package.json
  const packageJsonPath = join(repoRoot, "package.json");
  let packageJson: { scripts?: Record<string, string> };
  try {
    packageJson = JSON.parse(readTextFileSync(packageJsonPath));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Could not read/parse ${packageJsonPath}: ${msg}`);
    process.exit(1);
    return;
  }
  const buildScript = packageJson.scripts?.build ?? "";
  if (!packageJsonBuildScriptMatches(buildScript, canonicalCommand)) {
    errors.push(
      `package.json's "scripts.build" does not contain the canonical bun-build invocation.\n` +
        `  Expected to find: ${canonicalCommand}\n` +
        `  Actual "build" script: ${buildScript}\n` +
        `  Fix: update package.json's "build" script's \`bun build ...\` segment to match ` +
        `scripts/cli-entry.ts's bunBuildCommand(), or change bunBuildCommand() itself if the ` +
        `new invocation is the intended canonical one.`
    );
  }

  // Dockerfile
  const dockerfilePath = join(repoRoot, "Dockerfile");
  let dockerfileText: string;
  try {
    dockerfileText = readTextFileSync(dockerfilePath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Could not read ${dockerfilePath}: ${msg}`);
    process.exit(1);
    return;
  }
  if (!dockerfileRunLineMatches(dockerfileText, canonicalCommand)) {
    errors.push(
      `Dockerfile's generated bun-build block does not contain \`RUN ${canonicalCommand}\`.\n` +
        `  Fix: run \`bun run generate:dockerfile-bun-build\` to regenerate it, or check that ` +
        `the generated-block markers ("${BUN_BUILD_BLOCK_START}" / "${BUN_BUILD_BLOCK_END}") ` +
        `are present and unmodified.`
    );
  }

  if (errors.length > 0) {
    console.error("❌ bun-build invocation drift detected:\n");
    for (const err of errors) {
      console.error(err);
      console.error("");
    }
    process.exit(1);
    return;
  }

  console.log("✅ bun-build invocation is in sync across package.json and Dockerfile.");
}

if (import.meta.main) {
  main();
}
