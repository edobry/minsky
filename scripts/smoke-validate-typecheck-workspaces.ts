#!/usr/bin/env bun
/**
 * Smoke / acceptance verification for mt#2256 — `validate.typecheck` multi-workspace coverage.
 *
 * Exercises the registered `validate.typecheck` command end-to-end against the live repo,
 * proving the three acceptance tests from the spec:
 *
 *   AT-1: A `noUncheckedIndexedAccess`-flavored error injected into a `services/reviewer`
 *         source file is flagged by a DEFAULT run (no `workspace` arg) and attributed to
 *         `services/reviewer` — whereas an explicit root-only run (`workspace: "."`) does NOT
 *         see it (the prior, root-only behavior).
 *   AT-2: A DEFAULT run on a clean tree returns 0 errors across all covered workspaces
 *         (and the covered set includes both "." and "services/reviewer").
 *   AT-3: An explicit `workspace: "services/reviewer"` run still works (backward-compatible
 *         single-workspace path) and catches the injected error.
 *
 * Run from the repo root:
 *   bun scripts/smoke-validate-typecheck-workspaces.ts
 *
 * Env: none required beyond a populated `node_modules` (the `tsgo` checker binary). When the
 * checker binary is absent the script SKIPs (exit 0) rather than failing.
 *
 * Exit code: 0 = pass (or skip), non-zero = fail.
 */

import { existsSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { registerValidateCommands } from "../src/adapters/shared/commands/validate";
import { sharedCommandRegistry } from "../src/adapters/shared/command-registry";
import { resolveTsgoBinary } from "../src/utils/tsgo-binary";

const ROOT = process.cwd();
const PROBE_REL = "services/reviewer/src/__mt2256_probe.ts";
const PROBE_ABS = join(ROOT, PROBE_REL);

// A snippet that only errors under `noUncheckedIndexedAccess` (services/reviewer's tsconfig
// enables it). `arr[0]` is `string | undefined`; assigning to `string` is the TS2322 error.
const PROBE_SRC = [
  "const arr: string[] = [];",
  "const x: string = arr[0];",
  "export const probeLen = x.length;",
  "",
].join("\n");

// mt#3183: the two standalone root-level tsconfig PROJECTS (as opposed to sub-workspaces).
// The root tsconfig excludes "scripts" outright and never includes ".claude/hooks", so a probe
// in either tree is invisible to the root check — which is exactly what makes these clean
// negative controls: if a default run flags them, it can only be because the standalone-project
// pass ran.
const SCRIPTS_PROBE_REL = "scripts/__mt3183_probe.ts";
const SCRIPTS_PROBE_ABS = join(ROOT, SCRIPTS_PROBE_REL);
const HOOKS_PROBE_REL = ".claude/hooks/__mt3183_probe.ts";
const HOOKS_PROBE_ABS = join(ROOT, HOOKS_PROBE_REL);

// Plain TS2322 — errors under any strict config, so the probe proves the PROJECT was checked
// rather than depending on a project-specific compiler option.
const STANDALONE_PROBE_SRC = [
  'const n: number = "not a number";',
  "export const probeN = n;",
  "",
].join("\n");

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  try {
    rmSync(PROBE_ABS, { force: true });
    rmSync(SCRIPTS_PROBE_ABS, { force: true });
    rmSync(HOOKS_PROBE_ABS, { force: true });
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, "services/reviewer/tsconfig.json"))) {
    console.log("SKIP: services/reviewer/tsconfig.json not found (not the minsky repo root?)");
    process.exit(0);
  }
  // Gate on exactly what the runner resolves. This used to gate on the PACKAGE directory,
  // deliberately, because the runner invoked `bunx @typescript/native-preview` and a layout
  // where bunx resolved the package without a preinstalled `.bin/tsgo` would have falsely
  // SKIPped. mt#3657 inverted that: the runner now spawns `node_modules/.bin/tsgo` and never
  // consults bunx, so gating on the package directory is the shape that would falsely
  // proceed — the smoke would fail on a missing binary instead of skipping on a missing
  // install. Sharing the runner's own resolver keeps the two from drifting apart again.
  const checker = resolveTsgoBinary(ROOT);
  if (checker.kind === "missing") {
    console.log(`SKIP: ${checker.message}`);
    process.exit(0);
  }

  registerValidateCommands();
  const cmd = sharedCommandRegistry.getCommand("validate.typecheck");
  if (!cmd) {
    fail("validate.typecheck command not registered");
  }

  // Helper: invoke the command with optional explicit workspace. The execute impl ignores
  // the context argument, so an empty object is sufficient.
  const run = async (
    workspace?: string
  ): Promise<{
    success: boolean;
    errorCount: number;
    errors: Array<{ workspace: string; file: string; code: string }>;
    workspaces: string[];
    checkerVersion: string | null;
    pinnedCheckerVersion: string | null;
  }> => {
    const params = workspace ? { workspace } : {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await cmd.execute(params as any, {} as any)) as any;
  };

  // --- AT-2: clean-tree default run ---
  cleanup(); // ensure no stale probe
  const clean = await run();
  console.log(
    `AT-2 clean default run: workspaces=${JSON.stringify(clean.workspaces)} errorCount=${clean.errorCount}`
  );
  if (!clean.workspaces.includes(".")) {
    fail('AT-2: default run did not check the root workspace (".")');
  }
  if (!clean.workspaces.includes("services/reviewer")) {
    fail(
      "AT-2: default run did not discover services/reviewer (missing typecheck-script discovery)"
    );
  }
  if (!clean.success || clean.errorCount !== 0) {
    fail(`AT-2: clean tree reported ${clean.errorCount} error(s): ${JSON.stringify(clean.errors)}`);
  }

  // --- Inject the reviewer-only error ---
  writeFileSync(PROBE_ABS, PROBE_SRC, "utf8");

  // --- AT-1 (positive): default run catches it and attributes to services/reviewer ---
  const withErr = await run();
  const reviewerErrors = withErr.errors.filter((e) => e.workspace === "services/reviewer");
  console.log(
    `AT-1 default run with probe: errorCount=${withErr.errorCount} reviewerErrors=${reviewerErrors.length}`
  );
  if (withErr.success || reviewerErrors.length === 0) {
    fail("AT-1: default run did not flag the injected services/reviewer error");
  }
  const probeHit = reviewerErrors.find((e) => e.file.includes("__mt2256_probe"));
  if (!probeHit) {
    fail("AT-1: injected probe file not present among services/reviewer errors");
  }

  // --- AT-1 (negative): explicit root-only run does NOT see it ---
  const rootOnly = await run(".");
  const rootSawProbe = rootOnly.errors.some((e) => e.file.includes("__mt2256_probe"));
  console.log(
    `AT-1 explicit root-only run: errorCount=${rootOnly.errorCount} sawProbe=${rootSawProbe}`
  );
  if (rootSawProbe) {
    fail("AT-1: explicit root-only run unexpectedly flagged the services/reviewer error");
  }

  // --- AT-3: explicit single-workspace run catches it (backward-compatible path) ---
  const single = await run("services/reviewer");
  const singleSawProbe = single.errors.some((e) => e.file.includes("__mt2256_probe"));
  console.log(
    `AT-3 explicit services/reviewer run: errorCount=${single.errorCount} sawProbe=${singleSawProbe} workspaces=${JSON.stringify(single.workspaces)}`
  );
  if (single.success || !singleSawProbe) {
    fail("AT-3: explicit services/reviewer run did not flag the injected error");
  }

  // --- mt#3183: standalone root-level tsconfig projects ---
  cleanup(); // drop the mt#2256 probe so the counts below are unambiguous

  const projects = await run();
  console.log(`mt#3183 covered projects: ${JSON.stringify(projects.workspaces)}`);
  for (const project of ["tsconfig.scripts.json", "tsconfig.hooks.json"]) {
    if (!projects.workspaces.includes(project)) {
      fail(`mt#3183: default run did not cover ${project} (standalone-project discovery missing)`);
    }
  }
  // The cockpit project is declared BOTH as a direct check and as a `typecheck:cockpit-web`
  // script; it must appear exactly once, or its errors would be reported twice.
  const cockpitEntries = projects.workspaces.filter(
    (w) => w === "src/cockpit/web" || w === "src/cockpit/web/tsconfig.json"
  );
  if (cockpitEntries.length !== 1) {
    fail(
      `mt#3183: cockpit project checked ${cockpitEntries.length} times, expected exactly 1 (dedupe failed): ${JSON.stringify(projects.workspaces)}`
    );
  }
  if (!projects.success || projects.errorCount !== 0) {
    fail(
      `mt#3183: clean tree reported ${projects.errorCount} error(s): ${JSON.stringify(projects.errors)}`
    );
  }

  writeFileSync(SCRIPTS_PROBE_ABS, STANDALONE_PROBE_SRC, "utf8");
  writeFileSync(HOOKS_PROBE_ABS, STANDALONE_PROBE_SRC, "utf8");
  const withStandaloneErrs = await run();
  const scriptsHit = withStandaloneErrs.errors.find(
    (e) => e.workspace === "tsconfig.scripts.json" && e.file.includes("__mt3183_probe")
  );
  const hooksHit = withStandaloneErrs.errors.find(
    (e) => e.workspace === "tsconfig.hooks.json" && e.file.includes("__mt3183_probe")
  );
  console.log(
    `mt#3183 default run with probes: errorCount=${withStandaloneErrs.errorCount} scriptsHit=${Boolean(scriptsHit)} hooksHit=${Boolean(hooksHit)}`
  );
  if (!scriptsHit) {
    fail(
      `mt#3183: default run did not flag the injected scripts/ error under tsconfig.scripts.json. Errors seen: ${JSON.stringify(withStandaloneErrs.errors)}`
    );
  }
  if (!hooksHit) {
    fail(
      `mt#3183: default run did not flag the injected .claude/hooks/ error under tsconfig.hooks.json. Errors seen: ${JSON.stringify(withStandaloneErrs.errors)}`
    );
  }

  // Negative control: the ROOT project must NOT see either probe — proving the hits above came
  // from the standalone pass and not from the root check widening.
  const rootOnlyStandalone = await run(".");
  const rootLeaks = rootOnlyStandalone.errors.filter((e) => e.file.includes("__mt3183_probe"));
  if (rootLeaks.length > 0) {
    fail(
      `mt#3183: explicit root-only run unexpectedly flagged a standalone-project probe: ${JSON.stringify(rootLeaks)}`
    );
  }

  cleanup();

  // --- mt#3657: the checker is pinned, reported, and deterministic across runs ---
  //
  // These three assertions are the spec's own acceptance tests. They belong here rather than
  // in a unit test because each is a claim about the REAL install: which binary got spawned,
  // what version it reports, and whether two consecutive runs of the actual command agree.
  const runA = await run();
  const runB = await run();

  console.log(
    `mt#3657 checker: ran=${runA.checkerVersion} pinned=${runA.pinnedCheckerVersion} ` +
      `(second run: ran=${runB.checkerVersion})`
  );

  if (!runA.checkerVersion) {
    fail("mt#3657: the result did not report the checker version that ran");
  }
  if (!runA.pinnedCheckerVersion) {
    fail("mt#3657: the result did not report the pinned checker version");
  }
  // THE invariant. For three months this was false and nothing said so: `bunx` fetched
  // `@latest` while package.json declared a version months older.
  if (runA.checkerVersion !== runA.pinnedCheckerVersion) {
    fail(
      `mt#3657: the checker that RAN (${runA.checkerVersion}) is not the one this repo PINS ` +
        `(${runA.pinnedCheckerVersion}) — the drift this task exists to remove`
    );
  }
  // Two consecutive runs on an unchanged tree must agree, including on the projects checked.
  // The `bunx` path could not promise this: each invocation re-resolved `@latest` on its own.
  if (
    runA.errorCount !== runB.errorCount ||
    JSON.stringify(runA.workspaces) !== JSON.stringify(runB.workspaces) ||
    runA.checkerVersion !== runB.checkerVersion
  ) {
    fail(
      `mt#3657: two runs on an unchanged tree disagreed — ` +
        `A=${JSON.stringify({ e: runA.errorCount, w: runA.workspaces, v: runA.checkerVersion })} ` +
        `B=${JSON.stringify({ e: runB.errorCount, w: runB.workspaces, v: runB.checkerVersion })}`
    );
  }

  console.log(
    "PASS: AT-1, AT-2, AT-3, the mt#3183 standalone-project coverage, and mt#3657's " +
      "pinned/reported/deterministic checker all verified."
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
