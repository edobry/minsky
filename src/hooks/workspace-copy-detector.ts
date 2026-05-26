/**
 * Detector for missing workspace-package.json COPY lines in any Dockerfile
 * that runs `bun install --frozen-lockfile`.
 *
 * Originally scoped to the root `Dockerfile` (mt#1984 / mt#1977 fix). The
 * root-only scope was too narrow: mt#1991 (2026-05-20) demonstrated the
 * same failure class on `services/reviewer/Dockerfile`, which the original
 * detector silently passed over. That sub-project Dockerfile copies its
 * own workspace-package.json subset before `bun install --frozen-lockfile`
 * but missed `services/site/package.json` after mt#1934 added services/site
 * as a workspace. Eight consecutive reviewer Railway deploys failed over
 * ~4 hours with `error: lockfile had changes, but lockfile is frozen`.
 *
 * Tracking task mt#1992 generalized the scope: any Dockerfile in the repo
 * containing a `bun install --frozen-lockfile` step is now subject to the
 * workspace-COPY invariant. Discovery is by filesystem walk
 * (`discoverProtectedDockerfiles`) over the conventional locations (root,
 * `services/*`, `packages/*`); each protected Dockerfile is checked
 * independently and per-file violations are reported.
 *
 * The contract each protected Dockerfile must satisfy: every workspace
 * matched by the glob in root `package.json`'s `workspaces` field AND
 * containing a `package.json` MUST have a corresponding
 *   `COPY <ws>/package.json ...`
 * line BEFORE the `RUN bun install --frozen-lockfile` step. The pre-commit
 * hook aggregates violations across all protected Dockerfiles and blocks
 * the commit when any are present.
 *
 * Tracking tasks: mt#1984 (original root-Dockerfile detector),
 *   mt#1992 (generalization). Originating incidents: mt#1977 (root),
 *   mt#1991 (services/reviewer).
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { readTextFileSync } from "@minsky/shared/fs";

/**
 * Env var that, when truthy (`1`, `true`, `yes`), skips the workspace-
 * COPY check. Follows the override-with-audit pattern of
 * `MINSKY_FORCE_PARALLEL`, `MINSKY_SKIP_FRESHNESS`,
 * `MINSKY_SKIP_BUNDLE_SMOKE`, `MINSKY_SKIP_NUL_CHECK`, etc.
 *
 * Registered in `HOOK_ONLY_ENV_VARS` at
 * `src/domain/configuration/sources/environment.ts` per the mt#1788
 * ESLint-rule contract.
 */
export const WORKSPACE_COPY_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_WORKSPACE_COPY_CHECK";

/**
 * True when the given env-var value should be interpreted as enabling
 * the override. Matches the same casing rules other hook overrides use.
 */
export function isWorkspaceCopyOverrideTruthy(envValue: string | undefined): boolean {
  if (!envValue) return false;
  const v = envValue.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * The Dockerfile line that marks the boundary "everything above must
 * happen before `bun install --frozen-lockfile` runs". COPY lines below
 * this marker (in the source layer) don't satisfy the workspace-COPY
 * invariant — by then, the install has already failed.
 *
 * The match is line-anchored with leading-whitespace tolerance so an
 * indented `RUN bun install --frozen-lockfile` line (valid Dockerfile
 * syntax) doesn't silently bypass the check. The substring
 * `RUN bun install --frozen-lockfile` is the load-bearing signal; the
 * remainder of the line (additional flags like `--production`,
 * `--ignore-scripts`) is intentionally not matched.
 */
const FROZEN_INSTALL_LINE_RE = /^\s*RUN bun install --frozen-lockfile/m;

export interface WorkspaceCopyCheckInput {
  /**
   * Workspace package.json paths that actually exist on disk, resolved
   * relative to the repo root (e.g. `"packages/shared"`,
   * `"services/site"`). Directories matched by the glob but lacking a
   * `package.json` are EXCLUDED from this list by the resolver — bun's
   * workspaces glob skips them, so the COPY check must too.
   */
  workspacePackageJsons: readonly string[];
  /**
   * Raw Dockerfile text. May be the root `Dockerfile` OR a sub-project
   * Dockerfile (`services/<svc>/Dockerfile`, `packages/<pkg>/Dockerfile`)
   * — mt#1992 generalized the scope. Any Dockerfile that runs
   * `bun install --frozen-lockfile` against the root bun.lock is subject
   * to the workspace-COPY invariant; sub-project Dockerfiles inherit the
   * root lockfile's workspace topology even when they only install a
   * subset of the deps.
   */
  dockerfileText: string;
}

export interface MissingWorkspaceCopy {
  /** Repo-relative workspace path, e.g. `"services/site"`. */
  workspacePath: string;
  /** Repo-relative package.json path, e.g. `"services/site/package.json"`. */
  packageJsonRelPath: string;
  /** The exact COPY line the operator should add to the Dockerfile. */
  copyLineToAdd: string;
}

/**
 * Returns the list of workspace package.jsons that are NOT explicitly
 * COPYed before the `RUN bun install --frozen-lockfile` step.
 *
 * Special cases:
 * - If the Dockerfile contains no `RUN bun install --frozen-lockfile`
 *   step, returns `[]` (the workspace-COPY invariant only applies when
 *   the frozen-lockfile install is the load-bearing step). The caller's
 *   discovery layer (`discoverProtectedDockerfiles`) filters by the same
 *   trigger condition, so in practice this check is a defense-in-depth
 *   double-gate; legitimately-passed callers don't hit this path.
 * - Workspaces matched by the glob but lacking a `package.json` are
 *   already excluded by the caller (per `WorkspaceCopyCheckInput`
 *   contract), so this function does not re-check disk state.
 *
 * Pure function — takes pre-loaded inputs so the unit-test suite can
 * construct synthetic Dockerfile bodies without touching the filesystem.
 */
export function detectMissingWorkspaceCopies(
  input: WorkspaceCopyCheckInput
): MissingWorkspaceCopy[] {
  if (!FROZEN_INSTALL_LINE_RE.test(input.dockerfileText)) {
    return [];
  }

  // Split into pre-install / post-install. COPYs below the install line
  // don't satisfy the contract.
  const installMatch = input.dockerfileText.match(FROZEN_INSTALL_LINE_RE);
  if (!installMatch || installMatch.index === undefined) {
    return [];
  }
  const preInstallSection = input.dockerfileText.slice(0, installMatch.index);

  const missing: MissingWorkspaceCopy[] = [];
  for (const workspacePath of input.workspacePackageJsons) {
    const packageJsonRelPath = `${workspacePath}/package.json`;
    // The COPY may target either an absolute `/app/...` path or a
    // relative `./...` path; we only require that the SOURCE side
    // (`<ws>/package.json`) appear in a COPY line in the pre-install
    // section. Loose match on the rest.
    const copyPattern = new RegExp(`^\\s*COPY\\s+${escapeRegex(packageJsonRelPath)}\\s+`, "m");
    if (!copyPattern.test(preInstallSection)) {
      missing.push({
        workspacePath,
        packageJsonRelPath,
        copyLineToAdd: `COPY ${packageJsonRelPath} ./${packageJsonRelPath}`,
      });
    }
  }
  return missing;
}

/**
 * Extract the workspaces glob array from a parsed root `package.json`.
 * Returns `[]` for the absent / malformed / non-workspace cases.
 *
 * Both shapes are recognised:
 *   - Array form:   `"workspaces": ["packages/*"]`
 *   - Object form:  `"workspaces": { "packages": ["packages/*"] }` (yarn legacy)
 */
export function readWorkspacesField(
  rootPackageJson: { workspaces?: string[] | { packages?: string[] } } | undefined
): string[] {
  if (!rootPackageJson?.workspaces) return [];
  if (Array.isArray(rootPackageJson.workspaces)) {
    return rootPackageJson.workspaces;
  }
  if (
    typeof rootPackageJson.workspaces === "object" &&
    Array.isArray(rootPackageJson.workspaces.packages)
  ) {
    return rootPackageJson.workspaces.packages;
  }
  return [];
}

/**
 * Expand a workspace-glob entry against the filesystem, returning the
 * repo-relative directory paths that match AND contain a `package.json`.
 *
 * Supported glob forms (matches bun's documented workspace-glob support):
 *   - Literal path: `packages/shared`
 *   - Single-`*` directory glob: `packages/*`, `services/*`
 *
 * Patterns with `**`, negations, or character classes are not currently
 * used in Minsky's `workspaces` field; if they appear we fail closed (the
 * check returns nothing, the workspace-COPY invariant is enforced only
 * for the patterns we understand). A follow-up task would extend this
 * if needed.
 *
 * The optional `fs` injection point exists for unit-testing without
 * touching the real filesystem.
 */
export interface FsOps {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean };
  /**
   * Read a UTF-8 file's contents. Added (mt#1992) so the end-to-end check
   * can be tested against synthetic in-memory filesystems without falling
   * back to real temp directories (which the `custom/no-real-fs-in-tests`
   * ESLint rule forbids). Default impl delegates to the existing
   * `readTextFileSync` helper.
   */
  readTextFileSync(path: string): string;
}

const defaultFs: FsOps = {
  existsSync,
  readdirSync: (p) => readdirSync(p),
  statSync,
  readTextFileSync,
};

export function resolveWorkspacePackageJsonPaths(
  repoRoot: string,
  globs: readonly string[],
  fs: FsOps = defaultFs
): string[] {
  const out: string[] = [];
  for (const glob of globs) {
    if (glob.includes("**") || glob.includes("!") || glob.includes("[")) {
      // Unsupported pattern — skip. The check is conservative (we'd
      // rather under-flag than mis-flag); a future iteration can extend
      // this expander.
      continue;
    }
    const starIdx = glob.indexOf("*");
    if (starIdx === -1) {
      // Literal workspace path.
      if (hasPackageJson(repoRoot, glob, fs)) out.push(glob);
      continue;
    }
    // Single-`*` pattern (e.g. `packages/*`). The `*` must be the LAST
    // path component for us to handle it; otherwise treat as unsupported.
    const beforeStar = glob.slice(0, starIdx);
    const afterStar = glob.slice(starIdx + 1);
    if (afterStar.length > 0 || !beforeStar.endsWith("/")) {
      continue;
    }
    const parentDir = beforeStar.replace(/\/$/, "");
    const absParent = join(repoRoot, parentDir);
    if (!fs.existsSync(absParent)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(absParent);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = `${parentDir}/${entry}`;
      const absCandidate = join(repoRoot, candidate);
      try {
        if (!fs.statSync(absCandidate).isDirectory()) continue;
      } catch {
        continue;
      }
      if (hasPackageJson(repoRoot, candidate, fs)) out.push(candidate);
    }
  }
  // Stable order for deterministic test output.
  return out.sort();
}

function hasPackageJson(repoRoot: string, workspacePath: string, fs: FsOps): boolean {
  return fs.existsSync(join(repoRoot, workspacePath, "package.json"));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Discover all Dockerfiles in the repo that should be subject to the
 * workspace-COPY invariant. A Dockerfile is "protected" iff it contains
 * a `RUN bun install --frozen-lockfile` step (the bun frozen-lockfile
 * install is the load-bearing signal — that's the only command that
 * actually fails when a workspace manifest is missing from the build
 * context).
 *
 * Search locations (mt#1992):
 *   - `<repoRoot>/Dockerfile` (root)
 *   - `<repoRoot>/services/<svc>/Dockerfile`
 *   - `<repoRoot>/packages/<pkg>/Dockerfile`
 *
 * Dockerfile.* variants (`Dockerfile.prod`, `Dockerfile.dev`) are NOT
 * scanned today; if Minsky adopts that pattern later this function should
 * be extended. The conservative default (only the canonical filename)
 * avoids false positives on dev-only Dockerfiles that intentionally
 * differ from prod.
 *
 * Returns repo-relative paths in stable sort order.
 */
export function discoverProtectedDockerfiles(repoRoot: string, fs: FsOps = defaultFs): string[] {
  const out: string[] = [];

  const candidatePaths: string[] = [];

  // Root Dockerfile.
  candidatePaths.push("Dockerfile");

  // services/<svc>/Dockerfile and packages/<pkg>/Dockerfile.
  for (const parentDir of ["services", "packages"]) {
    const absParent = join(repoRoot, parentDir);
    if (!fs.existsSync(absParent)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(absParent);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absChild = join(repoRoot, parentDir, entry);
      try {
        if (!fs.statSync(absChild).isDirectory()) continue;
      } catch {
        continue;
      }
      candidatePaths.push(`${parentDir}/${entry}/Dockerfile`);
    }
  }

  for (const relPath of candidatePaths) {
    const absPath = join(repoRoot, relPath);
    if (!fs.existsSync(absPath)) continue;
    let text: string;
    try {
      text = fs.readTextFileSync(absPath);
    } catch {
      continue;
    }
    if (FROZEN_INSTALL_LINE_RE.test(text)) {
      out.push(relPath);
    }
  }

  return out.sort();
}

/**
 * Per-Dockerfile aggregation of missing-COPY violations. Each entry in
 * the returned array represents one Dockerfile that was scanned; entries
 * with empty `missing` arrays mean that file passed the check.
 *
 * The pre-commit hook flattens these into a single user-facing report
 * grouped by Dockerfile path, so the operator knows which file(s) to fix.
 */
export interface DockerfileCheckResult {
  /** Repo-relative Dockerfile path, e.g. `"Dockerfile"`, `"services/reviewer/Dockerfile"`. */
  dockerfileRelPath: string;
  /** Workspace COPYs missing from this specific Dockerfile. Empty = pass. */
  missing: MissingWorkspaceCopy[];
}

/**
 * Convenience: run the end-to-end check across all protected Dockerfiles
 * in the repo. Reads root `package.json`, expands the workspaces glob via
 * filesystem, discovers protected Dockerfiles, and runs the detector
 * against each.
 *
 * Returns:
 *   - `null` if `package.json` is missing or malformed — "this repo isn't
 *     the one we protect" signal rather than a failure.
 *   - `DockerfileCheckResult[]` otherwise. The array contains one entry
 *     per protected Dockerfile; entries with `missing.length === 0`
 *     represent passing files. Empty top-level array means "no protected
 *     Dockerfiles found" (e.g., a repo with no `bun install
 *     --frozen-lockfile` anywhere).
 *
 * The pre-commit hook calls this; tests call `detectMissingWorkspaceCopies`
 * and `discoverProtectedDockerfiles` directly with synthetic inputs.
 */
export function runWorkspaceCopyCheck(
  repoRoot: string,
  fs: FsOps = defaultFs
): DockerfileCheckResult[] | null {
  const packageJsonPath = join(repoRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  let rootPackageJson: { workspaces?: string[] | { packages?: string[] } };
  try {
    rootPackageJson = JSON.parse(fs.readTextFileSync(packageJsonPath)) as {
      workspaces?: string[] | { packages?: string[] };
    };
  } catch {
    return null;
  }

  const workspacesField = readWorkspacesField(rootPackageJson);
  const workspacePackageJsons = resolveWorkspacePackageJsonPaths(repoRoot, workspacesField, fs);
  const protectedDockerfiles = discoverProtectedDockerfiles(repoRoot, fs);

  const results: DockerfileCheckResult[] = [];
  for (const dockerfileRelPath of protectedDockerfiles) {
    const dockerfileText = fs.readTextFileSync(join(repoRoot, dockerfileRelPath));
    const missing = detectMissingWorkspaceCopies({
      workspacePackageJsons,
      dockerfileText,
    });
    results.push({ dockerfileRelPath, missing });
  }
  return results;
}
