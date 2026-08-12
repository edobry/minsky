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
 * mt#3523 extended the pattern set from deploy CONFIG (Dockerfiles,
 * railway.json, deploy workflows) to also cover application SOURCE and
 * manifests whose merge actually triggers a service deploy — derived
 * directly from the `paths:` blocks of `.github/workflows/deploy-minsky-mcp.yml`
 * and `deploy-reviewer.yml` (the in-repo trigger authority; see
 * `DEPLOY_SURFACE_SERVICE_MAP` below). `deploy-surface-workflow-drift.test.ts`
 * re-parses those workflow files at test time and fails if this module
 * diverges from them, closing the "list was hand-widened and drifted
 * again" class mt#3023 and mt#3523 both instantiated.
 *
 * @see mt#2353 — originating hook (PreToolUse merge gate + PostToolUse reminder)
 * @see mt#2647 — this module's consumer (`session.pr.drive` postMerge mode)
 * @see mt#3023 — first hand-widening (root Dockerfile was missing)
 * @see mt#3523 — second hand-widening (application source + manifests were missing)
 */

/**
 * Deploy CONFIG-as-code patterns — Dockerfiles, Railway/deploy config, and
 * deploy workflows themselves. Unscoped to a single service (matched here,
 * not in `DEPLOY_SURFACE_SERVICE_MAP` below) are conservatively treated as
 * broad-impact by `findAffectedServices`: watch more, miss nothing.
 */
const CONFIG_SURFACE_PATTERNS: readonly RegExp[] = [
  // Pulumi / infra-as-code tree — not scoped to one service.
  /^infra\//,
  // Root Dockerfile — the `minsky-mcp` image. Railway auto-detects it at repo
  // root (see docs/deploy-minsky-railway.md §First deploy), so this file
  // defines what the deployed MCP server actually IS.
  //
  // mt#3023: this pattern was MISSING. The per-service pattern below is
  // anchored to `services/<name>/`, so a PR touching only the root Dockerfile
  // matched nothing — skipping both the pre-merge deploy-verification gate and
  // the post-merge deploy watch for the one image most likely to break a
  // deploy. Being unscoped, it is treated as broad-impact by
  // `findAffectedServices` (same posture as `infra/`), which is the
  // conservative direction: watch more, miss nothing.
  /^Dockerfile$/,
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
 * Explicit path -> service(s) mapping (mt#3523) for deploy-surface entries
 * whose trigger is SHARED across services, or narrower/broader than the
 * single-service `services/<name>/...` scoping `extractServiceFromPath` +
 * `findAffectedServices`'s broad-impact fallback can express on their own
 * (e.g. "this path deploys exactly these TWO services", not "every
 * service" or "one service, scoped by directory name").
 *
 * Each entry's `services` list is derived directly from the `on.push.paths`
 * blocks of `.github/workflows/deploy-minsky-mcp.yml` (-> `minsky-mcp`) and
 * `.github/workflows/deploy-reviewer.yml` (-> `reviewer`), read 2026-08-11/12.
 * `deploy-surface-workflow-drift.test.ts` re-parses those workflow files at
 * test time and fails if this map diverges from them — with ONE documented,
 * named exception, below.
 *
 * Root `src/**` -> minsky-mcp is INCLUDED as of mt#4013 (decided
 * 2026-08-12). The workflow has carried `"src/**"` since commit
 * `0df155fb32` (2026-06-12), and the decision is to KEEP it: the root
 * Dockerfile COPYs the whole `src` tree into the minsky-mcp image, and the
 * workflow's mt#2461 header defines the `paths:` filter as that COPY
 * closure — dropping the path would open a silent-staleness window for
 * exactly the code the deployed server runs. This subsumes
 * `src/cockpit/**`: cockpit web source is a minsky-mcp deploy surface as a
 * BUNDLED INPUT of that image, which refines (not contradicts) ask#7028's
 * cockpit-inversion decision — the COCKPIT service is still not a
 * merge-deploy target (mt#3996). The drift-test carve-out that reserved
 * this entry for mt#4013's decision is removed in the same change.
 */
export const DEPLOY_SURFACE_SERVICE_MAP: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly services: readonly string[];
}> = [
  // ---- Shared trigger paths: BOTH minsky-mcp and reviewer ----
  { pattern: /^package\.json$/, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^bun\.lock$/, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^tsconfig\.json$/, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^packages\/shared\/package\.json$/, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^packages\/shared\/tsconfig\.json$/, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^packages\/shared\/src\//, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^packages\/domain\/package\.json$/, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^packages\/domain\/tsconfig\.json$/, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^packages\/domain\/src\//, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^services\/site\/package\.json$/, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^services\/cockpit\/package\.json$/, services: ["minsky-mcp", "reviewer"] },
  { pattern: /^services\/reviewer\/package\.json$/, services: ["minsky-mcp", "reviewer"] },

  // ---- minsky-mcp only ----
  { pattern: /^\.dockerignore$/, services: ["minsky-mcp"] },
  { pattern: /^\.minsky\/config\.yaml$/, services: ["minsky-mcp"] },
  // Root src tree — bundled wholesale into the minsky-mcp image
  // (Dockerfile `COPY src ./src`); includes src/cockpit/** as a bundled
  // input. Decision record: mt#4013 (see the map doc comment above).
  { pattern: /^src\//, services: ["minsky-mcp"] },

  // ---- reviewer only ----
  // Broad: covers services/reviewer/src/**, services/reviewer/migrations/**,
  // and (redundantly with the entry above, which additionally maps
  // minsky-mcp) services/reviewer/package.json.
  { pattern: /^services\/reviewer\//, services: ["reviewer"] },
  { pattern: /^bunfig\.toml$/, services: ["reviewer"] },
];

/**
 * Anchored path patterns that constitute a deploy surface. Tested against
 * the repo-relative POSIX path (normalised: backslashes -> `/`, leading
 * `./` stripped). Combines the config-as-code patterns above with the
 * (regex-only, service-agnostic) patterns from `DEPLOY_SURFACE_SERVICE_MAP`
 * — single source of truth, so the boolean predicate and the per-service
 * mapping can never drift apart on WHICH files are deploy-surface files,
 * only on which SERVICE(S) a given file maps to.
 */
export const DEPLOY_SURFACE_PATTERNS: readonly RegExp[] = [
  ...CONFIG_SURFACE_PATTERNS,
  ...DEPLOY_SURFACE_SERVICE_MAP.map((entry) => entry.pattern),
];

/**
 * LOCAL-APP deploy surface (mt#2976): the cockpit-tray native binary source.
 *
 * Unlike the Railway `DEPLOY_SURFACE_PATTERNS` above, a change here \"deploys\" to
 * the operator's local `/Applications` via `cockpit-tray/scripts/install-local.sh`
 * — and the tray's own Rust binary is NOT auto-rebuilt (only `src/cockpit/**` is,
 * mt#2297/mt#2299), so a merged change is invisible until the app is reinstalled
 * (mt#2942). Kept SEPARATE from the Railway surface on purpose: the pre-merge gate
 * and the `session.pr.drive` deploy-watch both key off `DEPLOY_SURFACE_PATTERNS`
 * → `deployment_wait-for-latest`, which is meaningless for the tray. Only the
 * post-merge reminder branches on this set (a reinstall reminder, no pre-merge
 * block — a local reinstall is low-stakes + reversible).
 */
export const LOCAL_APP_DEPLOY_SURFACE_PATTERNS: readonly RegExp[] = [/^cockpit-tray\/src-tauri\//];

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
 * True when a repo-relative path is a LOCAL-APP (cockpit-tray binary) deploy
 * surface (mt#2976). Separate from `isDeploySurfaceFile` (Railway) so the
 * pre-merge gate + `session.pr.drive` deploy-watch never treat a tray change as
 * a Railway deploy. Same null-safety posture as `isDeploySurfaceFile` (mt#2809).
 */
export function isLocalAppDeploySurfaceFile(filename: string | null | undefined): boolean {
  const normalised = normalisePath(filename);
  if (normalised === null) return false;
  return LOCAL_APP_DEPLOY_SURFACE_PATTERNS.some((re) => re.test(normalised));
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
 * Rules, checked in order for each deploy-surface file:
 * - (mt#3523) A file matching one or more `DEPLOY_SURFACE_SERVICE_MAP`
 *   entries affects exactly the union of those entries' `services` — this
 *   takes priority because it expresses "this path deploys these specific
 *   service(s)" more precisely than the two rules below can.
 * - A deploy-surface file scoped to one service (`services/<name>/...`)
 *   NOT covered by the map above affects that service ONLY — provided it's
 *   a service that actually has a deploy config (otherwise there's nothing
 *   to watch for it).
 * - A deploy-surface file NOT scoped to one service (`infra/...`, a deploy
 *   workflow) and NOT covered by the map above is treated as affecting
 *   EVERY known service — infra and workflow changes are not service-local.
 * - Files that aren't deploy-surface files are ignored entirely.
 *
 * Every branch gates a resolved service against `availableServices` (a
 * service listed in the map but with no `deploy.config.ts` has nothing to
 * watch — silently skipped), matching the pre-existing behavior for the
 * scoped-service and broad-impact rules.
 *
 * Pure function — takes the available-services list as an argument rather
 * than reading the filesystem itself, so it stays independently testable.
 * Signature unchanged by mt#3523 — only the internal mapping grows.
 */
export function findAffectedServices(
  changedFiles: readonly string[],
  availableServices: readonly string[]
): { services: string[]; matchedFiles: string[] } {
  const matchedFiles = changedFiles.filter((f) => isDeploySurfaceFile(f));
  const affected = new Set<string>();
  let broadImpact = false;

  for (const file of matchedFiles) {
    const mapMatches = DEPLOY_SURFACE_SERVICE_MAP.filter((entry) => entry.pattern.test(file));
    if (mapMatches.length > 0) {
      for (const entry of mapMatches) {
        for (const service of entry.services) {
          if (availableServices.includes(service)) {
            affected.add(service);
          }
        }
      }
      continue;
    }

    const service = extractServiceFromPath(file);
    if (service !== undefined) {
      if (availableServices.includes(service)) {
        affected.add(service);
      }
      // A services/<name>/... deploy-surface file for a service with no
      // deploy.config.ts has nothing to watch — silently skipped.
      continue;
    }
    // Not scoped to a single service (infra/, deploy workflow) and not in
    // the explicit map -> broad impact.
    broadImpact = true;
  }

  if (broadImpact) {
    for (const service of availableServices) affected.add(service);
  }

  return { services: [...affected].sort(), matchedFiles };
}
