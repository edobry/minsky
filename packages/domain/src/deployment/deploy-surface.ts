/**
 * Deploy-surface detection (mt#2647).
 *
 * Canonical, dependency-free predicate for "does this changed-file path
 * alter WHAT gets deployed or HOW" — a change that can make the post-merge
 * deploy fail (Dockerfile breakage, config-as-code resolution error, crash
 * on start) in a way no pre-merge check catches.
 *
 * This module is the single source of truth for the pattern list. It was
 * ported from `.claude/hooks/deploy-surface-detector.ts` (mt#2353) — that
 * hook file now re-exports `DEPLOY_SURFACE_PATTERNS` / `isDeploySurfaceFile`
 * from here instead of declaring its own copy, so the merge-gate hook and
 * the `session.pr.drive` post-merge deploy-watch mode (mt#2647) can never
 * drift apart on what counts as a deploy surface.
 *
 * @see mt#2353 — originating hook (PreToolUse merge gate + PostToolUse reminder)
 * @see mt#2647 — this module's consumer (`session.pr.drive` postMerge mode)
 */

/**
 * Anchored path patterns that constitute a deploy surface. Tested against
 * the repo-relative POSIX path (normalised: backslashes -> `/`, leading
 * `./` stripped).
 */
export const DEPLOY_SURFACE_PATTERNS: readonly RegExp[] = [
  // Pulumi / infra-as-code tree — not scoped to one service.
  /^infra\//,
  // Per-service deploy + build config.
  /^services\/[^/]+\/Dockerfile$/,
  /^services\/[^/]+\/railway\.json$/,
  /^services\/[^/]+\/deploy\.config\.ts$/,
  /^services\/[^/]+\/railway\.config\.ts$/,
  // Deploy workflows — config-as-code that drives the deploy itself. Matches
  // both `deploy.yml` (single-pipeline repos) and `deploy-<svc>.yml`.
  /^\.github\/workflows\/deploy(?:-[^/]+)?\.ya?ml$/,
];

/** Normalise a path for matching: backslashes -> `/`, strip a leading `./`. */
function normalisePath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True when a single repo-relative path is a deploy surface. */
export function isDeploySurfaceFile(filename: string): boolean {
  const normalised = normalisePath(filename);
  return DEPLOY_SURFACE_PATTERNS.some((re) => re.test(normalised));
}

/**
 * Extract the service name from a `services/<name>/...` path, or
 * `undefined` when the path isn't scoped to a single service (e.g.
 * `infra/index.ts` or a deploy workflow file — those can affect ANY
 * service, not just one).
 */
export function extractServiceFromPath(filename: string): string | undefined {
  const match = normalisePath(filename).match(/^services\/([^/]+)\//);
  return match?.[1];
}

/**
 * Given a PR's changed-file paths and the set of services that actually
 * declare a `deploy.config.ts` (via
 * `listServicesWithDeployConfig` in `./service-resolver`), determine which
 * services are "affected" by this PR's deploy-surface changes.
 *
 * Rules:
 * - A deploy-surface file scoped to one service (`services/<name>/...`)
 *   affects that service ONLY — provided it's a service that actually has
 *   a deploy config (otherwise there's nothing to watch for it).
 * - A deploy-surface file NOT scoped to one service (`infra/...`, a deploy
 *   workflow) is treated as affecting EVERY known service — infra and
 *   workflow changes are not service-local.
 * - Files that aren't deploy-surface files are ignored entirely.
 *
 * Pure function — takes the available-services list as an argument rather
 * than reading the filesystem itself, so it stays independently testable.
 */
export function findAffectedServices(
  changedFiles: readonly string[],
  availableServices: readonly string[]
): { services: string[]; matchedFiles: string[] } {
  const matchedFiles = changedFiles.filter((f) => isDeploySurfaceFile(f));
  const affected = new Set<string>();
  let broadImpact = false;

  for (const file of matchedFiles) {
    const service = extractServiceFromPath(file);
    if (service !== undefined) {
      if (availableServices.includes(service)) {
        affected.add(service);
      }
      // A services/<name>/... deploy-surface file for a service with no
      // deploy.config.ts has nothing to watch — silently skipped.
      continue;
    }
    // Not scoped to a single service (infra/, deploy workflow) -> broad impact.
    broadImpact = true;
  }

  if (broadImpact) {
    for (const service of availableServices) affected.add(service);
  }

  return { services: [...affected].sort(), matchedFiles };
}
