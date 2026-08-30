/**
 * Shared repo-target resolution for the reviewer's two background sweepers
 * (mt#4759).
 *
 * ## The problem this closes
 *
 * `sweeper.ts` (missed-review) and `merge-state-sweeper.ts` (post-merge state
 * sync) each resolved a single `{ owner, repo }` pair from
 * `SWEEPER_REPO_OWNER` / `SWEEPER_REPO_NAME`, defaulting to `edobry`/`minsky`.
 * Neither could hold a SET, so once a second repo (`edobry/peezombie.me`) was
 * added to the `minsky-reviewer` App installation (mt#4753), the webhook path
 * covered it but neither sweeper ever would — a dropped webhook there was a
 * permanent, silent no-review.
 *
 * ## The chosen source (Planning Audit, mt#4759 spec)
 *
 * The repo set comes from the reviewer App's OWN installation coverage —
 * `GitHubAppTokenProvider.getInstallationCoverage()`
 * (`packages/domain/src/auth/github-app-token-provider.ts`) — reached via
 * `createReviewerTokenProvider()` (`./github-token-provider.ts`), which
 * already builds a `GitHubAppTokenProvider` from the reviewer App's own
 * credentials. This is authoritative for what the sweeper's token can
 * actually reach and auto-follows installation changes with zero config
 * drift — the exact failure class that produced mt#4753.
 *
 * `packages/domain/src/setup/app-coverage.ts` (mt#4680) is the existing
 * consumer of this method; its `unknown`-vs-`not-covered` distinction (a
 * failed check must never render as "nothing to sweep") is mirrored here by
 * the fail-safe fallback below.
 *
 * ## FAIL SAFE (the load-bearing correctness property)
 *
 * If the coverage call fails, or resolves to zero parseable repositories, the
 * caller must NOT silently sweep zero repos — that would recreate, through a
 * NEW mechanism, exactly the silent no-review failure this task exists to
 * remove. `resolveRepoTargets` therefore falls back to the single legacy
 * default pair (`edobry`/`minsky`, or the configured explicit pair) and logs
 * the failure loudly with the actual error via the reviewer's structured
 * logger — never swallowed into an empty result.
 *
 * ## Explicit override (backward compatibility, SC4)
 *
 * When either `SWEEPER_REPO_OWNER` or `SWEEPER_REPO_NAME` is explicitly set,
 * that single pair is used verbatim — no network call is made at all. This
 * preserves the exact pre-mt#4759 behavior for any deployment that has
 * configured these vars (including every existing hermetic test in
 * `sweeper.test.ts` / `merge-state-sweeper.test.ts`, which set
 * `ownerDefaulted: false, repoDefaulted: false` on their fixtures).
 */

import { GitHubAppTokenProvider } from "@minsky/domain/auth";
import {
  createReviewerTokenProvider,
  type ReviewerGitHubCredentials,
} from "./github-token-provider";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One GitHub repo the sweeper should target. */
export interface RepoTarget {
  readonly owner: string;
  readonly repo: string;
}

/** Where a resolved repo-target set came from — surfaced for logging/telemetry. */
export type RepoTargetSource = "explicit-env" | "installation-coverage" | "fallback-default";

export interface RepoTargetResolution {
  readonly targets: readonly RepoTarget[];
  readonly source: RepoTargetSource;
}

/**
 * The subset of `GitHubAppTokenProvider.getInstallationCoverage()`'s return
 * shape this module depends on. Kept narrow (rather than importing
 * `InstallationCoverage` from the domain package, which is not re-exported
 * from its barrel) so the injectable test seam below can supply a plain
 * object without reaching into `packages/domain`'s internal module path.
 */
export interface InstallationCoverageResult {
  readonly selection: "all" | "selected";
  readonly repositories: readonly string[];
}

/** Injectable coverage-fetch function — the test seam for both sweepers. */
export type GetInstallationCoverageFn = () => Promise<InstallationCoverageResult>;

// ---------------------------------------------------------------------------
// Real coverage-fetch (production path)
// ---------------------------------------------------------------------------

/**
 * Build the real, network-backed `GetInstallationCoverageFn` for the
 * reviewer App, using its own credentials via `createReviewerTokenProvider`.
 *
 * `createReviewerTokenProvider` returns a `TokenProvider`-typed value whose
 * concrete runtime class is always `GitHubAppTokenProvider` (see
 * `./github-token-provider.ts`) — the `instanceof` check below is a safety
 * net for that implementation detail, not an expected runtime branch. No
 * role is passed to `getInstallationCoverage()`: the provider returned by
 * `createReviewerTokenProvider` is constructed with the reviewer App's
 * credentials in its (default) "implementer" client slot, since it has no
 * separate `reviewerConfig` of its own — so the default role IS the
 * reviewer App here.
 */
export function defaultGetInstallationCoverage(
  credentials: ReviewerGitHubCredentials
): GetInstallationCoverageFn {
  return async () => {
    const provider = createReviewerTokenProvider(credentials);
    if (!(provider instanceof GitHubAppTokenProvider)) {
      throw new Error(
        "createReviewerTokenProvider did not return a GitHubAppTokenProvider instance " +
          "— cannot call getInstallationCoverage()."
      );
    }
    return provider.getInstallationCoverage();
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse `"owner/repo"` full-name strings (as returned by
 * `getInstallationCoverage()`, already lowercased) into `RepoTarget` pairs.
 * Malformed entries (no `/`, or an empty owner/repo half) are skipped rather
 * than thrown on — a single bad entry from GitHub should not abort the whole
 * resolution when other entries are usable.
 */
export function parseCoverageRepositories(fullNames: readonly string[]): RepoTarget[] {
  const targets: RepoTarget[] = [];
  for (const fullName of fullNames) {
    const idx = fullName.indexOf("/");
    if (idx <= 0 || idx === fullName.length - 1) continue;
    targets.push({ owner: fullName.slice(0, idx), repo: fullName.slice(idx + 1) });
  }
  return targets;
}

/**
 * Parse a git remote URL (`session.repoUrl`, e.g.
 * `https://github.com/edobry/peezombie.me` or
 * `git@github.com:edobry/peezombie.me.git`) into a `RepoTarget`.
 *
 * Used by `merge-state-sweeper.ts` (mt#4759 R1) to derive EACH `PR_OPEN`
 * session's OWN repo, rather than checking every session against a single
 * caller-supplied pair — the fix for a coordinator-caught defect where a
 * session from one repo was checked against another repo's PR of the same
 * number, and a false MATCH (not a 404) silently corrupted session state.
 *
 * Deliberately reimplemented here rather than importing
 * `packages/domain/src/uri-utils.ts`'s `parseGitHubOwnerRepo`: that module
 * has no package-export path (`@minsky/domain` exposes `./session`, `./auth`,
 * etc., but not `./uri-utils`), and adding one is outside this task's scope
 * (`packages/domain/package.json` is not among the files this task touches).
 * The parsing itself is intentionally narrow — only the two forms GitHub
 * itself emits for `git remote get-url origin` — and returns `null` (never
 * throws) for anything else, matching this module's fail-closed-to-null,
 * never-throw parsing style.
 */
export function parseGitHubRemoteUrl(remoteUrl: string | undefined): RepoTarget | null {
  if (!remoteUrl) return null;

  // SSH: git@github.com:owner/repo[.git]
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/?#]+?)(?:\.git)?$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS: https://github.com/owner/repo[.git]
  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?$/);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveRepoTargetsOptions {
  /**
   * The explicit-override pair, non-null when either `SWEEPER_REPO_OWNER` or
   * `SWEEPER_REPO_NAME` was set. When present, this is returned verbatim as
   * the sole target and `getInstallationCoverage` is never called.
   */
  readonly explicitTarget: RepoTarget | null;
  /**
   * The legacy hardcoded pair, used as the FAIL-SAFE fallback when
   * `explicitTarget` is null AND the coverage call fails or returns nothing.
   */
  readonly fallbackTarget: RepoTarget;
  /** Injectable coverage-fetch — production callers pass `defaultGetInstallationCoverage(...)`. */
  readonly getInstallationCoverage: GetInstallationCoverageFn;
  /**
   * Event-name prefix for structured logs (`"sweeper"` or
   * `"merge_state_sweeper"`) so each sweeper's resolution logs stay
   * distinguishable in the shared reviewer log stream.
   */
  readonly logPrefix: string;
}

/**
 * Resolve the set of `{ owner, repo }` targets a sweep cycle should cover.
 *
 * Never throws and never returns an empty target list — see the module
 * docblock's "FAIL SAFE" section. Exactly one of three things happens:
 *
 * 1. An explicit `SWEEPER_REPO_OWNER`/`SWEEPER_REPO_NAME` override is
 *    present → that single pair, no network call.
 * 2. No override, and the installation-coverage call succeeds with at least
 *    one parseable repository → the full resolved set.
 * 3. No override, and the coverage call throws OR returns zero parseable
 *    repositories → the single legacy fallback pair, with a loud structured
 *    error log naming the actual failure.
 */
export async function resolveRepoTargets(
  options: ResolveRepoTargetsOptions
): Promise<RepoTargetResolution> {
  if (options.explicitTarget !== null) {
    return { targets: [options.explicitTarget], source: "explicit-env" };
  }

  try {
    const coverage = await options.getInstallationCoverage();
    const targets = parseCoverageRepositories(coverage.repositories);

    if (targets.length === 0) {
      throw new Error(
        `installation coverage returned zero parseable repositories ` +
          `(selection=${coverage.selection}, rawCount=${coverage.repositories.length})`
      );
    }

    log.info(`${options.logPrefix}.repo_targets_resolved`, {
      event: `${options.logPrefix}.repo_targets_resolved`,
      source: "installation-coverage",
      selection: coverage.selection,
      targets: targets.map((t) => `${t.owner}/${t.repo}`),
    });

    return { targets, source: "installation-coverage" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback = `${options.fallbackTarget.owner}/${options.fallbackTarget.repo}`;
    log.error(`${options.logPrefix}.repo_target_resolution_failed`, {
      event: `${options.logPrefix}.repo_target_resolution_failed`,
      error: message,
      fallbackTarget: fallback,
      message:
        "Failed to resolve the reviewer App installation's repo coverage; falling back to the " +
        `single default target ${fallback}. Any OTHER repo covered by the installation will NOT ` +
        "be swept until this resolves — this is a degraded, single-repo mode, not a healthy state.",
    });
    return { targets: [options.fallbackTarget], source: "fallback-default" };
  }
}
