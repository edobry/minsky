#!/usr/bin/env bun
// Pure detector (mt#2353): does a PR's changed-file set touch a "deploy surface" —
// a file whose change alters WHAT gets deployed or HOW, such that the post-merge
// deploy can fail (Dockerfile breakage, config-as-code resolution error, crash on
// start) in a way no pre-merge check catches?
//
// Consumed by:
//   - require-deploy-verification-before-merge.ts (PreToolUse merge gate)
//   - deploy-verification-after-merge.ts          (PostToolUse post-merge reminder)
//
// The surface list is the mt#2353 spec's enumerated minimum plus deploy workflows.
// Kept as an exported constant so the trigger set lives in ONE place.
//
// @see mt#2353 — this task (close the mt#1459 execution-evidence coverage hole for
//   deploy/infra PRs that add no test files)
// @see mt#2345 — originating incident: infra/index.ts + services/reviewer/railway.json
//   were merged + applied while the reviewer service crash-looped; reported DONE on
//   `pulumi up` exit-0 (the action) rather than a verified-healthy deploy (the outcome).

import type { PrFile } from "./require-execution-evidence-before-merge";

/**
 * Anchored path patterns that constitute a deploy surface. A change to any
 * matching file can alter the deployed artifact or its build/run config, so the
 * post-merge deploy must be verified to SUCCESS (and the runtime started) before
 * the task is considered done.
 *
 * Tested against the repo-relative POSIX path (normalised: backslashes → `/`,
 * leading `./` stripped).
 */
export const DEPLOY_SURFACE_PATTERNS: readonly RegExp[] = [
  // Pulumi / infra-as-code tree (mt#2345 touched infra/index.ts here)
  /^infra\//,
  // Per-service deploy + build config
  /^services\/[^/]+\/Dockerfile$/,
  /^services\/[^/]+\/railway\.json$/,
  /^services\/[^/]+\/deploy\.config\.ts$/,
  /^services\/[^/]+\/railway\.config\.ts$/,
  // Deploy workflows — config-as-code that drives the deploy itself
  /^\.github\/workflows\/deploy-[^/]+\.ya?ml$/,
];

/** Normalise a path for matching: backslashes → `/`, strip a leading `./`. */
function normalisePath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True when a single repo-relative path is a deploy surface. */
export function isDeploySurfaceFile(filename: string): boolean {
  const normalised = normalisePath(filename);
  return DEPLOY_SURFACE_PATTERNS.some((re) => re.test(normalised));
}

/**
 * Filter a PR's changed files to the deploy-surface ones (by new path, OR by the
 * pre-rename path so a rename AWAY from a deploy surface — e.g. `Dockerfile` →
 * `Dockerfile.bak` — still counts as a deploy change). ALL statuses are
 * considered, including `removed`: deleting a deploy-config file is a
 * deploy-impacting change too.
 */
export function findDeploySurfaceFiles(files: PrFile[]): string[] {
  return files
    .filter(
      (f) =>
        isDeploySurfaceFile(f.filename) ||
        (f.previous_filename !== undefined && isDeploySurfaceFile(f.previous_filename))
    )
    .map((f) => f.filename);
}
