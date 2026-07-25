#!/usr/bin/env bun
/**
 * Regenerate the `RUN bun build ...` invocation line in the root
 * `Dockerfile` (mt#3091) from `scripts/cli-entry.ts`'s canonical
 * `bunBuildCommand()`.
 *
 * This is the Dockerfile-generation half of mt#3091's drift fix (the
 * sibling `bun run check:bun-build-sync` covers package.json's `build`
 * script, which can't be safely auto-regenerated the same way — see that
 * script's header). Before mt#3091 this line was hand-copied from
 * package.json's `build` script and `scripts/cli-entry.ts`'s self-rebuild;
 * mt#3006 aligned the first two sites and only found this one late via a
 * reviewer sweep, and mt#3023 existed solely to fix this site.
 *
 * Auto-regeneration: `src/hooks/pre-commit.ts`'s
 * `runDockerfileBunBuildRegen` step runs this script on every commit and
 * re-stages the Dockerfile if it changed — mirrors mt#2621's workspace-COPY
 * auto-fix-and-restage pattern. Manual invocation
 * (`bun run generate:dockerfile-bun-build`) is only needed for local
 * inspection; the pre-commit hook keeps the committed Dockerfile correct
 * automatically.
 *
 * Exit codes: 0 on success (whether or not anything changed), 1 if the
 * Dockerfile is missing the generated-block markers (a one-time setup gap)
 * or can't be read.
 */

import { existsSync, writeFileSync } from "fs";
import { join } from "path";

import { readTextFileSync } from "@minsky/shared/fs";
import { applyGeneratedBunBuildBlock } from "../src/hooks/dockerfile-bun-build-detector";
import { bunBuildCommand } from "./cli-entry";

function main(): void {
  const repoRoot = join(import.meta.dir, "..");
  const dockerfilePath = join(repoRoot, "Dockerfile");

  if (!existsSync(dockerfilePath)) {
    console.error(`Could not find ${dockerfilePath}`);
    process.exit(1);
    return;
  }

  const dockerfileText = readTextFileSync(dockerfilePath);
  const command = bunBuildCommand();
  const result = applyGeneratedBunBuildBlock(dockerfileText, command);

  if ("error" in result) {
    console.error(`Dockerfile: ${result.error}`);
    process.exit(1);
    return;
  }

  if (result.changed) {
    writeFileSync(dockerfilePath, result.text, "utf-8");
    console.log("Regenerated bun-build invocation in: Dockerfile");
  } else {
    console.log("Dockerfile bun-build invocation already up-to-date.");
  }
}

main();
