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
 *   2. Reverse-dependency-graph walk — build an import graph over the
 *      SELECTOR's file scope: `GRAPH_ROOTS`, minus EXCLUDE_DIR_PREFIXES
 *      (notably src/mcp, whose tests must run in per-file isolation per
 *      mt#2665; see scripts/run-related-tests.ts for how a directly-changed
 *      src/mcp sibling test is still handled safely). `GRAPH_ROOTS` is
 *      `scripts/run-tests-main.ts`'s `ROOTS` plus the selector-only roots it
 *      does NOT execute — `./.minsky/hooks` today (mt#4521). The two scopes
 *      were identical until then; see that constant's doc comment for why
 *      they had to diverge,
 *      then breadth-first-walk the REVERSE edges (importers, not imports)
 *      from each changed file up to `maxDepth` hops. Any `*.test.ts` file
 *      reached this way — because it imports the changed file directly, or
 *      imports something that (transitively) does — is related too.
 *
 * This is intentionally a *best-effort, regex-based* import scanner, not a
 * full TS/AST resolver: it is meant to be fast (a pre-commit-time budget),
 * not exhaustive. Under-inclusion (a related test the graph walk misses) is
 * an accepted risk because the mt#2716 full-suite gate (.husky/pre-push + CI)
 * remains the authoritative backstop.
 *
 * Over-inclusion was previously described here as costing "only a little extra
 * local runtime, not correctness." That was FALSE and mt#3765 corrected it: a
 * bloated related set overruns the gate's wall-clock budget, and a gate that
 * cannot finish blocks the commit outright. Over-inclusion costs passability,
 * which is why `DEFAULT_MAX_DEPTH` is deliberately tight — see its doc comment
 * for the measurements.
 *
 * Depth is bounded by `DEFAULT_MAX_DEPTH` (3 since mt#3765 lowered it from 6).
 * The caller (scripts/run-related-tests.ts) bounds the run by WALL-CLOCK budget,
 * not by a related-test COUNT — mt#3765 removed the former count cap because it
 * skipped tests silently while a slow-but-small set still blew the budget. A
 * widely-imported low-level utility (e.g. a shared logger) can otherwise pull in
 * a large fraction of the suite, defeating the "fast" purpose of this gate.
 *
 * All filesystem access is routed through the injectable `FsLike` interface
 * (default: real `node:fs`) so tests can pass an in-memory mock filesystem
 * (`createMockFilesystem`) instead of touching disk -- see
 * eslint-rules/no-real-fs-in-tests.js, which forbids real fs use in test
 * files/hooks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { GRAPH_ROOTS, shouldExclude } from "./run-tests-main";

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
 * Expand a single `package.json` `workspaces` glob entry to concrete
 * repo-relative directories. Only supports this repo's actual glob shape
 * (`"<dir>/*"`, e.g. `"packages/*"`) plus a literal (non-glob) directory --
 * that is the full vocabulary `package.json`'s `workspaces` array uses here.
 */
function expandWorkspaceGlob(fs: FsLike, repoRoot: string, pattern: string): string[] {
  if (!pattern.endsWith("/*")) {
    return [pattern];
  }
  const baseDir = pattern.slice(0, -2);
  let entries: string[];
  try {
    entries = fs.readdirSync(join(repoRoot, baseDir));
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    const rel = `${baseDir}/${entry}`;
    try {
      if (fs.statSync(join(repoRoot, rel)).isDirectory()) dirs.push(rel);
    } catch {
      // Race/ENOENT between readdir and stat -- skip, not fatal.
    }
  }
  return dirs;
}

/**
 * Discover every workspace package directory declared in the root
 * `package.json`'s `workspaces` array (dynamic -- a new `@minsky/*` package
 * is picked up automatically, no hardcoded directory list to keep in sync).
 */
export function discoverWorkspacePackageDirs(repoRoot: string, fs: FsLike = realFs): string[] {
  const rootPkgPath = join(repoRoot, "package.json");
  if (!fs.existsSync(rootPkgPath)) return [];
  let workspaces: string[];
  try {
    const rootPkg = JSON.parse(readTextFile(fs, rootPkgPath)) as { workspaces?: string[] };
    workspaces = rootPkg.workspaces ?? [];
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const pattern of workspaces) {
    dirs.push(...expandWorkspaceGlob(fs, repoRoot, pattern));
  }
  return dirs;
}

/**
 * Load the `exports` map for every workspace package that declares one
 * (discovered via the root `package.json`'s `workspaces` glob -- see
 * `discoverWorkspacePackageDirs`), so bare-specifier imports (e.g.
 * `@minsky/domain/errors`, `@minsky/shared/logger`) can be resolved to real
 * files -- the same resolution the bundler-mode TS moduleResolution does at
 * compile time.
 */
export function loadPackageExportsMaps(
  repoRoot: string,
  fs: FsLike = realFs
): Map<string, PackageExportsInfo> {
  const map = new Map<string, PackageExportsInfo>();
  for (const dir of discoverWorkspacePackageDirs(repoRoot, fs)) {
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

/**
 * Collect every `.ts`/`.tsx` file under the GRAPH scope, excluding
 * EXCLUDE_DIR_PREFIXES (mirrors run-tests-main.ts's walk, but for ALL source files,
 * not just *.test.ts).
 *
 * Defaults to `GRAPH_ROOTS`, not `ROOTS` (mt#4521): what this selector must SEE is a
 * different question from what the pre-push runner must EXECUTE, and `.minsky/hooks`
 * is the case where the answers differ. `roots` is injectable for the same reason
 * `discoverTestFiles(roots = ROOTS)` is — so a caller (or a measurement harness) can
 * compare scopes without a second process, where cold-vs-warm cache would confound
 * the comparison.
 */
export function collectAllProjectFiles(
  repoRoot: string,
  fs: FsLike = realFs,
  roots: readonly string[] = GRAPH_ROOTS
): string[] {
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
  for (const root of roots) {
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

/**
 * A repo-relative path written as a string literal — the DATA-READ edge (mt#4224).
 *
 * The import graph above can only see a test that IMPORTS its subject. A test that
 * reaches its subject with `readFileSync` has no import edge, so editing that subject
 * selects nothing. Since markdown cannot be imported, that made every
 * markdown-sourced skill and every `.minsky/rules/*.mdc` invisible to this selector —
 * and those are exactly the files whose tests are append-only manifests and drift
 * guards, where a silent omission is most likely.
 *
 * Requires a `/` and a dotted extension, so a bare word or a lone identifier is not a
 * candidate. The literal is only turned into an edge if it resolves to a file that
 * actually EXISTS (see {@link buildDataReadGraph}) — that existence check, not the
 * pattern, is what bounds this: a fragment, a glob, or a URL matches nothing on disk
 * and produces no edge.
 */
const PATH_LITERAL_RE = /["'`]([^"'`\n]*\/[^"'`\n]*\.[A-Za-z0-9]+)["'`]/g;

/** Repo-relative path literals appearing anywhere in `content`, deduped, in order. */
export function extractPathLiterals(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(PATH_LITERAL_RE)) {
    const raw = m[1];
    if (raw === undefined) continue;
    const normalized = toPosix(raw).replace(/^\.\//, "");
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Normalize a path literal to a repo-relative path, or `null` if it does not name one.
 *
 * This is a POSITIVE validation, and the distinction is load-bearing (PR #3079 R1,
 * BLOCKING). The first version rejected negatively — `candidate.startsWith("..")` —
 * against a candidate that had NOT been normalized, so a traversal embedded mid-path
 * slipped through: `"a/../../b.md"` does not start with `..`, and
 * `join(repoRoot, "a/../../b.md")` normalizes to `/b.md`, one level ABOVE the repo. The
 * reviewer was right, and the failure is invisible by inspection precisely because the
 * guard looks like it covers the case its own example covers.
 *
 * Normalizing FIRST collapses every traversal to a leading `..`, so one check then
 * covers the whole class rather than the spelling in front of it. Rejected:
 *
 *   - anything that escapes the repo after normalization (`../x.md`)
 *   - absolute paths (`/etc/x.md`) — `join` would confine them under `repoRoot`, which
 *     silently turns an absolute literal into a bogus in-repo probe
 *   - URL-ish literals (`https://host/x.png`) — R1 non-blocking; they could never match
 *     a changed path, so probing for them is pure noise
 */
export function toRepoRelative(rawPath: string): string | null {
  if (rawPath === "" || rawPath.includes("://")) return null;
  const normalized = toPosix(normalize(rawPath));
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized.replace(/^\.\//, "");
}

/**
 * Build the data-read graph: referencedFile -> Set of TEST files naming it (mt#4224).
 *
 * Scanned over TEST files only, not every project file. Two reasons, and the second is
 * the load-bearing one: it is far less I/O than the import graph already does, and the
 * edge only means something in this direction — this selector returns TESTS, so a
 * non-test file naming a path is not a result it could ever emit.
 *
 * A literal becomes an edge only when it resolves to an existing file. That is the
 * bound (SC4): it is what keeps a partial path, a glob, a URL, or a `join(...)`
 * fragment from creating edges, and it means the graph can never be larger than the
 * set of real files the tests actually name.
 *
 * Fragment-assembled paths are OUT of scope by construction (SC5) — a `join(REPO_ROOT,
 * relPath)` whose `relPath` is a named constant works because the CONSTANT's own
 * declaration carries the literal, and this scans the whole file rather than the call
 * site. A path computed at runtime from a variable is not recoverable statically and
 * is not attempted.
 */
export function buildDataReadGraph(
  testFiles: string[],
  repoRoot: string,
  fs: FsLike = realFs
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const testFile of testFiles) {
    let content: string;
    try {
      content = readTextFile(fs, join(repoRoot, testFile));
    } catch {
      continue;
    }
    // TWO idioms appear in this corpus, and both are fully static — the difference is
    // only what the literal is relative TO:
    //
    //   join(REPO_ROOT, RULE_SOURCE)                       // repo-relative literal
    //   join(import.meta.dir, "../../.minsky/skills/...")  // test-dir-relative literal
    //
    // Resolving only the first was not enough: `plan-task-halt-citation.test.ts` uses it
    // and matched, while `create-task-claim-steps.test.ts` — the manifest test whose miss
    // motivated this whole task — uses the second and did NOT. Measured, not assumed:
    // before this branch, `find-related-tests .minsky/skills/create-task/SKILL.md`
    // returned only the halt-citation test.
    const testDir = dirname(testFile);
    for (const referenced of extractPathLiterals(content)) {
      for (const raw of [referenced, join(testDir, referenced)]) {
        const candidate = toRepoRelative(raw);
        // The existence check is the bound. It also drops self-references and any
        // literal that happens to look path-shaped without naming a repo file.
        if (candidate === null || candidate === testFile) continue;
        if (!fs.existsSync(join(repoRoot, candidate))) continue;
        let readers = graph.get(candidate);
        if (!readers) {
          readers = new Set<string>();
          graph.set(candidate, readers);
        }
        readers.add(testFile);
      }
    }
  }
  return graph;
}

/**
 * Directories whose whole POPULATION is asserted over by a census test (mt#4508).
 *
 * The three edges above all key on an individual FILE: a sibling by name, an importer,
 * or a test naming that file as a literal. A census test has none of those relationships
 * to the module it would catch — it asserts over the directory's whole membership, so it
 * is related to a file it has never heard of, precisely BECAUSE that file is new.
 *
 * That gap is why adding a `.minsky/hooks/<name>.ts` module selected ZERO tests
 * (measured 2026-08-24: `find-related-tests .minsky/hooks/zz-scratch-probe.ts` → empty),
 * so every local check passed and the first signal was a full CI run on an
 * already-reviewed PR. Adding one hook module obliges several separate registries, and
 * an author currently learns the count by exhausting it one CI round at a time.
 *
 * Deliberately a DECLARED scope rather than a repo-wide heuristic. A general
 * "test that reads a directory" rule would fire for changes anywhere in the tree, and
 * over-inclusion in this selector is not free — per `DEFAULT_MAX_DEPTH` below, a bloated
 * related set overruns the pre-commit wall-clock budget and blocks the commit outright.
 * Keying on a named directory bounds the cost to exactly the tree that needs it and
 * leaves every other change's selection byte-identical.
 *
 * Note this list does NOT go stale the way the registries it guards do: adding a hook
 * module requires no edit here — the edge fires on the DIRECTORY. Only adding a whole
 * new censused tree would.
 */
export const DIRECTORY_CENSUS_TESTS: ReadonlyArray<{
  readonly dir: string;
  readonly tests: readonly string[];
}> = [
  {
    dir: ".minsky/hooks",
    // `hook-module-inventory.test.ts` is the one that fires on mere ADDITION — it walks
    // the live tree and fails with the new module listed as `unclassified` plus a
    // bucket-count mismatch. `interceptor-coordinates.test.ts` censuses the DESCRIPTION
    // population rather than the tree, so it fires a step later, once the module is
    // described; it is selected here too so the author sees the whole obligation in one
    // run instead of discovering it on the next round.
    tests: [
      ".minsky/hooks/hook-module-inventory.test.ts",
      ".minsky/hooks/interceptor-coordinates.test.ts",
    ],
  },
];

/**
 * Census tests owed by a changed repo-relative path, or `[]` if it is not a member of any
 * censused POPULATION.
 *
 * Membership is narrower than "sits under the directory", and deliberately mirrors what the
 * census actually enumerates (PR #3289 R1). `hook-module-inventory.test.ts` derives its
 * population as `readdirSync(HOOKS_DIR).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))`,
 * so three kinds of path under the directory are NOT in it and must not pull the census tests in:
 *
 *   - a **test file** — editing a hook's own `.test.ts` body changes neither census
 *   - a **nested** path (`fixtures/x.json`) — that `readdirSync` is non-recursive
 *   - a **non-`.ts`** file — `.tsx` included, since the filter is `.ts`-exact
 *
 * Matching on a segment boundary also keeps a sibling directory sharing a name prefix
 * (`.minsky/hooks-archive/x.ts`) from claiming `.minsky/hooks`.
 */
export function censusTestsFor(changedFile: string): string[] {
  const out: string[] = [];
  for (const scope of DIRECTORY_CENSUS_TESTS) {
    const prefix = `${scope.dir}/`;
    if (!changedFile.startsWith(prefix)) continue;
    const name = changedFile.slice(prefix.length);
    if (name.includes("/")) continue;
    // `.ts` exactly — deliberately NOT the module-level `TS_EXT_RE`, which also matches
    // `.tsx` (PR #3289 R2). The census filters `f.endsWith(".ts") && !f.endsWith(".test.ts")`,
    // and a hook is a node process rather than a component, so a `.tsx` under this tree
    // would not be in the population it enumerates. Mirroring the predicate means mirroring
    // its extension too, or the claim above is only approximately true.
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    out.push(...scope.tests);
  }
  return out;
}

/**
 * Default BFS hops over the reverse-dependency graph.
 *
 * Lowered 6 -> 3 by mt#3765. The header above states that over-inclusion "only
 * costs a little extra local runtime, not correctness" — that cost model was
 * false. Measured 2026-08-08, related-test count by depth:
 *
 *   turn-writer.ts                      d1:1  d2:4  d3:13  d4:16  d5:32  d6:32
 *   agent-transcript-ingest-service.ts  d1:2  d2:11 d3:14  d4:30  d5:30  d6:30
 *
 * At depth 6 a `packages/domain/src/transcripts/*` change pulls in the entire
 * cockpit server suite: 32 files / 445 tests / 80s, against a 60s gate budget —
 * so over-inclusion did not cost "a little extra runtime," it made the gate
 * unpassable and blocked the commit outright. The same depth-3 set runs in
 * 2.5s (32x faster) and still contains the sibling test plus near importers.
 *
 * Under-inclusion is the trade this module already documents as ACCEPTED,
 * because `.husky/pre-push` + CI remain the authoritative backstop.
 */
export const DEFAULT_MAX_DEPTH = 3;

export interface FindRelatedTestsOptions {
  /** Max BFS hops over the reverse-dependency graph. Defaults to `DEFAULT_MAX_DEPTH`. */
  maxDepth?: number;
  /** Injectable filesystem -- defaults to real node:fs. */
  fs?: FsLike;
  /**
   * Graph scope to walk. Defaults to `GRAPH_ROOTS` (mt#4521). Injectable so a
   * measurement harness can compare scopes in ONE process — comparing across two
   * processes confounds the difference with cold-vs-warm filesystem cache, which is
   * how mt#4508 first measured 635ms vs 352ms for a change that was actually 316 vs 315.
   */
  roots?: readonly string[];
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
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const fs = opts.fs ?? realFs;
  const roots = opts.roots ?? GRAPH_ROOTS;

  // EVERY existing changed path, not only TS (mt#4224). The TS filter used to live
  // here, which discarded a changed `.md`/`.mdc` before any graph work and returned
  // `[]` outright — a gate in front of the data-read edge below, so adding that edge
  // alone would have been inert for exactly the markdown subjects it exists for. The
  // TS restriction still applies where it is meaningful, on the two TS-only passes
  // (sibling-test heuristic, import-graph seeds), just not to admission.
  const allChanged = changedFiles.map(toPosix).filter((f) => fs.existsSync(join(repoRoot, f)));

  if (allChanged.length === 0) return [];

  const normalizedChanged = allChanged.filter((f) => TS_EXT_RE.test(f));

  const related = new Set<string>();

  // 0. Data-read edges (mt#4224): a test that NAMES this path as a string literal.
  //    Runs over `allChanged`, so it is the one pass a markdown subject can reach.
  //    Built lazily — a commit whose changed files no test names pays one tree walk
  //    and no more, and a commit that touches nothing existing returned above.
  {
    const testFiles = collectAllProjectFiles(repoRoot, fs, roots).filter((f) =>
      TEST_SUFFIX_RE.test(f)
    );
    const dataReadGraph = buildDataReadGraph(testFiles, repoRoot, fs);
    for (const file of allChanged) {
      const readers = dataReadGraph.get(file);
      if (!readers) continue;
      for (const reader of readers) related.add(reader);
    }
  }

  // 0b. Directory-census edges (mt#4508): a test asserting over the whole population of
  //     a declared directory. Seeded from `allChanged` rather than the TS-only
  //     `normalizedChanged` because membership is decided by `censusTestsFor`, which
  //     applies the census's OWN predicate (direct child, `.ts`, non-test) rather than
  //     this function's admission filter. Gated on existence for the same reason every
  //     other edge here is: a declared test that has been renamed or deleted must produce
  //     no edge rather than a path bun cannot run.
  for (const file of allChanged) {
    for (const censusTest of censusTestsFor(file)) {
      if (fs.existsSync(join(repoRoot, censusTest))) related.add(censusTest);
    }
  }

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
    const allFiles = collectAllProjectFiles(repoRoot, fs, roots);
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
