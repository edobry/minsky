#!/usr/bin/env bun
/**
 * `bun build --compile` compatibility characterization for the minsky CLI (mt#1729).
 *
 * Answers, reproducibly, the mt#1729 investigation questions against the CURRENT bun
 * version and the CURRENT `src/cli.ts` shape — so the verdict can be re-validated when bun
 * updates (the ESM+bytecode restriction below is explicitly "eventually" per bun, so this
 * script is also a REGRESSION probe: when bun lifts it, variant C starts passing and this
 * script's expectation flips, signalling the investigation should be revisited).
 *
 * ## What it checks (three `bun build --compile` variants + two runtime probes)
 *
 *   A. `--compile --target=bun`                    -> EXPECT SUCCESS (ESM, no bytecode)
 *   B. `--compile --bytecode --target=bun`         -> EXPECT FAIL (bytecode defaults to CJS;
 *                                                     cli.ts top-level await is CJS-incompatible)
 *   C. `--compile --bytecode --format=esm ...`     -> EXPECT FAIL ("format must be 'cjs' when
 *                                                     bytecode is true. Eventually ... esm")
 *   Run 1: `<A-bin> --version`   -> EXPECT a version. `--version` sets `needsAll=true` in cli.ts
 *          (src/cli.ts ~L144-150), which force-runs EVERY lazy command-group `await import(...)`
 *          (mcp/github/context/lint/init/setup/compile/cockpit/completions/ops) — so this is the
 *          MOST comprehensive dynamic-import probe, not the weakest.
 *   Run 2: `<A-bin> tasks --help` -> EXPECT exit 0. `tasks` comes from the unconditionally-loaded
 *          shared-command registry (`registerAllSharedCommands`, src/cli.ts ~L132-134); rendering
 *          its help proves that dynamically-imported command group loaded AND registered a real
 *          handler in the standalone binary. Hermetic (no DB / network).
 *
 * Full handler EXECUTION through a lazy import (`tasks list` hitting the prod DB) was verified
 * manually during the mt#1729 investigation and recorded in the spec `## Findings`; it is kept out
 * of this repeatedly-run script so re-running the probe never touches prod.
 *
 * ## Findings (bun 1.2.21, 2026-07-22 — full write-up in the mt#1729 spec `## Findings`)
 *
 * - The lazy-load shape mt#1719 introduced uses only LITERAL dynamic-import specifiers
 *   (`await import("./commands/mcp/index")` etc.), which `--compile` resolves fine — so the
 *   dynamic-import shape is NOT the blocker.
 * - The blocker is the `--bytecode` -> CJS -> no-top-level-await chain: `src/cli.ts` has a
 *   top-level `await setupConfiguration()`, and bytecode requires CJS.
 * - `--compile` alone measured ~-60ms vs the minified `dist/minsky.js` bundle (708 vs 768ms
 *   `--version` median, n=12) — a modest win consistent with mt#3006's EVAL-bound finding
 *   (the ~850ms bundle+init layer is dominated by module eval, which neither `--compile` nor
 *   `--bytecode` addresses).
 *
 * ## Recommendation (see mt#1729 spec for the full version)
 *
 * Defer `--compile` adoption to Profile D (end-user single-binary distribution) only; pursue the
 * eval lever (mt#1816) for cold-boot instead. `--bytecode` stays blocked until `src/cli.ts`'s
 * top-level await is refactored into an async `main()`.
 *
 * ## Usage
 *
 *   bun scripts/measure-compile-compat.ts        # runnable from any CWD
 *
 * Exit 0 if bun's behavior matches the recorded verdict; non-zero if it diverged (e.g. bun
 * lifted the ESM+bytecode restriction, or cli.ts no longer trips it) — a divergence means the
 * mt#1729 recommendation should be re-examined.
 *
 * @see mt#1729 — this task
 * @see mt#3006 — the minified-bundle sibling (eval-bound finding this corroborates)
 * @see https://bun.sh/docs/bundler/executables — vendor docs (note: claims ESM+bytecode
 *   support that bun 1.2.21 does NOT yet honor)
 * @see https://github.com/oven-sh/bun/issues/13405 — import.meta.url-under-compile gotcha
 */

import { spawnSync } from "child_process";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// Absolute entry path — resolved relative to THIS script's location (repo root = ../ from
// scripts/), so the characterization is runnable from any working directory (reviewer NB: the
// prior version assumed repo-root CWD). bun resolves node_modules/tsconfig from the entry's
// directory, so an absolute entry is CWD-independent.
const REPO_ROOT = join(import.meta.dir, "..");
const ENTRY = join(REPO_ROOT, "src", "cli.ts");

interface BuildVariant {
  name: string;
  args: string[];
  expect: "success" | "fail";
  /** substring expected in stderr when expect==="fail" (documents the exact blocker) */
  failSubstring?: string;
}

const OUT_DIR = mkdtempSync(join(tmpdir(), "mt1729-compile-"));

const VARIANTS: BuildVariant[] = [
  {
    name: "A: --compile (ESM, no bytecode)",
    args: ["build", "--compile", "--target=bun", `--outfile=${join(OUT_DIR, "a")}`, ENTRY],
    expect: "success",
  },
  {
    name: "B: --compile --bytecode (defaults to CJS)",
    args: [
      "build",
      "--compile",
      "--bytecode",
      "--target=bun",
      `--outfile=${join(OUT_DIR, "b")}`,
      ENTRY,
    ],
    expect: "fail",
    // Specific Bun diagnostic for top-level await under CJS — NOT the bare token "await", which
    // could match unrelated errors and let a changed failure mode slip through as a false "OK".
    failSubstring: 'can only be used inside an "async" function',
  },
  {
    name: "C: --compile --bytecode --format=esm",
    args: [
      "build",
      "--compile",
      "--bytecode",
      "--format=esm",
      "--target=bun",
      `--outfile=${join(OUT_DIR, "c")}`,
      ENTRY,
    ],
    expect: "fail",
    failSubstring: "format must be 'cjs' when bytecode is true",
  },
];

function runBuild(v: BuildVariant): { ok: boolean; detail: string } {
  const r = spawnSync("bun", v.args, { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const succeeded = r.status === 0;
  if (v.expect === "success") {
    return succeeded
      ? { ok: true, detail: "built" }
      : {
          ok: false,
          detail: `expected SUCCESS but build failed: ${safeTruncate(out.trim(), 200)}`,
        };
  }
  // expect fail
  const hasSubstring = v.failSubstring ? out.includes(v.failSubstring) : true;
  if (succeeded) {
    return {
      ok: false,
      detail: `expected FAIL (bun may have lifted the restriction — revisit mt#1729) but build SUCCEEDED`,
    };
  }
  return hasSubstring
    ? { ok: true, detail: `failed as expected ("${v.failSubstring}")` }
    : {
        ok: false,
        detail: `failed, but NOT with the expected message "${v.failSubstring}": ${safeTruncate(
          out.trim(),
          200
        )}`,
      };
}

/** Run a hermetic probe against the compiled binary; ok when exit 0 (and, if given, output matches). */
function runProbe(
  bin: string,
  argv: string[],
  label: string,
  outputOk?: (stdout: string) => boolean
): { ok: boolean; detail: string } {
  const r = spawnSync(bin, argv, { encoding: "utf8" });
  const stdout = (r.stdout ?? "").trim();
  const exitOk = r.status === 0;
  const matchOk = outputOk ? outputOk(stdout) : true;
  return {
    ok: exitOk && matchOk,
    detail: `${label}: exit=${r.status}${outputOk ? ` output=${JSON.stringify(safeTruncate(stdout, 40))}` : ""}`,
  };
}

function main(): number {
  const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout?.trim();
  console.log(`bun ${bunVersion} — mt#1729 --compile compatibility characterization\n`);

  let allOk = true;
  const report = (ok: boolean, msg: string) => {
    allOk = allOk && ok;
    console.log(`  [${ok ? "OK" : "DIVERGED"}] ${msg}`);
  };

  for (const v of VARIANTS) {
    const { ok, detail } = runBuild(v);
    report(ok, `${v.name}: ${detail}`);
  }

  // Runtime probes against variant A's binary — confirm literal dynamic imports resolve AND a
  // real command group registered, in a standalone binary. Both hermetic (no DB / network).
  const aBin = join(OUT_DIR, "a");
  if (existsSync(aBin)) {
    // `--version` force-loads every lazy command-group import (needsAll=true) — see header.
    const v1 = runProbe(aBin, ["--version"], "A binary '--version' (loads all lazy imports)", (s) =>
      // Loose semver (accepts pre-release suffixes like 1.0.0-beta); prior /^d.d.d$/ was brittle.
      /^\d+\.\d+\.\d+/.test(s)
    );
    report(v1.ok, v1.detail);
    // `tasks --help` renders a real handler's help from the unconditionally-loaded shared registry.
    const v2 = runProbe(aBin, ["tasks", "--help"], "A binary 'tasks --help' (handler registered)");
    report(v2.ok, v2.detail);
  } else {
    report(false, "variant A binary missing — cannot run runtime probes");
  }

  rmSync(OUT_DIR, { recursive: true, force: true });

  console.log(
    `\nVerdict: --compile (ESM) is compatible; --compile --bytecode is BLOCKED by cli.ts` +
      ` top-level await (bytecode requires CJS). ${allOk ? "MATCHES recorded finding." : "DIVERGED — revisit mt#1729."}`
  );
  return allOk ? 0 : 1;
}

process.exit(main());
