#!/usr/bin/env bun
/**
 * Changed-file -> related-test-file mapping layer (mt#2932).
 *
 * `bun test` has no native "related tests" mode (unlike `jest
 * --findRelatedTests` / `vitest related`), so this script builds one: given a
 * list of changed/staged files, it returns the set of `*.test.ts` files that
 * are "related" to them via two heuristics, combined:
 *
 *   1. Sibling test — `src/foo/bar.ts` changed => `src/foo/bar.test.ts` (if it
 *      exists) is related. A changed `*.test.ts` file is trivially related to
 *      itself.
 *   2. Reverse-dependency-graph walk — build an import graph over the same
 *      file scope `scripts/run-tests-main.ts` uses (ROOTS, minus
 *      EXCLUDE_DIR_PREFIXES — notably src/mcp, whose tests must run in
 *      per-file isolation per mt#2665; see scripts/run-related-tests.ts for
 *      how a directly-changed src/mcp sibling test is still handled safely),
 *      then breadth-first-walk the REVERSE edges (importers, not imports)
 *      from each changed file up to `maxDepth` hops. Any `*.test.ts` file
 *      reached this way — because it imports the changed file directly, or
 *      imports something that (transitively) does — is related too.
 *
 * This is intentionally a *best-effort, regex-based* import scanner, not a
 * full TS/AST resolver: it is meant to be fast (a pre-commit-time budget),
 * not exhaustive. Under-inclusion (a related test the graph walk misses) is
 * an accepted risk because the mt#2716 full-suite gate (.husky/pre-push + CI)
 * remains the authoritative backstop; over-inclusion (a false-positive edge)
 * only costs a little extra local runtime, not correctness.
 *
 * Depth is bounded (default 6) and the caller (scripts/run-related-tests.ts)
 * additionally caps the total related-test count -- a widely-imported
 * low-level utility (e.g. a shared logger) can otherwise pull in a large
 * fraction of the suite, defeating the "fast" purpose of this gate.
 *
 * All filesystem access is routed through the injectable `FsLike` interface
 * (default: real `node:fs`) so tests can pass an in-memory mock filesystem
 * (`createMockFilesystem`) instead of touching disk -- see
 * eslint-rules/no-real-fs-in-tests.js, which forbids real fs use in test
 * files/hooks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOTS, shouldExclude } from "./run-tests-main";

const TS_EXT_RE = /\.tsx?$/;
const TEST_SUFFIX_RE = /\.test\.tsx?$/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

/** Minimal fs surface this module needs -- injectable for tests. */
export interface FsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string): string | Buffer;
  readdirSync(path: string): string[];
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean };
}

/** Real `node:fs`-backed default -- production behavior. */
export const realFs: FsLike = { existsSync, readFileSync, readdirSync, statSync };

/** Normalize a path to posix separators (mirrors run-tests-main.ts). */
function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** True only for an existing regular FILE -- existsSync alone also matches directories. */
function isExistingFile(fs: FsLike, p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Read a file as a utf-8 string. Uses TextDecoder rather than
 * `Buffer.toString("utf8")` -- this project's Buffer stub doesn't accept an
 * encoding argument (same constraint documented on src/hooks/pre-commit.ts's
 * gitShowStagedBytes call sites).
 */
function readTextFile(fs: FsLike, p: string): string {
  const data = fs.readFileSync(p);
  return typeof data === "string" ? data : utf8Decoder.decode(data);
}

/**
 * Extract import/require specifiers from TS source text. Regex-based (not an
 * AST parse) -- see module doc comment for why that tradeoff is acceptable
 * here. Matches:
 *   - `import ... from "x"` / `export ... from "x"`
 *   - `require("x")`
 *   - dynamic `import("x")`
 */
export function extractImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const spec = match[1];
      if (spec) specifiers.add(spec);
    }
  }
  return [...specifiers];
}

export interface PackageExportsInfo {
  name: string;
  /** Repo-relative directory containing this package's package.json. */
  root: string;
  exports: Record<string, unknown>;
}

/**
 * Load the `exports` map for every `@minsky/*` workspace package that
 * declares one, so bare-specifier imports (e.g. `@minsky/domain/errors`,
 * `@minsky/shared/logger`) can be resolved to real files -- the same
 * resolution the bundler-mode TS moduleResolution does at compile time.
 */
export function loadPackageExportsMaps(
  repoRoot: string,
  fs: FsLike = realFs
): Map<string, PackageExportsInfo> {
  const map = new Map<string, PackageExportsInfo>();
  const candidateDirs = ["packages/domain", "packages/shared"];
  for (const dir of candidateDirs) {
    const pkgJsonPath = join(repoRoot, dir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(readTextFile(fs, pkgJsonPath)) as {
        name?: string;
        exports?: Record<string, unknown>;
      };
      if (pkg.name && pkg.exports) {
        map.set(pkg.name, { name: pkg.name, root: dir, exports: pkg.exports });
      }
    } catch {
      // Malformed package.json -- skip; this only reduces recall for that
      // package's bare specifiers, it does not affect correctness elsewhere.
    }
  }
  return map;
}

/**
 * Resolve a bare `@minsky/<pkg>[/<sub>]` specifier to a repo-relative file
 * path via the package's `exports` map, including a single `"./*":
 * "./src/*.ts"`-style wildcard fallback (used by @minsky/domain today).
 */
export function resolvePackageSpecifier(
  specifier: string,
  pkgExportsMap: Map<string, PackageExportsInfo>
): string | null {
  for (const info of pkgExportsMap.values()) {
    if (specifier === info.name) {
      const target = info.exports["."];
      return typeof target === "string" ? toPosix(join(info.root, target)) : null;
    }
    if (!specifier.startsWith(`${info.name}/`)) continue;
    const sub = specifier.slice(info.name.length + 1);
    const key = `./${sub}`;
    const exact = info.exports[key];
    if (typeof exact === "string") {
      return toPosix(join(info.root, exact));
    }
    for (const [patternKey, patternVal] of Object.entries(info.exports)) {
      if (typeof patternVal !== "string") continue;
      const starIdx = patternKey.indexOf("*");
      if (starIdx === -1) continue;
      const prefix = patternKey.slice(0, starIdx);
      const suffix = patternKey.slice(starIdx + 1);
      if (
        key.startsWith(prefix) &&
        key.endsWith(suffix) &&
        key.length >= prefix.length + suffix.length
      ) {
        const captured = key.slice(prefix.length, key.length - suffix.length);
        const resolvedRel = patternVal.replace("*", captured);
        return toPosix(join(info.root, resolvedRel));
      }
    }
  }
  return null;
}

/**
 * Resolve a relative (`./x`, `../x`) specifier from `fromFileRel` (a
 * repo-relative posix path) to an existing repo-relative file, trying the
 * same extension/index candidates the bundler moduleResolution would.
 */
export function resolveRelativeSpecifier(
  fromFileRel: string,
  specifier: string,
  repoRoot: string,
  fs: FsLike = realFs
): string | null {
  const fromDir = dirname(fromFileRel);
  const base = toPosix(join(fromDir, specifier));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  for (const c of candidates) {
    if (isExistingFile(fs, join(repoRoot, c))) return c;
  }
  return null;
}

/** Resolve any specifier (relative or `@minsky/*`); null for anything else (external deps, node builtins). */
export function resolveSpecifier(
  fromFileRel: string,
  specifier: string,
  repoRoot: string,
  pkgExportsMap: Map<string, PackageExportsInfo>,
  fs: FsLike = realFs
): string | null {
  if (specifier.startsWith(".")) {
    return resolveRelativeSpecifier(fromFileRel, specifier, repoRoot, fs);
  }
  if (specifier.startsWith("@minsky/")) {
    return resolvePackageSpecifier(specifier, pkgExportsMap);
  }
  return null;
}

/** Collect every `.ts`/`.tsx` file under ROOTS, excluding EXCLUDE_DIR_PREFIXES (mirrors run-tests-main.ts's walk, but for ALL source files, not just *.test.ts). */
export function collectAllProjectFiles(repoRoot: string, fs: FsLike = realFs): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(join(repoRoot, dir));
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = toPosix(join(dir, entry));
      if (shouldExclude(relPath)) continue;
      const full = join(repoRoot, relPath);
      let info: { isFile(): boolean; isDirectory(): boolean };
      try {
        info = fs.statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(relPath);
      } else if (TS_EXT_RE.test(entry)) {
        out.push(relPath);
      }
    }
  };
  for (const root of ROOTS) {
    walk(toPosix(root.replace(/^\.\//, "")));
  }
  return out;
}

/**
 * Build a reverse-dependency graph: resolvedTargetFile -> Set of files that
 * import it (directly). Built once per invocation over `files`.
 */
export function buildReverseDependencyGraph(
  files: string[],
  repoRoot: string,
  pkgExportsMap: Map<string, PackageExportsInfo>,
  fs: FsLike = realFs
): Map<string, Set<string>> {
  const revGraph = new Map<string, Set<string>>();
  for (const file of files) {
    let content: string;
    try {
      content = readTextFile(fs, join(repoRoot, file));
    } catch {
      continue;
    }
    for (const specifier of extractImportSpecifiers(content)) {
      const resolved = resolveSpecifier(file, specifier, repoRoot, pkgExportsMap, fs);
      if (!resolved) continue;
      let importers = revGraph.get(resolved);
      if (!importers) {
        importers = new Set<string>();
        revGraph.set(resolved, importers);
      }
      importers.add(file);
    }
  }
  return revGraph;
}

export interface FindRelatedTestsOptions {
  /** Max BFS hops over the reverse-dependency graph. Default 6. */
  maxDepth?: number;
  /** Injectable filesystem -- defaults to real node:fs. */
  fs?: FsLike;
}

/**
 * Given a list of changed/staged repo-relative file paths, return the sorted,
 * deduped list of repo-relative `*.test.ts`/`*.test.tsx` files related to
 * them (sibling test + bounded reverse-dependency-graph walk).
 */
export function findRelatedTestFiles(
  changedFiles: string[],
  repoRoot: string,
  opts: FindRelatedTestsOptions = {}
): string[] {
  const maxDepth = opts.maxDepth ?? 6;
  const fs = opts.fs ?? realFs;

  const normalizedChanged = changedFiles
    .map(toPosix)
    .filter((f) => TS_EXT_RE.test(f))
    .filter((f) => fs.existsSync(join(repoRoot, f)));

  if (normalizedChanged.length === 0) return [];

  const related = new Set<string>();

  // 1. Self / sibling-test heuristic -- no graph required. Applies even to
  //    files under an EXCLUDE_DIR_PREFIXES-excluded dir (e.g. src/mcp) since
  //    it operates directly on the changed-file path, not the graph scope.
  for (const file of normalizedChanged) {
    if (TEST_SUFFIX_RE.test(file)) {
      related.add(file);
      continue;
    }
    const base = file.replace(TS_EXT_RE, "");
    for (const ext of [".test.ts", ".test.tsx"]) {
      const sibling = `${base}${ext}`;
      if (fs.existsSync(join(repoRoot, sibling))) related.add(sibling);
    }
  }

  // 2. Bounded reverse-dependency-graph walk, scoped to the same
  //    ROOTS/EXCLUDE_DIR_PREFIXES as scripts/run-tests-main.ts.
  const graphSeeds = normalizedChanged.filter((f) => !shouldExclude(f));
  if (graphSeeds.length > 0) {
    const allFiles = collectAllProjectFiles(repoRoot, fs);
    const pkgExportsMap = loadPackageExportsMaps(repoRoot, fs);
    const revGraph = buildReverseDependencyGraph(allFiles, repoRoot, pkgExportsMap, fs);

    const visited = new Set<string>(graphSeeds);
    let frontier = [...graphSeeds];
    let depth = 0;
    while (frontier.length > 0 && depth < maxDepth) {
      const next: string[] = [];
      for (const f of frontier) {
        const importers = revGraph.get(f);
        if (!importers) continue;
        for (const importer of importers) {
          if (visited.has(importer)) continue;
          visited.add(importer);
          if (TEST_SUFFIX_RE.test(importer)) related.add(importer);
          next.push(importer);
        }
      }
      frontier = next;
      depth++;
    }
  }

  return [...related].sort();
}

if (import.meta.main) {
  // CLI entry: `bun scripts/find-related-tests.ts <file1> <file2> ...`.
  // With no args, reads staged files from `git diff --cached`. Prints one
  // related test path per line (empty output = nothing related).
  const argv = process.argv.slice(2);
  let changed: string[];
  if (argv.length > 0) {
    changed = argv;
  } else {
    const proc = Bun.spawnSync(["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    changed = new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
  }
  const related = findRelatedTestFiles(changed, process.cwd());
  for (const r of related) {
    console.log(r);
  }
}
