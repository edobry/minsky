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

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  try {
    rmSync(PROBE_ABS, { force: true });
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, "services/reviewer/tsconfig.json"))) {
    console.log("SKIP: services/reviewer/tsconfig.json not found (not the minsky repo root?)");
    process.exit(0);
  }
  if (!existsSync(join(ROOT, "node_modules/.bin/tsgo"))) {
    console.log("SKIP: tsgo checker binary not installed (run `bun install` first)");
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

  cleanup();
  console.log("PASS: AT-1, AT-2, AT-3 all verified.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
