/**
 * Read-scope census (mt#5155): the executable form of the spec's inventory.
 *
 * The defect this task closed was eight read sites each resolving project scope
 * by passing the process cwd straight to `resolveProjectIdentity` as `repoPath`
 * — correct for a per-conversation stdio daemon, wrong for the shared one
 * (ADR-038), where the cwd is the spawner's for every caller. All eight now go through
 * `resolveReadScope`, which honours the caller's explicit argument first. This
 * census is what keeps a NINTH from appearing: it walks the served trees for
 * the cwd-resolving pattern and expects to find it nowhere.
 *
 * Scope is `src/` and `packages/` — the surfaces the daemon serves. `scripts/`
 * is deliberately out: a one-shot script's process IS its caller, so its cwd is
 * the right answer there, exactly as it is for the CLI.
 *
 * Same shape as `src/cockpit/scope-census.ts` (mt#4730): the fs work lives in
 * this module so the sibling `.test.ts` only asserts.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/domain/src/project` → repo root. */
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");

/** The trees the daemon serves tool calls from. */
export const CENSUS_ROOTS = ["src", "packages"] as const;

/**
 * The pattern every pre-mt#5155 site carried. Whitespace-tolerant so a
 * reformatted copy does not slip past; the literal `process.cwd()` is what
 * makes it the defect rather than a legitimate explicit-path resolution
 * (`resolveProjectIdentity({ repoPath: location })` in `new-task-project.ts`
 * is exactly right and must NOT match).
 */
export const CWD_SCOPE_PATTERN =
  /resolveProjectIdentity\(\s*\{\s*repoPath:\s*process\.cwd\(\)\s*,?\s*\}\s*\)/;

/**
 * Files permitted to carry the pattern, each with a reason. Empty on purpose:
 * even the helper resolves `process.cwd()` into a variable first (its cwd rung
 * is ADR-021's ambient default, injectable for tests and for mt#5168). An entry
 * here is a recorded exception, not a convenience.
 */
export const CENSUS_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [];

/** Skipped by basename anywhere: dependency and build output, task-state dirs. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".minsky"]);
/** Skipped by repo-relative path: the one generated tree, not any dir named so. */
const SKIP_PATHS = new Set(["src/generated"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (SKIP_PATHS.has(relative(REPO_ROOT, full).split("\\").join("/"))) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

/** This module: it holds the pattern's source and must not count itself. */
const SELF = "packages/domain/src/project/read-scope-census.ts";

/** Every non-test `.ts` file under the census roots, repo-relative, POSIX-separated. */
export function listCensusFiles(): string[] {
  const files: string[] = [];
  for (const root of CENSUS_ROOTS) walk(join(REPO_ROOT, root), files);
  return files
    .map((f) => relative(REPO_ROOT, f).split("\\").join("/"))
    .filter((f) => f !== SELF)
    .sort();
}

/** The census files whose source resolves a scope from `process.cwd()`. */
export function findCwdScopeSites(files: string[] = listCensusFiles()): string[] {
  return files.filter((file) =>
    CWD_SCOPE_PATTERN.test(String(readFileSync(join(REPO_ROOT, file), "utf-8")))
  );
}
