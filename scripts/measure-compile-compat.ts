#!/usr/bin/env bun
/**
 * `bun build --compile` compatibility characterization for the minsky CLI (mt#1729).
 *
 * Answers, reproducibly, the mt#1729 investigation questions against the CURRENT bun
 * version and the CURRENT `src/cli.ts` shape — so the verdict can be re-validated when bun
 * updates (the ESM+bytecode restriction below is explicitly "eventually" per bun, so this
 * script is also a REGRESSION probe: when bun lifts it, variant C will start passing and this
 * script's expectation flips, signalling the investigation should be revisited).
 *
 * ## What it checks (three `bun build --compile` variants + a run)
 *
 *   A. `--compile --target=bun`                    -> EXPECT SUCCESS (ESM, no bytecode)
 *   B. `--compile --bytecode --target=bun`         -> EXPECT FAIL (bytecode defaults to CJS;
 *                                                     cli.ts top-level await is CJS-incompatible)
 *   C. `--compile --bytecode --format=esm ...`     -> EXPECT FAIL ("format must be 'cjs' when
 *                                                     bytecode is true. Eventually ... esm")
 *   Run A's binary: `<bin> --version`              -> EXPECT "1.0.0" (dynamic imports resolve;
 *                                                     no persistence touched by --version)
 *
 * ## Findings (bun 1.2.21, 2026-07-22 — see mt#1729 spec `## Findings` for the full write-up)
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
 * ## Usage
 *
 *   bun scripts/measure-compile-compat.ts
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

const ENTRY = "src/cli.ts";

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
    failSubstring: "await",
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

function main(): number {
  const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout?.trim();
  console.log(`bun ${bunVersion} — mt#1729 --compile compatibility characterization\n`);

  let allOk = true;
  for (const v of VARIANTS) {
    const { ok, detail } = runBuild(v);
    allOk = allOk && ok;
    console.log(`  [${ok ? "OK" : "DIVERGED"}] ${v.name}: ${detail}`);
  }

  // Run variant A's binary — confirms literal dynamic imports resolve in a standalone binary.
  const aBin = join(OUT_DIR, "a");
  if (existsSync(aBin)) {
    const r = spawnSync(aBin, ["--version"], { encoding: "utf8" });
    const version = (r.stdout ?? "").trim();
    const runOk = r.status === 0 && /^\d+\.\d+\.\d+$/.test(version);
    allOk = allOk && runOk;
    console.log(
      `  [${runOk ? "OK" : "DIVERGED"}] A binary runs: '<bin> --version' -> "${version}" (dynamic imports resolve)`
    );
  }

  rmSync(OUT_DIR, { recursive: true, force: true });

  console.log(
    `\nVerdict: --compile (ESM) is compatible; --compile --bytecode is BLOCKED by cli.ts` +
      ` top-level await (bytecode requires CJS). ${allOk ? "MATCHES recorded finding." : "DIVERGED — revisit mt#1729."}`
  );
  return allOk ? 0 : 1;
}

process.exit(main());
