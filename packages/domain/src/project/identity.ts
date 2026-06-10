/**
 * Project Identity Resolver (mt#2414 — Phase 1.1 of mt#2391)
 *
 * Single source of truth for "which project am I operating on right now."
 * Produces a stable project slug / id from the configured precedence chain.
 *
 * ## Precedence order (highest → lowest)
 * 1. Explicit CLI flag value (`--project` / `params.explicitSlug`)
 * 2. Environment variable: `MINSKY_PROJECT`
 * 3. `.minsky/config.yaml` `project.slug` field (written by `minsky init`)
 * 4. Git-remote auto-detect: `owner/repo` derived from `origin` remote URL
 *
 * ## Slug derivation
 * The default slug is `owner/repo` (e.g. `edobry/minsky`), derived from the
 * `origin` remote URL at init time and stamped into `.minsky/config.yaml`.
 * **Tradeoff:** this slug changes when the repo is forked (the fork gets a
 * different `owner/repo`). If stability across forks is required, use a
 * generated UUID instead — pass `slugDerivation: "uuid"` to
 * `deriveProjectSlug()`.  The `owner/repo` form was chosen as the v1 default
 * because it is human-readable, matches how GitHub refers to repos, and is
 * stable for the common case (single canonical upstream).
 *
 * ## MCP multi-repo case (v1 documented constraint)
 * The MCP server may serve client sessions from different repos. In v1 the
 * resolution is **per-request**, derived from the `ProjectContext.repositoryPath`
 * (the `--repo` CLI arg or the CWD of the request). There is no server-lifetime
 * "current project" — the identity is always derived fresh from the request's
 * repo path.
 *
 * Rationale: the MCP server is stateless with respect to the repository it
 * operates on; forcing a single server-lifetime project identity would break
 * multi-repo sessions. Per-request resolution is the correct v1 posture.
 *
 * The acceptance test for this is in `identity.test.ts` §"MCP multi-repo".
 *
 * @see docs/architecture/project-identity-mcp-multi-repo.md for the full note.
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { execSync as defaultExecSync } from "child_process";
import { parse as yamlParse } from "yaml";
import { log } from "@minsky/shared/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A successfully resolved project identity.
 * `slug` is a stable human-readable identifier (e.g. `owner/repo`).
 * `source` records which precedence tier produced it.
 */
export interface ResolvedProjectIdentity {
  kind: "resolved";
  slug: string;
  source: ProjectIdentitySource;
}

/**
 * Explicit "no project" sentinel returned when no identity can be derived
 * and the caller is executing a repo-orthogonal command (e.g. `minsky help`).
 */
export interface UnidentifiedProjectIdentity {
  kind: "unidentified";
  reason: string;
}

export type ProjectIdentity = ResolvedProjectIdentity | UnidentifiedProjectIdentity;

/**
 * Which tier of the precedence chain produced the resolved slug.
 */
export type ProjectIdentitySource = "explicit-flag" | "env-var" | "config-slug" | "git-remote";

/**
 * Injectable dependencies for `resolveProjectIdentity()`.
 * All production defaults are real-filesystem / real-exec.
 */
export interface ProjectIdentityDeps {
  execSync: (cmd: string, opts?: { cwd?: string; encoding?: string }) => string | Buffer;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  /**
   * Returns the value of `process.env.MINSKY_PROJECT` (or equivalent injection).
   * Separated into a dep so tests can override without touching process.env.
   */
  getEnvVar: (name: string) => string | undefined;
}

/**
 * Parameters passed to `resolveProjectIdentity()`.
 */
export interface ResolveProjectIdentityParams {
  /**
   * Repository root path. Defaults to `process.cwd()`.
   * The MCP server passes `ProjectContext.repositoryPath` here.
   */
  repoPath?: string;
  /**
   * Explicit slug override — populated from the `--project` CLI flag (or MCP
   * `project` parameter).  When present, this wins over all other sources.
   */
  explicitSlug?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment variable name (exported for registration in HOOK_ONLY_ENV_VARS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The env-var name for the project identity override.
 * Registered in `HOOK_ONLY_ENV_VARS` so the env-var-to-config dot-path parser
 * skips it at boot (mt#1788 / mt#1785 class).
 */
export const PROJECT_IDENTITY_ENV_VAR = "MINSKY_PROJECT";

// ─────────────────────────────────────────────────────────────────────────────
// Default dependencies
// ─────────────────────────────────────────────────────────────────────────────

const defaultDeps: ProjectIdentityDeps = {
  execSync: defaultExecSync as ProjectIdentityDeps["execSync"],
  existsSync,
  readFileSync: readFileSync as ProjectIdentityDeps["readFileSync"],
  getEnvVar: (name: string) => process.env[name],
};

// ─────────────────────────────────────────────────────────────────────────────
// Core resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the current project identity following the documented precedence order.
 *
 * Never throws. All error paths return an `UnidentifiedProjectIdentity` or fall
 * through to the next tier.
 *
 * Edge cases:
 * - Config slug and git remote disagree → config wins, a warning is emitted.
 * - `.minsky/config.yaml` absent → falls back to git-remote-derived id.
 * - Detached HEAD / no remote → returns `{ kind: "unidentified" }`.
 *
 * MCP multi-repo case: call this once per request, passing
 * `params.repoPath = projectContext.repositoryPath`.
 */
export function resolveProjectIdentity(
  params: ResolveProjectIdentityParams = {},
  deps: ProjectIdentityDeps = defaultDeps
): ProjectIdentity {
  const repoPath = resolve(params.repoPath ?? process.cwd());

  // ── Tier 1: explicit CLI flag ──────────────────────────────────────────────
  if (params.explicitSlug) {
    return { kind: "resolved", slug: params.explicitSlug, source: "explicit-flag" };
  }

  // ── Tier 2: environment variable ──────────────────────────────────────────
  const envSlug = deps.getEnvVar(PROJECT_IDENTITY_ENV_VAR);
  if (envSlug && envSlug.trim()) {
    return { kind: "resolved", slug: envSlug.trim(), source: "env-var" };
  }

  // ── Tier 3: .minsky/config.yaml project slug ──────────────────────────────
  const configSlug = readConfigSlug(repoPath, deps);

  if (configSlug) {
    // Cross-check with git remote — emit a warning if they disagree (config wins).
    const remoteSlug = deriveSlugFromGitRemote(repoPath, deps);
    if (remoteSlug && remoteSlug !== configSlug) {
      log.warn(
        `[project-identity] Config slug "${configSlug}" differs from git-remote-derived ` +
          `slug "${remoteSlug}". Using config slug (config wins). ` +
          `If this is intentional (e.g. after forking), update .minsky/config.yaml ` +
          `to silence this warning.`
      );
    }
    return { kind: "resolved", slug: configSlug, source: "config-slug" };
  }

  // ── Tier 4: git-remote auto-detect ────────────────────────────────────────
  const remoteSlug = deriveSlugFromGitRemote(repoPath, deps);
  if (remoteSlug) {
    return { kind: "resolved", slug: remoteSlug, source: "git-remote" };
  }

  // ── No identity available ─────────────────────────────────────────────────
  return {
    kind: "unidentified",
    reason:
      "No project slug found: no --project flag, no MINSKY_PROJECT env var, " +
      "no project.slug in .minsky/config.yaml, and no git remote origin. " +
      "Run `minsky init` to stamp a project slug, or pass --project <slug>.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slug stamping helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a project slug from the git origin remote URL.
 *
 * Returns `owner/repo` for GitHub/GitLab/Bitbucket remotes (both SSH and HTTPS
 * forms). Returns `null` for detached HEAD, no remote, or unrecognised URL.
 */
export function deriveSlugFromGitRemote(
  repoPath: string,
  deps: ProjectIdentityDeps = defaultDeps
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

// ─────────────────────────────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read `project.slug` from `.minsky/config.yaml` at the given repo root.
 * Returns `null` if the file is absent or the field is not set.
 */
export function readConfigSlug(
  repoPath: string,
  deps: ProjectIdentityDeps = defaultDeps
): string | null {
  const configPath = join(repoPath, ".minsky", "config.yaml");

  if (!deps.existsSync(configPath)) return null;

  try {
    const content = deps.readFileSync(configPath, "utf8");
    const parsed = yamlParse(content) as Record<string, unknown> | null;
    if (!parsed) return null;

    const project = parsed.project;
    if (!project || typeof project !== "object") return null;

    const slug = (project as Record<string, unknown>).slug;
    if (typeof slug === "string" && slug.trim()) return slug.trim();

    return null;
  } catch (err) {
    log.debug("[project-identity] Failed to read config slug", {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
