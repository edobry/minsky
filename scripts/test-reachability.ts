#!/usr/bin/env bun
/**
 * Asserts that every tracked `*.test.ts` / `*.test.tsx` file is EXECUTED by
 * some suite that gates a pull request (mt#3935).
 *
 * Why this exists: which files run is the union of several hand-maintained path
 * lists — `ROOTS` in `scripts/run-tests-main.ts`, the positional arguments of
 * the `test:*` scripts, and the steps in the workflows — and a file that falls
 * between them runs in NOTHING. Silently, with a green build. Four such holes
 * had been found before this script, each one by accident:
 *
 *   - `src/cockpit/web/*.test.tsx` (top level)   mt#3470 -> mt#3496
 *   - `scripts/**\/*.test.ts` (20 files)          mt#3871 -> mt#1084
 *   - `tests/utils/` (2 files, 2 of them FAILING) mt#1084  -> mt#3934
 *   - `tests/*.test.ts` (top level, 4 files)      mt#4726  -> mt#4882
 *
 * Four for four, every one was found by a person who happened to look. Silent
 * non-execution is worse than a failure: the file READS as coverage and
 * provides none — `tests/utils/diff.test.ts` shows the end state, where two
 * assertions drifted out of agreement with the implementation and nothing
 * noticed, because nothing ran them.
 *
 * ## Reached by WHAT, exactly
 *
 * "Named by some `test:*` script" is NOT sufficient. A file reachable only by a
 * script nothing invokes is exactly as unrun as a file named by nothing. So the
 * covered set is computed only from suites reachable from a workflow that runs
 * on `pull_request` — the gates that actually protect a change before it lands.
 * This mirrors `scripts/typecheck-coverage.ts`, which computes its covered set
 * only from tsconfig projects a CI step actually runs, and for the same reason.
 *
 * Two consequences worth stating, because both look like bugs otherwise:
 *
 *   - `.github/workflows/clock-shifted-tests.yml` is EXCLUDED: it is `schedule`
 *     + `workflow_dispatch` only, so it gates no PR. It would also contribute
 *     nothing, since it reaches `ROOTS` + `GRAPH_ONLY_ROOTS` — the same lists
 *     the pre-push runner already uses, holes included.
 *   - `.github/workflows/release.yml` is EXCLUDED: it triggers on `push` of a
 *     `v*` tag and runs a BARE `bun test`, which walks nearly the whole repo.
 *     Counting it would mark almost everything covered and make this check
 *     vacuous — and a suite that runs only at release time cannot stop a bad
 *     merge anyway.
 *
 * ## Why paths are modelled as anchored prefixes
 *
 * `bun test`'s positional arguments are SUBSTRING filters, not anchored paths
 * (see `scripts/run-tests-main.ts`'s header docstring for the repro). This
 * script models them as anchored prefixes instead, which is deliberately
 * STRICTER: a substring model would count more files as covered, and every
 * error it made would be in the direction of hiding a hole. The repo already
 * prefixes every generated file argument with `./` precisely to anchor the
 * match, so the strict model is also the accurate one for how these suites are
 * actually invoked.
 *
 * Usage:
 *   bun scripts/test-reachability.ts           # report; exit 1 on any violation
 *   bun scripts/test-reachability.ts --json    # structured report
 *
 * Exit code: 0 = every tracked test file is reached by a PR-gating suite, or is
 * allowlisted with a reason; 1 = at least one is reached by nothing; 2 = the
 * check itself could not run (a suite whose scope could not be resolved).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { EXCLUDE_DIR_PREFIXES, ROOTS } from "./run-tests-main";
import { MCP_DIR } from "./run-tests-mcp-isolated";

// ── Allowlist ────────────────────────────────────────────────────────────────

/**
 * A test file deliberately, or knowingly, not run by any PR-gating suite.
 *
 * `reason` is REQUIRED and must be non-empty: the point of the allowlist is
 * that a hole is a RECORDED decision rather than an oversight, so an entry that
 * does not say why is itself a failure (see `validateAllowlist`).
 */
export interface AllowlistEntry {
  /** Repo-relative path prefix. Directory prefixes should end with `/`. */
  readonly prefix: string;
  /** Why this is not run. Must be non-empty. */
  readonly reason: string;
  /** Task that will retire the hole, when it is temporary rather than permanent. */
  readonly tracking?: string;
}

export const REACHABILITY_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    prefix: "tests/eslint-config-target-ignore.test.ts",
    reason:
      "`ROOTS` names eight ./tests subdirectories but never ./tests itself, so the four files " +
      "sitting directly in tests/ run in no suite. Measured 2026-09-01; all four PASS, so this " +
      "closes green as soon as the root is widened.",
    tracking: "mt#4882",
  },
  {
    prefix: "tests/session-pr-validation.test.ts",
    reason: "Same ./tests root gap as tests/eslint-config-target-ignore.test.ts.",
    tracking: "mt#4882",
  },
  {
    prefix: "tests/state-dir-isolation.test.ts",
    reason: "Same ./tests root gap as tests/eslint-config-target-ignore.test.ts.",
    tracking: "mt#4882",
  },
  {
    prefix: "tests/verify-bug-fix.test.ts",
    reason: "Same ./tests root gap as tests/eslint-config-target-ignore.test.ts.",
    tracking: "mt#4882",
  },
  {
    prefix: "tests/integration/transcript-attachment-parent-row.integration.test.ts",
    reason:
      "Explicitly held out in .github/workflows/integration-tests.yml ('HELD OUT until mt#3509 " +
      "lands', mt#3482 / PR #2503 R1). A recorded decision with an owner, not an oversight.",
    tracking: "mt#3509",
  },
  {
    prefix: "tests/integration/engprod-ledger-suppression-verdict.integration.test.ts",
    reason:
      "Named by no integration-tests.yml job. The workflow lists its files individually rather " +
      "than running the directory, and this one is in no list — the first hole this check found " +
      "on its own rather than by someone happening to look.",
    tracking: "mt#4884",
  },
  {
    prefix: "tests/integration/transcript-divergence-verdict-update.integration.test.ts",
    reason: "Same integration-tests.yml omission as engprod-ledger-suppression-verdict.",
    tracking: "mt#4884",
  },
];

// ── Functional core (pure — unit-tested without reading the repo) ─────────────

/**
 * The set of test files one suite invocation executes.
 *
 * `roots: []` means "no positional arguments were given", i.e. the whole repo
 * below `cwd` — which is how `bun test` behaves with no path filter.
 */
export interface SuiteScope {
  /** Human-readable provenance, e.g. `ci.yml -> test -> scripts/run-tests-main.ts`. */
  readonly suite: string;
  /** Repo-relative directory prefixes or exact file paths. Empty = everything below `cwd`. */
  readonly roots: readonly string[];
  /** Repo-relative prefixes this suite skips. */
  readonly excludePrefixes: readonly string[];
}

export interface AllowlistProblem {
  readonly index: number;
  readonly prefix: string;
  readonly problem: string;
}

/**
 * Reject allowlist entries that do not record WHY the hole exists.
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

/** Strip a leading `./` and a trailing `/` so path forms compare equal. */
export function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Does `prefix` cover `file`, as an ANCHORED path prefix?
 *
 * A bare directory name covers everything under it; an exact file path covers
 * only itself. `src/cockpit/web` does NOT cover `src/cockpit/web-dist.test.ts`
 * — the `/` boundary is what stops that substring collision, which is the same
 * collision `test:components` needed a leading `./` to avoid (mt#3496).
 */
export function pathCovers(prefix: string, file: string): boolean {
  const p = normalizePath(prefix);
  if (p === "" || p === ".") return true;
  if (p.includes("*")) {
    const pattern = p
      .split("**")
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
      .join(".*");
    return new RegExp(`^${pattern}(/|$)`).test(file);
  }
  return file === p || file.startsWith(`${p}/`);
}

/**
 * Does a `--path-ignore-patterns` glob exclude `file`?
 *
 * Only the `dir/**` and bare-prefix forms the repo actually uses are supported;
 * anything else is treated as non-matching rather than guessed at, and callers
 * that need more should extend this deliberately.
 */
export function ignoreMatches(pattern: string, file: string): boolean {
  const trimmed = pattern.replace(/^['"]|['"]$/g, "");
  const base = trimmed.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  return pathCovers(base, file);
}

export function scopeReaches(scope: SuiteScope, file: string): boolean {
  if (scope.excludePrefixes.some((prefix) => ignoreMatches(prefix, file))) return false;
  if (scope.roots.length === 0) return true;
  return scope.roots.some((root) => pathCovers(root, file));
}

export interface ReachabilityComparison {
  /** Test files reached by no PR-gating suite and not allowlisted — the violations. */
  readonly unreached: string[];
  /** Test files reached by no PR-gating suite but explicitly allowlisted. */
  readonly allowlisted: string[];
  /** Allowlist prefixes that match no unreached file — stale entries to delete. */
  readonly unusedAllowlistPrefixes: string[];
  /** Per-file attribution for the reached ones, so a report can say WHICH suite runs a file. */
  readonly reachedBy: ReadonlyMap<string, string[]>;
}

export function compareReachability(
  testFiles: readonly string[],
  scopes: readonly SuiteScope[],
  allowlist: readonly AllowlistEntry[]
): ReachabilityComparison {
  const unreached: string[] = [];
  const allowlisted: string[] = [];
  const reachedBy = new Map<string, string[]>();
  const usedPrefixes = new Set<string>();

  for (const file of testFiles) {
    const suites = scopes.filter((scope) => scopeReaches(scope, file)).map((scope) => scope.suite);
    if (suites.length > 0) {
      reachedBy.set(file, suites);
      continue;
    }
    const entry = allowlist.find((e) => file === e.prefix || file.startsWith(e.prefix));
    if (entry) {
      allowlisted.push(file);
      usedPrefixes.add(entry.prefix);
    } else {
      unreached.push(file);
    }
  }

  return {
    unreached,
    allowlisted,
    unusedAllowlistPrefixes: allowlist
      .map((e) => e.prefix)
      .filter((prefix) => !usedPrefixes.has(prefix)),
    reachedBy,
  };
}

// ── Command parsing (pure) ───────────────────────────────────────────────────

/**
 * `bun test` flags that consume the NEXT argument as their value.
 *
 * This list is load-bearing rather than cosmetic: without it, `--preload
 * ./tests/setup.ts` leaves `./tests/setup.ts` looking like a positional path,
 * which would silently mark the whole `tests/` tree as covered by every suite
 * that preloads it — turning this check green by accident.
 */
const VALUE_FLAGS = new Set([
  "--preload",
  "-p",
  "--timeout",
  "--reporter",
  "--reporter-outfile",
  "--path-ignore-patterns",
  "--changed",
  "--concurrency",
  "--shard",
]);

export interface ParsedBunTest {
  readonly roots: string[];
  readonly ignores: string[];
}

/**
 * Extract the positional path filters and `--path-ignore-patterns` values from
 * a `bun test ...` command. Returns `null` when the command is not a `bun test`
 * invocation at all.
 */
export function parseBunTestCommand(command: string): ParsedBunTest | null {
  // `bun test` must be in COMMAND POSITION — start of the segment, or after a
  // shell operator, optionally behind `VAR=value` prefixes. Matching the words
  // anywhere is not a near-miss, it is actively wrong: ci.yml's own error
  // strings say "bun test did not print a completion summary line", and parsing
  // that prose yielded the positional root `tests`, which covers the entire
  // tests/ tree and turned a real hole green.
  const match = command.match(
    /(?:^|&&|;|\|\||\bthen\b|\bdo\b)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*bun\s+test\b/
  );
  if (match?.index === undefined) return null;

  const tokens = command
    .slice(match.index + match[0].length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const roots: string[] = [];
  const ignores: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token === "\\") continue;
    if (token.startsWith("--path-ignore-patterns=")) {
      ignores.push(token.slice("--path-ignore-patterns=".length).replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (token === "--path-ignore-patterns") {
      const value = tokens[++i];
      if (value !== undefined) ignores.push(value.replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      i++; // consume the value so it is not mistaken for a path
      continue;
    }
    if (token.startsWith("-")) continue; // inline `--flag=value` or a boolean flag
    roots.push(token);
  }
  return { roots, ignores };
}

// ── Imperative shell ─────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, "..");

/** Suites we know how to resolve statically, by the runner script they invoke. */
const KNOWN_RUNNERS: Record<string, { roots: string[]; excludePrefixes: string[] }> = {
  "scripts/run-tests-main.ts": {
    roots: [...ROOTS],
    excludePrefixes: [...EXCLUDE_DIR_PREFIXES],
  },
  "scripts/run-tests-main-sharded.ts": {
    roots: [...ROOTS],
    excludePrefixes: [...EXCLUDE_DIR_PREFIXES],
  },
  "scripts/run-tests-mcp-isolated.ts": { roots: [MCP_DIR], excludePrefixes: [] },
  // The gated runner spawns the two above; its scope is their union.
  "scripts/run-tests-gated.ts": {
    roots: [...ROOTS, MCP_DIR],
    excludePrefixes: EXCLUDE_DIR_PREFIXES.filter((p) => p !== "src/mcp"),
  },
};

/**
 * Runners that DO execute test files but contribute no STANDING coverage,
 * because what they run is derived from the DIFF rather than from a path list.
 *
 * These must be named rather than silently skipped: each one genuinely invokes
 * tests, so `invokesTests` correctly identifies it as a runner, and the only
 * thing distinguishing it from a suite is a judgment about what its selection
 * is keyed on. Recording that judgment here is the point.
 */
const CHANGE_SCOPED_RUNNERS: Record<string, string> = {
  "scripts/check-test-changed-line-coverage.ts":
    "mt#4779 — runs only the test files a PR ADDS, to intersect their executed lines with the " +
    "diff. A file it runs in one PR it does not run in the next, so it keeps nothing covered.",
};

export class UnresolvableSuiteError extends Error {}

/**
 * Does this script cause test FILES to run?
 *
 * CI invokes plenty of `bun scripts/*.ts` that are not suites (budget checks,
 * catalog builders, coverage invariants — including this one). Treating every
 * one as an unregistered runner would make the check refuse to run at all, so
 * the question is answered from the script's OWN SOURCE rather than from a
 * hand-maintained list of non-runners, which would drift exactly like the path
 * lists this check audits.
 *
 * Three shapes, matching how the existing runners are actually written:
 * spawning `bun test` directly, building its argv via `toBunTestArgs`, or
 * spawning `bun <a run-tests module>` (which is what the gated runner does —
 * it spawns `["bun", script]`, so no literal `"test"` appears).
 *
 * Every shape requires an actual SPAWN of `bun`. Importing from a run-tests
 * module is deliberately not enough: reading `ROOTS` to REASON about which
 * files a suite would run is exactly what a coverage check does — including
 * this script, which was self-classified as an unregistered runner until the
 * spawn requirement was added, aborting its own sweep.
 */
export function invokesTests(source: string): boolean {
  const code = stripComments(source);
  const spawnsBun = /\[\s*["']bun["']\s*,/.test(code);
  return (
    (spawnsBun && /["']test["']/.test(code)) ||
    /\btoBunTestArgs\b/.test(code) ||
    (spawnsBun && /run-tests-/.test(code))
  );
}

/**
 * Drop comments before asking what a script DOES.
 *
 * Same lesson as `parseBunTestCommand`'s command-position requirement, one
 * layer up: prose that describes a spawn is not a spawn. This script's own
 * docblock explains the gated runner by quoting `["bun", script]`, and matching
 * against raw source therefore classified THIS FILE as a test runner — aborting
 * its sweep with exit 2 the moment it was added to CI.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Read a file as text.
 *
 * `String(...)` rather than a cast: this repo's `readFileSync` typings resolve
 * to `string | Buffer` even with an explicit encoding, and a coercion is true
 * at runtime where an `as string` would only silence the checker.
 */
function readText(path: string): string {
  return String(readFileSync(path, "utf8"));
}

/** `pathIgnorePatterns` from bunfig.toml — what a bare `bun test` still skips. */
export function bunfigIgnorePatterns(): string[] {
  const path = join(REPO_ROOT, "bunfig.toml");
  if (!existsSync(path)) return [];
  const raw = readText(path).match(/pathIgnorePatterns\s*=\s*\[([^\]]*)\]/s)?.[1];
  if (raw === undefined) return [];
  return [...raw.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] ?? "").filter(Boolean);
}

function readPackageScripts(dir: string): Record<string, string> {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readText(path)) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

/**
 * Resolve one shell command into the scopes it executes, following
 * `bun run <script>` indirection through `package.json` (and `cd <dir> &&`
 * into a sub-package's own scripts).
 *
 * Throws `UnresolvableSuiteError` rather than returning nothing for a runner it
 * does not recognize: contributing an empty scope would over-report holes, and
 * silently skipping would under-report them. Both are worse than stopping.
 */
export function resolveCommandScopes(
  command: string,
  provenance: string,
  cwd = "",
  depth = 0
): SuiteScope[] {
  if (depth > 4) throw new UnresolvableSuiteError(`${provenance}: script indirection too deep`);

  const scopes: SuiteScope[] = [];
  // Join shell line-continuations first. `bun test --preload x \` + a newline +
  // the paths is how the integration workflow is written, and splitting on the
  // raw newline strands the paths in a segment that no longer looks like a
  // `bun test` invocation — so the suite reads as covering everything.
  const joined = command.replace(/\\\s*\n\s*/g, " ");
  for (const rawSegment of joined.split("\n")) {
    const segment = rawSegment.split("|")[0]?.trim() ?? "";
    if (segment === "") continue;

    let effectiveCwd = cwd;
    let body = segment;
    const cdMatch = body.match(/^cd\s+(\S+)\s*&&\s*(.+)$/);
    if (cdMatch?.[1] !== undefined && cdMatch[2] !== undefined) {
      effectiveCwd = normalizePath(join(effectiveCwd, cdMatch[1]));
      body = cdMatch[2];
    }

    const prefixIn = (paths: string[]): string[] =>
      effectiveCwd === "" ? paths : paths.map((p) => `${effectiveCwd}/${normalizePath(p)}`);

    const runMatch = body.match(/(?:^|&&\s*)bun\s+run\s+([\w:.-]+)/);
    if (runMatch?.[1] !== undefined) {
      const scriptName = runMatch[1];
      const scripts = readPackageScripts(join(REPO_ROOT, effectiveCwd));
      const target = scripts[scriptName];
      if (target === undefined) continue; // `bun run build`, `bun run lint`, … — not a suite
      scopes.push(
        ...resolveCommandScopes(target, `${provenance} -> ${scriptName}`, effectiveCwd, depth + 1)
      );
      continue;
    }

    const runnerMatch = body.match(/(?:^|&&\s*)bun\s+(scripts\/[\w.-]+\.ts)/);
    if (runnerMatch?.[1] !== undefined) {
      const runner = runnerMatch[1];
      const known = KNOWN_RUNNERS[runner];
      if (known === undefined) {
        if (CHANGE_SCOPED_RUNNERS[runner] !== undefined) continue;
        const runnerPath = join(REPO_ROOT, runner);
        if (!existsSync(runnerPath) || !invokesTests(readText(runnerPath))) {
          continue; // not a suite — a budget check, a catalog builder, this script
        }
        throw new UnresolvableSuiteError(
          `${provenance}: '${runner}' runs tests but is not in KNOWN_RUNNERS. Add it with the ` +
            `roots it walks — this check cannot report holes it cannot see.`
        );
      }
      scopes.push({
        suite: `${provenance} -> ${runner}`,
        roots: prefixIn(known.roots),
        excludePrefixes: prefixIn(known.excludePrefixes),
      });
      continue;
    }

    const parsed = parseBunTestCommand(body);
    if (parsed) {
      // No positional filter means "everything below cwd" — which is the whole
      // repo only when there was no `cd`. Dropping the cwd here would let
      // `cd services/reviewer && bun test` claim coverage of every file in the
      // repository, silently making this check vacuous.
      const roots =
        parsed.roots.length > 0
          ? prefixIn(parsed.roots)
          : effectiveCwd === ""
            ? []
            : [effectiveCwd];
      scopes.push({
        suite: provenance,
        roots,
        excludePrefixes: [
          ...prefixIn(parsed.ignores),
          // A bare repo-root `bun test` still skips whatever bunfig.toml prunes.
          ...(roots.length === 0 ? bunfigIgnorePatterns() : []),
        ],
      });
    }
  }
  return scopes;
}

/** Every `run:` command in a workflow that triggers on `pull_request`. */
export function extractPullRequestRunSteps(yaml: string): string[] {
  const onBlock = yaml.split(/^jobs:/m)[0] ?? "";
  if (!/^\s{2}pull_request:/m.test(onBlock)) return [];

  const commands: string[] = [];
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // The negative lookahead is load-bearing: without it `run: |` matches as an
    // INLINE command whose body is the literal `|`, and the block-scalar branch
    // below never runs — silently dropping every multi-line step, which is
    // where most of the suite invocations live.
    // The `- ` marker is optional because both YAML forms are valid and in use:
    // `- name: X` / `  run: cmd` across two lines, and `- run: cmd` on one.
    const inline = line.match(/^\s*(?:-\s+)?run:\s*(?![|>])(\S.*)$/);
    if (inline?.[1] !== undefined) {
      commands.push(inline[1]);
      continue;
    }
    if (!/^\s*(?:-\s+)?run:\s*[|>]-?\s*$/.test(line)) continue;
    const indent = (lines[i + 1]?.match(/^(\s*)/)?.[1] ?? "").length;
    if (indent === 0) continue;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (next.trim() !== "" && (next.match(/^(\s*)/)?.[1] ?? "").length < indent) break;
      block.push(next.trim());
    }
    commands.push(block.join("\n"));
  }
  return commands;
}

export function buildPullRequestScopes(workflowDir: string): SuiteScope[] {
  const scopes: SuiteScope[] = [];
  for (const file of readdirSync(workflowDir).sort()) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const yaml = readText(join(workflowDir, file));
    for (const command of extractPullRequestRunSteps(yaml)) {
      scopes.push(...resolveCommandScopes(command, file));
    }
  }
  return scopes;
}

export function trackedTestFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "*.test.ts", "*.test.tsx"], { cwd: REPO_ROOT });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).split("\n").filter(Boolean).sort();
}

function main(): never {
  const json = process.argv.includes("--json");

  const problems = validateAllowlist(REACHABILITY_ALLOWLIST);
  if (problems.length > 0) {
    console.error("Allowlist is invalid — every entry must record why the hole exists:");
    for (const p of problems) console.error(`  [${p.index}] '${p.prefix}': ${p.problem}`);
    process.exit(2);
  }

  let scopes: SuiteScope[];
  try {
    scopes = buildPullRequestScopes(join(REPO_ROOT, ".github/workflows"));
  } catch (error) {
    console.error(
      `test-reachability: could not resolve every PR-gating suite, so this run proves nothing.\n` +
        `  ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(2);
  }

  const files = trackedTestFiles();
  // A plausible non-zero denominator can still be a strict subset (mem#1079):
  // if discovery finds nothing, the comparison below is vacuously clean.
  if (files.length === 0) {
    console.error("test-reachability: found zero tracked test files — discovery is broken.");
    process.exit(2);
  }
  if (scopes.length === 0) {
    console.error("test-reachability: found zero PR-gating suites — workflow parsing is broken.");
    process.exit(2);
  }

  const result = compareReachability(files, scopes, REACHABILITY_ALLOWLIST);

  if (json) {
    console.log(
      JSON.stringify(
        {
          suites: scopes.map((s) => ({ suite: s.suite, roots: s.roots })),
          checked: files.length,
          unreached: result.unreached,
          allowlisted: result.allowlisted,
          unusedAllowlistPrefixes: result.unusedAllowlistPrefixes,
        },
        null,
        2
      )
    );
  } else {
    console.log(`Suites gating a PR: ${scopes.length}`);
    for (const scope of scopes) console.log(`  ${scope.suite}`);
    console.log(`\nTracked test files: ${files.length}`);
    console.log(`Reached: ${result.reachedBy.size}`);
    console.log(`Allowlisted (known holes): ${result.allowlisted.length}`);
    for (const file of result.allowlisted) console.log(`  ${file}`);
    if (result.unreached.length > 0) {
      console.error(`\nRUN BY NOTHING (${result.unreached.length}):`);
      for (const file of result.unreached) console.error(`  ${file}`);
      console.error(
        "\nEach file above is committed, reviewed, and executed by no PR-gating suite.\n" +
          "Either bring it into a suite, or add an allowlist entry recording WHY it is not run."
      );
    }
    if (result.unusedAllowlistPrefixes.length > 0) {
      console.error(`\nSTALE ALLOWLIST ENTRIES (${result.unusedAllowlistPrefixes.length}):`);
      for (const prefix of result.unusedAllowlistPrefixes) console.error(`  ${prefix}`);
      console.error("\nThese prefixes match no unreached file — the hole is closed; delete them.");
    }
  }

  const failed = result.unreached.length > 0 || result.unusedAllowlistPrefixes.length > 0;
  process.exit(failed ? 1 : 0);
}

// mem#1287: an unguarded main() runs on IMPORT, so the test file beside this
// one would execute the whole sweep — and exit the test process — as a side
// effect of importing a pure helper.
if (import.meta.main) {
  main();
}
