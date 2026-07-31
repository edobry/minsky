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
 *
 * `stdio` (mt#2893) lets the real invocation suppress the child's stderr —
 * see `deriveSlugFromGitRemote`'s doc comment for why.
 */
export interface SlugDeps {
  execSync: (
    cmd: string,
    opts?: {
      cwd?: string;
      encoding?: string;
      stdio?: Array<"pipe" | "ignore" | "inherit">;
    }
  ) => string | Buffer;
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
 * forms). Returns `null` for detached HEAD, no remote, unrecognised URL, or a
 * git-less environment.
 *
 * ## Why `stdio: ["ignore", "pipe", "ignore"]` (mt#2893)
 *
 * When the `git` binary is absent (e.g. the reviewer service's container,
 * which ships no git binary and has no checked-out repo — see identity.ts's
 * "hosted service, no single repo cwd" case), the shell invoked by
 * `execSync` fails to exec `git` and writes its own `<shell>: git: not
 * found`-style text to the child's stderr. That text is written by the
 * shell, not by this function, so a try/catch around the JS-level exec
 * error cannot suppress it — under Bun's `execSync` (which, unlike Node's
 * default piped stdio, lets the child's stderr reach the process's real
 * stderr) it leaked into the reviewer's container boot log at error
 * severity, even though this whole path is an expected-to-fail fallback in
 * git-less environments.
 *
 * Explicitly setting `stdio: ["ignore", "pipe", "ignore"]` opens the
 * child's stderr (fd 2) to the null device instead of inheriting the
 * parent's, so the "not found" text is discarded at the OS level before it
 * can reach any log stream — while stdout stays piped so the real remote
 * URL is still captured on success. This works identically on both POSIX
 * shells and Windows `cmd.exe` (no shell-builtin dependency), unlike an
 * earlier version of this fix that pre-probed with the POSIX-only
 * `command -v git` — which would have produced a false "git unavailable"
 * negative on Windows dev machines that do have git installed, since
 * `command -v` isn't a `cmd.exe` builtin.
 */
export function deriveSlugFromGitRemote(
  repoPath: string,
  deps: SlugDeps = defaultDeps
): string | null {
  const rawUrl = deriveRemoteUrl(repoPath, deps);
  if (!rawUrl) return null;
  return extractOwnerRepo(rawUrl);
}

/**
 * Read the raw `origin` remote URL (unparsed) for the repo at `repoPath`.
 * Returns `null` for the same expected-failure cases as
 * {@link deriveSlugFromGitRemote} (no remote, not a git repo, detached HEAD,
 * git binary absent) — never throws.
 *
 * Exported (mt#2934) so callers that need the canonical `repo_url` value —
 * not just the derived `owner/repo` slug — can reuse the same git-remote
 * read instead of re-deriving it (e.g. project-row provisioning's
 * `repo_url` column, `projects-schema.ts`).
 */
export function deriveRemoteUrl(repoPath: string, deps: SlugDeps = defaultDeps): string | null {
  try {
    const rawUrl = deps
      .execSync("git remote get-url origin", {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString()
      .trim();

    return rawUrl || null;
  } catch {
    // No remote, not a git repo, detached HEAD, or git binary absent —
    // expected in some environments.
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
