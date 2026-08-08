#!/usr/bin/env bun
/**
 * Asserts that every tracked `.ts`/`.tsx` file is typechecked by some tsconfig
 * project that CI actually RUNS (mt#3780).
 *
 * Why this exists: repo typecheck coverage is the union of several
 * hand-maintained `include` lists, and a tree that falls between them is
 * checked by nothing — silently, with a green build. Four such trees had been
 * found before this script, each one by accident:
 *
 *   - root `scripts/`                  mt#3082 -> mt#3088
 *   - `.minsky/hooks` SOURCE tree      mt#2900 (still open)
 *   - `services/reviewer/scripts`      mt#3498
 *   - `packages/**`                    mt#3102
 *
 * Three of the four surfaced only because a person hand-ran a negative control.
 * The failure is silent and inverted: an uncovered tree produces exit 0, the
 * same signal a clean one produces (mem#704 — a probe that returns the same
 * result when the system is broken is not verification).
 *
 * ## Two halves, one invariant
 *
 * "Claimed by a project" is NOT sufficient. A file claimed only by a project
 * that nothing ever runs is exactly as unchecked as a file claimed by nothing:
 * `infra/`, `services/cockpit/`, and `services/site/` each ship a tsconfig with
 * no typecheck script and no CI step. So the covered set is computed ONLY from
 * projects reachable from a CI typecheck step — which collapses both halves
 * into a single assertion rather than two.
 *
 * ## Why the compiler, not the globs
 *
 * The file set comes from `tsgo --listFiles`, not from parsing each tsconfig's
 * `include`/`exclude`. TypeScript's program contains files reached by IMPORT
 * from an included file, not just files matching `include` — and that
 * distinction is load-bearing here, not academic. mt#3102's finding was
 * precisely that `packages/**` SOURCE was covered via import reachability from
 * `src/` while its TEST files were not; a glob-only check would have called the
 * whole tree uncovered and buried the real signal in false positives.
 *
 * Cost: ~6.5s for all projects sequentially (measured 2026-08-06; the slowest
 * single project is ~1.1s). Cheap enough to run as its own CI step.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Allowlist ────────────────────────────────────────────────────────────────

/**
 * A tree deliberately left out of every typecheck project.
 *
 * `reason` is REQUIRED and must be non-empty: the point of the allowlist is
 * that an exclusion is a recorded decision rather than an oversight, so an
 * entry that does not say WHY is itself a failure (see `validateAllowlist`).
 */
export interface AllowlistEntry {
  /** Repo-relative path prefix. Directory prefixes should end with `/`. */
  readonly prefix: string;
  /** Why this is excluded. Must be non-empty. */
  readonly reason: string;
  /** Task that will retire the exclusion, when it is temporary rather than permanent. */
  readonly tracking?: string;
}

export const COVERAGE_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    prefix: ".minsky/",
    reason:
      "Source tree for the generated .claude/** outputs. tsconfig.hooks.json covers only the " +
      "COMPILED .claude/hooks copy, so an error in a source file is not caught until it is " +
      "compiled. This is a real gap, not a deliberate exclusion.",
    tracking: "mt#2900",
  },
  {
    prefix: "tests/fixtures/",
    reason:
      "Deliberately-malformed sample inputs (e.g. a NUL-byte source file) used AS TEST DATA. " +
      "The root tsconfig excludes them by design; typechecking them would fail on purpose.",
  },
  {
    prefix: "tests/integration/fixtures/",
    reason:
      "Same as tests/fixtures/ — sample sources consumed as test data, excluded by the root tsconfig.",
  },
  {
    prefix: "eslint-rules/__fixtures__/",
    reason:
      "Rule-test fixtures. The `invalid.ts` files are invalid BY DESIGN — they exist so the " +
      "custom ESLint rules have something to flag — so they must not be typechecked.",
  },
  {
    prefix: "services/cockpit/deploy.config.ts",
    reason:
      "Deploy-surface config in no run project. Verified clean 2026-08-06; surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "services/minsky-mcp/deploy.config.ts",
    reason:
      "Deploy-surface config in no run project. Verified clean 2026-08-06; surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "services/minsky-ops/deploy.config.ts",
    reason:
      "Deploy-surface config in no run project. Verified clean 2026-08-06; surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "services/reviewer/deploy.config.ts",
    reason:
      "Deploy-surface config in no run project. Verified clean 2026-08-06; surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "services/reviewer/drizzle.pg.config.ts",
    reason: "Drizzle config in no run project. Verified clean 2026-08-06; surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "services/reviewer/eval/",
    reason:
      "Reviewer eval harness, outside services/reviewer/tsconfig.json's include. Surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "services/site/",
    reason:
      "services/site ships a tsconfig but declares no typecheck script and has no CI step, so " +
      "nothing runs it. Surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "services/cockpit/src/",
    reason:
      "services/cockpit ships a tsconfig but declares no typecheck script and has no CI step, so " +
      "nothing runs it. Surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "infra/",
    reason:
      "infra ships a tsconfig but declares no typecheck script and has no CI step, so nothing " +
      "runs it. Surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "vite.config.ts",
    reason:
      "Root build config in no run project. Verified clean 2026-08-06; surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "tailwind.config.ts",
    reason:
      "Root build config in no run project. Verified clean 2026-08-06; surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "drizzle.config.ts",
    reason:
      "Root drizzle config in no run project. Verified clean 2026-08-06; surfaced, not paid down.",
    tracking: "mt#3817",
  },
  {
    prefix: "drizzle.pg.config.ts",
    reason:
      "Root drizzle config in no run project. Verified clean 2026-08-06; surfaced, not paid down.",
    tracking: "mt#3817",
  },
];

// ── Functional core (pure — unit-tested without spawning a compiler) ──────────

export interface AllowlistProblem {
  readonly index: number;
  readonly prefix: string;
  readonly problem: string;
}

/**
 * Reject allowlist entries that do not record WHY the exclusion exists.
 *
 * An entry with a blank reason is the exact thing the allowlist is meant to
 * prevent — an undocumented hole that reads as a decision.
 */
export function validateAllowlist(entries: readonly AllowlistEntry[]): AllowlistProblem[] {
  const problems: AllowlistProblem[] = [];
  entries.forEach((entry, index) => {
    if (entry.prefix.trim() === "") {
      problems.push({ index, prefix: entry.prefix, problem: "empty prefix" });
    }
    if (entry.reason.trim() === "") {
      problems.push({ index, prefix: entry.prefix, problem: "missing or empty reason" });
    }
  });
  return problems;
}

export function isAllowlisted(file: string, entries: readonly AllowlistEntry[]): boolean {
  return entries.some((entry) => file === entry.prefix || file.startsWith(entry.prefix));
}

export interface CoverageComparison {
  /** Tracked files covered by no RUN project and not allowlisted — the violations. */
  readonly uncovered: string[];
  /** Tracked files covered by no RUN project but explicitly allowlisted. */
  readonly allowlisted: string[];
  /** Allowlist prefixes that matched nothing — stale entries worth removing. */
  readonly unusedAllowlistPrefixes: string[];
}

/**
 * Compare the tracked file set against the covered file set.
 *
 * Pure: takes both sets plus the allowlist and returns the verdict, so the
 * comparison logic is testable without spawning a compiler (mem#316 —
 * functional core, imperative shell).
 */
export function compareCoverage(
  trackedFiles: readonly string[],
  coveredFiles: ReadonlySet<string>,
  entries: readonly AllowlistEntry[]
): CoverageComparison {
  const uncovered: string[] = [];
  const allowlisted: string[] = [];
  const matchedPrefixes = new Set<string>();

  for (const file of trackedFiles) {
    if (coveredFiles.has(file)) continue;
    const entry = entries.find((e) => file === e.prefix || file.startsWith(e.prefix));
    if (entry) {
      allowlisted.push(file);
      matchedPrefixes.add(entry.prefix);
    } else {
      uncovered.push(file);
    }
  }

  const unusedAllowlistPrefixes = entries
    .map((e) => e.prefix)
    .filter((prefix) => !matchedPrefixes.has(prefix));

  return { uncovered, allowlisted, unusedAllowlistPrefixes };
}

// ── Imperative shell (process + filesystem) ──────────────────────────────────

export interface ProjectRun {
  readonly project: string;
  readonly fileCount: number;
}

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Read a file as text. Always a `string` — see the note in `resolveRunProjects`. */
function readText(path: string): string {
  return String(readFileSync(path, "utf-8"));
}

/**
 * Run a command and capture stdout.
 *
 * `Bun.spawnSync` rather than `node:child_process` per `bun_over_node.mdc` —
 * and it suits this script better anyway: it reports a non-zero exit in
 * `exitCode` instead of throwing, and a project with type ERRORS still prints
 * its file list. This script is about COVERAGE, not correctness (the dedicated
 * typecheck steps own that), so a failing project must not abort the sweep.
 */
function runCapture(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "ignore" });
  return result.stdout.toString();
}

/**
 * Path to the lockfile-pinned `tsgo`.
 *
 * Fails loudly if it is missing rather than silently falling back to whatever
 * a PATH lookup or `bunx` would resolve: a coverage invariant that quietly
 * measured a DIFFERENT compiler version than the typecheck steps it backstops
 * would report coverage that does not correspond to what CI actually checks.
 */
function tsgoBinary(repoRoot: string): string {
  const binary = join(repoRoot, "node_modules", ".bin", "tsgo");
  if (!existsSync(binary)) {
    throw new Error(
      `pinned tsgo not found at ${binary} — run \`bun install\` before the coverage check ` +
        "(deliberately NOT falling back to `bunx`, which would bypass the lockfile pin)"
    );
  }
  return binary;
}

/**
 * Resolve the tsconfig projects that CI actually runs.
 *
 * Derived, never hardcoded — a project added to CI must show up here without
 * editing this script, which is the same dynamic-discovery property
 * `validate_typecheck` relies on (mt#2256).
 *
 * Two sources:
 *  1. Root `package.json` `typecheck*` scripts — `-p <path>` names a project;
 *     a bare `tsgo --noEmit` with no `-p` means the ROOT tsconfig.
 *  2. Workspace `package.json` files declaring their own `typecheck` script,
 *     which CI runs via a `working-directory:` step.
 *
 * A root script is only counted when a CI `run:` line reaches it, directly or
 * through a `bun run <name>` chain — a `typecheck:*` script nothing invokes is
 * not coverage either.
 */
export function resolveRunProjects(repoRoot: string = REPO_ROOT): string[] {
  // `String(...)`: under this repo's `types: ["bun"]` config, readFileSync's
  // second-arg-encoding overload resolves to `string | Buffer`, which makes
  // every downstream string method see a union.
  const rootPkg = JSON.parse(readText(join(repoRoot, "package.json"))) as {
    scripts?: Record<string, string>;
    workspaces?: string[];
  };
  const scripts = rootPkg.scripts ?? {};
  const ci = readText(join(repoRoot, ".github/workflows/ci.yml"));

  // Root scripts CI invokes, expanded through `bun run <name>` indirection.
  const invoked = new Set<string>();
  const queue: string[] = [];
  for (const name of Object.keys(scripts)) {
    if (new RegExp(`bun run ${name.replace(/[:.]/g, "\\$&")}(\\s|$)`, "m").test(ci)) {
      queue.push(name);
    }
  }
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || invoked.has(name)) continue;
    invoked.add(name);
    const body = scripts[name];
    if (body === undefined) continue;
    for (const match of body.matchAll(/bun run ([\w:.-]+)/g)) {
      const next = match[1];
      if (next !== undefined && !invoked.has(next)) queue.push(next);
    }
  }

  const projects = new Set<string>();
  for (const name of invoked) {
    const body = scripts[name];
    if (body === undefined || (!body.includes("tsgo") && !body.includes("tsc"))) continue;
    const explicit = [...body.matchAll(/-p\s+([\w./-]+)/g)];
    if (explicit.length > 0) {
      for (const match of explicit) {
        const target = match[1];
        if (target !== undefined) projects.add(normalizeProject(target));
      }
    } else if (/tsgo\s+--noEmit(?!\s+-p)/.test(body)) {
      projects.add("tsconfig.json");
    }
  }

  // Workspace projects with their own typecheck script + a CI working-directory step.
  for (const dir of listWorkspaceDirs(repoRoot, rootPkg.workspaces ?? [])) {
    const pkgPath = join(repoRoot, dir, "package.json");
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string> };
    } catch {
      continue; // No package.json, or unreadable — not a workspace we can classify.
    }
    if (pkg.scripts?.typecheck === undefined) continue;
    if (!ci.includes(`working-directory: ${dir}`)) continue;
    projects.add(`${dir}/tsconfig.json`);
  }

  return [...projects].sort();
}

function normalizeProject(target: string): string {
  return target.endsWith(".json") ? target : `${target}/tsconfig.json`;
}

function listWorkspaceDirs(repoRoot: string, globs: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const glob of globs) {
    if (!glob.endsWith("/*")) continue;
    const parent = glob.slice(0, -2);
    const listed = runCapture(["git", "ls-files", `${parent}/*/package.json`], repoRoot);
    for (const line of listed.split("\n")) {
      if (line.trim() === "") continue;
      dirs.push(line.replace(/\/package\.json$/, ""));
    }
  }
  return dirs;
}

/** Every tracked `.ts`/`.tsx` file, repo-relative. */
export function listTrackedTsFiles(repoRoot: string = REPO_ROOT): string[] {
  const out = runCapture(["git", "ls-files", "*.ts", "*.tsx"], repoRoot);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("node_modules/"))
    .sort();
}

/** The compiler's resolved file set for one project, repo-relative. */
export function listProjectFiles(project: string, repoRoot: string = REPO_ROOT): string[] {
  // The LOCKFILE-PINNED binary, not `bunx tsgo`. `bunx` resolves (and if
  // necessary fetches) at runtime, which both bypasses the pin every other
  // typecheck step honors and puts a network install inside an invariant whose
  // whole job is to be trustworthy. Resolved explicitly rather than via PATH
  // because this is a spawned process, not a `bun run` script.
  const out = runCapture(
    [tsgoBinary(repoRoot), "--noEmit", "--listFiles", "-p", project],
    repoRoot
  );
  const prefix = `${repoRoot}/`;
  return out
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
    .filter((line) => !line.startsWith("node_modules/"));
}

/** Which project(s) cover a given tree, and how many of its files they claim. */
export interface TreeAttribution {
  readonly tree: string;
  readonly projects: string[];
  readonly fileCount: number;
}

/**
 * Collapse a repo-relative file path to the TREE it belongs to.
 *
 * Two directory segments, which is the granularity that distinguishes the
 * things people actually reason about here (`packages/domain` vs
 * `packages/shared`, `src/cockpit` vs `src/adapters`) without degenerating into
 * one row per directory. Root-level files group under ".".
 */
export function treeOf(file: string): string {
  const lastSlash = file.lastIndexOf("/");
  if (lastSlash === -1) return ".";
  const dir = file.slice(0, lastSlash);
  const segments = dir.split("/");
  return segments.slice(0, 2).join("/");
}

/**
 * Invert the project -> files index into tree -> covering projects.
 *
 * This is what makes coverage LEGIBLE rather than inferred: a per-project file
 * count tells a reader how much each project checks, but not which project is
 * responsible for any given tree — so "is `src/cockpit` covered, and by what?"
 * could only be answered by re-deriving the union by hand.
 */
export function attributeTreesToProjects(
  filesByProject: ReadonlyMap<string, readonly string[]>
): TreeAttribution[] {
  const projectsByTree = new Map<string, Set<string>>();
  const filesByTree = new Map<string, Set<string>>();

  for (const [project, files] of filesByProject) {
    for (const file of files) {
      const tree = treeOf(file);
      const projects = projectsByTree.get(tree) ?? new Set<string>();
      projects.add(project);
      projectsByTree.set(tree, projects);

      const seen = filesByTree.get(tree) ?? new Set<string>();
      seen.add(file);
      filesByTree.set(tree, seen);
    }
  }

  return [...projectsByTree]
    .map(([tree, projects]) => ({
      tree,
      projects: [...projects].sort(),
      fileCount: filesByTree.get(tree)?.size ?? 0,
    }))
    .sort((a, b) => a.tree.localeCompare(b.tree));
}

export interface CoverageReport extends CoverageComparison {
  readonly runProjects: ProjectRun[];
  readonly trackedCount: number;
  readonly coveredCount: number;
  /** tree -> the project(s) that cover it (SC4's legibility requirement). */
  readonly attribution: TreeAttribution[];
}

export function computeCoverageReport(repoRoot: string = REPO_ROOT): CoverageReport {
  const runProjects: ProjectRun[] = [];
  const covered = new Set<string>();
  const filesByProject = new Map<string, string[]>();

  for (const project of resolveRunProjects(repoRoot)) {
    // No try/catch: `runCapture` surfaces a non-zero exit as an exit code, not
    // a throw, and a project with type errors still prints its file list.
    const files = listProjectFiles(project, repoRoot);
    runProjects.push({ project, fileCount: files.length });
    filesByProject.set(project, files);
    for (const file of files) covered.add(file);
  }

  const tracked = listTrackedTsFiles(repoRoot);
  const comparison = compareCoverage(tracked, covered, COVERAGE_ALLOWLIST);

  // Attribute only TRACKED files: a project's program also pulls in generated
  // and vendored files, which are not what a reader is asking about when they
  // ask which project covers a tree.
  const trackedSet = new Set(tracked);
  const trackedByProject = new Map<string, string[]>(
    [...filesByProject].map(([project, files]) => [project, files.filter((f) => trackedSet.has(f))])
  );

  return {
    ...comparison,
    runProjects,
    trackedCount: tracked.length,
    coveredCount: covered.size,
    attribution: attributeTreesToProjects(trackedByProject),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(): void {
  const allowlistProblems = validateAllowlist(COVERAGE_ALLOWLIST);
  if (allowlistProblems.length > 0) {
    console.error("Allowlist is invalid — every entry must record why the exclusion exists:\n");
    for (const problem of allowlistProblems) {
      console.error(`  [${problem.index}] ${problem.prefix || "(blank)"}: ${problem.problem}`);
    }
    process.exit(1);
  }

  const report = computeCoverageReport();

  console.log("Typecheck coverage — projects CI actually runs:\n");
  for (const { project, fileCount } of report.runProjects) {
    console.log(`  ${project.padEnd(38)} ${String(fileCount).padStart(5)} files`);
  }
  console.log(
    `\n  ${report.trackedCount} tracked .ts/.tsx files; ${report.coveredCount} in at least one run project.`
  );

  // Which project covers which tree. A per-project COUNT says how much each
  // project checks; it does not say who is responsible for a given tree, which
  // is the question a reader actually arrives with.
  console.log("\nWhich project covers which tree:\n");
  for (const { tree, projects, fileCount } of report.attribution) {
    const label = `${tree}/`.replace(/^\.\/$/, "(repo root)");
    console.log(
      `  ${label.padEnd(34)} ${String(fileCount).padStart(5)} files  ←  ${projects.join(", ")}`
    );
  }

  if (report.allowlisted.length > 0) {
    const byPrefix = new Map<string, number>();
    for (const file of report.allowlisted) {
      const entry = COVERAGE_ALLOWLIST.find((e) => file === e.prefix || file.startsWith(e.prefix));
      if (entry) byPrefix.set(entry.prefix, (byPrefix.get(entry.prefix) ?? 0) + 1);
    }
    console.log(`\nAllowlisted (${report.allowlisted.length} files, each with a recorded reason):`);
    for (const [prefix, count] of [...byPrefix].sort()) {
      const entry = COVERAGE_ALLOWLIST.find((e) => e.prefix === prefix);
      const tracking = entry?.tracking ? ` [${entry.tracking}]` : "";
      console.log(`  ${prefix.padEnd(42)} ${String(count).padStart(4)} files${tracking}`);
    }
  }

  if (report.unusedAllowlistPrefixes.length > 0) {
    console.log("\nStale allowlist entries (matched nothing — the gap they named is closed):");
    for (const prefix of report.unusedAllowlistPrefixes) console.log(`  ${prefix}`);
  }

  if (report.uncovered.length === 0) {
    console.log("\nPASS — every tracked .ts/.tsx file is claimed by a project CI runs.");
    return;
  }

  console.error(
    `\nFAIL — ${report.uncovered.length} tracked file(s) are typechecked by NO project that CI runs:\n`
  );
  const byDir = new Map<string, string[]>();
  for (const file of report.uncovered) {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }
  for (const [dir, files] of [...byDir].sort()) {
    console.error(`  ${dir}/  (${files.length})`);
    for (const file of files.slice(0, 5)) console.error(`    ${file}`);
    if (files.length > 5) console.error(`    … and ${files.length - 5} more`);
  }
  console.error(
    "\nEither add the tree to a tsconfig project that CI runs, or add it to " +
      "COVERAGE_ALLOWLIST in scripts/typecheck-coverage.ts with a reason."
  );
  process.exit(1);
}

if (import.meta.main) {
  main();
}
