/**
 * Detector for missing workspace-package.json COPY lines in the root
 * `Dockerfile`.
 *
 * Closes the gate-gap exposed by mt#1977 / 2026-05-20T19:44Z: PR #1186
 * (mt#1934, marketing-site rebuild) added `services/site/` as a new
 * workspace declared by root `package.json`'s
 * `workspaces: ["packages/*", "services/*"]`. The regenerated `bun.lock`
 * referenced `services/site`'s deps. The Dockerfile's selective workspace-
 * COPY block only copied `packages/shared/package.json` and
 * `services/reviewer/package.json` — `services/site/package.json` was
 * missed. Result: every Railway deploy from `57c2e868` onward failed with
 *   `error: lockfile had changes, but lockfile is frozen`
 * Production was stuck on the prior commit for ~75 minutes.
 *
 * This detector mechanically enforces the contract: every workspace
 * matched by the glob in root `package.json`'s `workspaces` field AND
 * containing a `package.json` MUST have a corresponding
 *   `COPY <ws>/package.json ...`
 * line in the Dockerfile BEFORE the `RUN bun install --frozen-lockfile`
 * step. The pre-commit hook wraps this detector and blocks commits when
 * the invariant is violated.
 *
 * Tracking task: mt#1984. Originating incident: mt#1977.
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { readTextFileSync } from "../utils/fs";

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
 * The match is line-anchored and tolerates the standard variants
 * (`--production`, `--ignore-scripts`, additional flags). The substring
 * `RUN bun install --frozen-lockfile` is the load-bearing signal.
 */
const FROZEN_INSTALL_LINE_RE = /^RUN bun install --frozen-lockfile/m;

export interface WorkspaceCopyCheckInput {
  /**
   * Parsed root `package.json`. Only the `workspaces` field is read; the
   * rest is ignored. Both array form (`"workspaces": [...]`) and object
   * form (`"workspaces": { "packages": [...] }`) are supported.
   */
  rootPackageJson: { workspaces?: string[] | { packages?: string[] } };
  /**
   * Workspace package.json paths that actually exist on disk, resolved
   * relative to the repo root (e.g. `"packages/shared"`,
   * `"services/site"`). Directories matched by the glob but lacking a
   * `package.json` are EXCLUDED from this list by the resolver — bun's
   * workspaces glob skips them, so the COPY check must too.
   */
  workspacePackageJsons: readonly string[];
  /**
   * Raw Dockerfile text (root `Dockerfile`, not the `services/<svc>/-
   * Dockerfile` siblings — those use their own local package.jsons and
   * aren't affected by the root workspaces glob).
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
 *   step, returns `[]` (this is not the deploy Dockerfile we protect —
 *   either a sub-project Dockerfile or a different deploy strategy).
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
}

const defaultFs: FsOps = {
  existsSync,
  readdirSync: (p) => readdirSync(p),
  statSync,
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
 * Convenience: run the end-to-end check against a real repo root. Reads
 * `package.json`, expands the workspaces glob via filesystem, reads the
 * Dockerfile, and runs the detector. Returns `null` if either the
 * `package.json` or the `Dockerfile` cannot be loaded — those are
 * "this repo isn't the one we protect" signals rather than failures.
 *
 * The pre-commit hook calls this; tests call `detectMissingWorkspaceCopies`
 * directly with synthetic inputs.
 */
export function runWorkspaceCopyCheck(
  repoRoot: string,
  fs: FsOps = defaultFs
): MissingWorkspaceCopy[] | null {
  const packageJsonPath = join(repoRoot, "package.json");
  const dockerfilePath = join(repoRoot, "Dockerfile");
  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(dockerfilePath)) {
    return null;
  }
  let rootPackageJson: { workspaces?: string[] | { packages?: string[] } };
  try {
    rootPackageJson = JSON.parse(readTextFileSync(packageJsonPath)) as {
      workspaces?: string[] | { packages?: string[] };
    };
  } catch {
    return null;
  }
  const dockerfileText = readTextFileSync(dockerfilePath);
  const workspacesField = readWorkspacesField(rootPackageJson);
  const workspacePackageJsons = resolveWorkspacePackageJsonPaths(repoRoot, workspacesField, fs);
  return detectMissingWorkspaceCopies({
    rootPackageJson,
    workspacePackageJsons,
    dockerfileText,
  });
}
