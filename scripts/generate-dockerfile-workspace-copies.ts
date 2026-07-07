#!/usr/bin/env bun
/**
 * Regenerate the workspace package.json COPY block in every protected
 * Dockerfile (mt#2621) from root `package.json`'s `workspaces` glob.
 *
 * A "protected" Dockerfile is one that runs `RUN bun install
 * --frozen-lockfile` against the root `bun.lock` — currently the root
 * `Dockerfile` and `services/reviewer/Dockerfile`. Each protected Dockerfile
 * must COPY every workspace's `package.json` into the build context BEFORE
 * the frozen-lockfile install step, or bun aborts with
 * `error: lockfile had changes, but lockfile is frozen` (mt#1977, mt#1991).
 *
 * Before mt#2621 this list was hand-maintained and caused two production
 * outages when it silently fell out of sync with the `workspaces` glob.
 * This script eliminates the drift class by generating the COPY lines from
 * the same glob bun itself resolves (`readWorkspacesField` +
 * `resolveWorkspacePackageJsonPaths` in `src/hooks/workspace-copy-detector.ts`,
 * shared with bun's own workspace resolution semantics) and writing them
 * into a marker-delimited block in each protected Dockerfile.
 *
 * Auto-regeneration: `src/hooks/pre-commit.ts`'s
 * `runDockerfileWorkspaceCopyRegen` step runs this script on every commit
 * and re-stages any Dockerfile it changed — mirrors mt#2622's
 * completion-manifest auto-fix-and-restage pattern. Manual invocation
 * (`bun run generate:dockerfile-workspace-copies`) is only needed for local
 * inspection; the pre-commit hook keeps the committed Dockerfiles correct
 * automatically.
 *
 * Exit codes: 0 on success (whether or not anything changed, including the
 * no-`workspaces`-field no-op), 1 if any protected Dockerfile is missing the
 * generated-block markers (a one-time setup gap — see
 * `applyGeneratedWorkspaceCopyBlock`'s error message for the fix) or if root
 * `package.json` can't be read at all.
 */

import { writeFileSync } from "fs";
import { join } from "path";

import { readTextFileSync } from "@minsky/shared/fs";
import { planDockerfileWorkspaceCopyRegeneration } from "../src/hooks/workspace-copy-detector";

function main(): void {
  const repoRoot = join(import.meta.dir, "..");
  const packageJsonPath = join(repoRoot, "package.json");

  // Fail loudly and specifically on the "can't even read package.json"
  // case rather than letting planDockerfileWorkspaceCopyRegeneration's
  // silent `null` return look like "nothing to do."
  try {
    readTextFileSync(packageJsonPath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Could not read ${packageJsonPath}: ${msg}`);
    process.exit(1);
    return;
  }

  const plans = planDockerfileWorkspaceCopyRegeneration(repoRoot);
  if (plans === null) {
    // Class-by-trigger posture (PR #1801 review): a repo without a
    // `workspaces` field has no workspace-COPY contract to generate — that is
    // a silent no-op, not an error, matching the rule docs' short-circuit
    // behavior for non-workspace repos. (An unreadable package.json is still
    // a hard failure, handled above.)
    console.log(`No \`workspaces\` field in ${packageJsonPath} — nothing to generate.`);
    return;
  }

  if (plans.length === 0) {
    console.log(
      "No protected Dockerfiles found (no `RUN bun install --frozen-lockfile` step anywhere)."
    );
    return;
  }

  const changedFiles: string[] = [];
  let hadError = false;

  for (const plan of plans) {
    if ("error" in plan.result) {
      console.error(`${plan.dockerfileRelPath}: ${plan.result.error}`);
      hadError = true;
      continue;
    }
    if (plan.result.changed) {
      writeFileSync(join(repoRoot, plan.dockerfileRelPath), plan.result.text, "utf-8");
      changedFiles.push(plan.dockerfileRelPath);
    }
  }

  if (hadError) {
    process.exit(1);
    return;
  }

  if (changedFiles.length > 0) {
    console.log(`Regenerated workspace-COPY block in: ${changedFiles.join(", ")}`);
  } else {
    console.log(
      `Workspace-COPY blocks already up-to-date (${plans.length} Dockerfile(s) checked).`
    );
  }
}

main();
