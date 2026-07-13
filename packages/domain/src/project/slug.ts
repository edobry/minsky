/**
 * Pure git-remote → project slug helpers (leaf module, no config/init imports).
 *
 * This module is intentionally dependency-free with respect to `configuration/`,
 * `init/`, and `identity.ts`.  Keeping it a leaf breaks the potential cycle:
 *
 *   init/config-content → identity → configuration → (init/config)
 *
 * Instead both `identity.ts` and `init/config-content.ts` import from here,
 * and there is no path back.
 *
 * Public surface:
 *   - `extractOwnerRepo(remoteUrl)`      — parse SSH/HTTPS URL → "owner/repo"
 *   - `deriveSlugFromGitRemote(repoPath, deps)` — run git + parse → "owner/repo"
 *   - `SlugDeps`                         — minimal injectable deps for the above
 */

import { execSync as defaultExecSync } from "child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (minimal subset — only what these pure helpers need)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal injectable dependencies for the git-remote slug helpers.
 * A subset of `ProjectIdentityDeps` — callers that already have the full
 * `ProjectIdentityDeps` object can pass it here directly (structural sub-typing).
 */
export interface SlugDeps {
  execSync: (cmd: string, opts?: { cwd?: string; encoding?: string }) => string | Buffer;
}

const defaultDeps: SlugDeps = {
  execSync: defaultExecSync as SlugDeps["execSync"],
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a project slug from the git origin remote URL.
 *
 * Returns `owner/repo` for GitHub/GitLab/Bitbucket remotes (both SSH and HTTPS
 * forms). Returns `null` for detached HEAD, no remote, or unrecognised URL.
 */
export function deriveSlugFromGitRemote(
  repoPath: string,
  deps: SlugDeps = defaultDeps
): string | null {
  try {
    const rawUrl = deps
      .execSync("git remote get-url origin", { cwd: repoPath, encoding: "utf8" })
      .toString()
      .trim();

    if (!rawUrl) return null;

    return extractOwnerRepo(rawUrl);
  } catch {
    // No remote, not a git repo, or detached HEAD — expected in some environments
    return null;
  }
}

/**
 * Extract `owner/repo` from a remote URL.
 *
 * Handles:
 * - SSH:   `git@github.com:owner/repo.git`
 * - HTTPS: `https://github.com/owner/repo.git`
 * - Both GitHub, GitLab, Bitbucket, and generic hosts
 *
 * Returns `null` if the URL is unrecognised.
 */
export function extractOwnerRepo(remoteUrl: string): string | null {
  // SSH: git@<host>:<owner>/<repo>[.git]
  const sshMatch = remoteUrl.match(/^git@[^:]+:([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  // HTTPS: https://<host>/<owner>/<repo>[.git]
  const httpsMatch = remoteUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/\s]+?)(?:\.git)?(?:\/)?$/);
  if (httpsMatch && httpsMatch[1] && httpsMatch[2]) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  return null;
}
