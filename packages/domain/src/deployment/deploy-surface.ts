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

/**
 * Normalise a path for matching: backslashes -> `/`, strip a leading `./`.
 *
 * Accepts `null`/`undefined` defensively (mt#2809 — trust-boundary guard).
 * `filename` values reaching this module ultimately come from a
 * `JSON.parse`'d `gh` CLI response; the TypeScript `string` type on the
 * originating `PrFile.filename`/`previous_filename` fields is NOT
 * runtime-enforced. Root cause of the mt#2809 crash: `pr-context.ts`'s
 * `fetchPrFiles` jq projection (`previous_filename: .previous_filename`)
 * evaluates that field on EVERY file entry regardless of status — and jq
 * returns `null` (not "field omitted") when the key is absent from the
 * source object, which it is for every non-renamed file. So the JSON that
 * round-trips through `JSON.parse` carries `previous_filename: null` (a
 * real `null`, not `undefined`) on ~every file in ~every PR. A caller that
 * only guards `!== undefined` treats `null` as "present" and forwards it
 * here, where `null.replace(...)` used to throw unconditionally.
 *
 * Returns `null` (rather than throwing) for any non-string input, so a
 * single malformed entry degrades to "unclassifiable" instead of crashing
 * the whole merge gate.
 */
function normalisePath(filename: string | null | undefined): string | null {
  if (typeof filename !== "string") return null;
  return filename.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * True when a single repo-relative path is a deploy surface.
 *
 * Decision (mt#2809): a null/undefined/non-string `filename` is treated as
 * NOT a deploy surface (`false`) rather than throwing — the safer failure
 * mode for a merge gate. This can only cause a false negative (a genuine
 * deploy-surface change silently unflagged) if GitHub ever omits the
 * `filename` field on a file's OWN entry, which it does not — GitHub's
 * PR-files API always includes `filename`; the null case observed in
 * production is exclusively on `previous_filename` for non-renamed entries
 * (see `normalisePath` above), which callers may pass through this same
 * function (e.g. `isDeploySurfaceFile(f.previous_filename)`).
 */
export function isDeploySurfaceFile(filename: string | null | undefined): boolean {
  const normalised = normalisePath(filename);
  if (normalised === null) return false;
  return DEPLOY_SURFACE_PATTERNS.some((re) => re.test(normalised));
}

/**
 * Extract the service name from a `services/<name>/...` path, or
 * `undefined` when the path isn't scoped to a single service (e.g.
 * `infra/index.ts` or a deploy workflow file — those can affect ANY
 * service, not just one) OR when `filename` is null/undefined (mt#2809 —
 * same defensive guard as `isDeploySurfaceFile`).
 */
export function extractServiceFromPath(filename: string | null | undefined): string | undefined {
  const normalised = normalisePath(filename);
  if (normalised === null) return undefined;
  const match = normalised.match(/^services\/([^/]+)\//);
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
