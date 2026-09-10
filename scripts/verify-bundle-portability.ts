#!/usr/bin/env bun
/**
 * mt#5063 — the published bundle must not be hard-coded to the machine that built it.
 *
 * ## The defect this exists to catch
 *
 * `bun build` replaces `__dirname` and `__filename` in bundled CommonJS modules with a STRING
 * LITERAL captured at build time. For a module that resolves a runtime asset relative to either,
 * that silently pins the lookup to the builder's filesystem. Measured on the published
 * `@edobry/minsky@0.2.0`:
 *
 *     var __dirname="/home/runner/work/minsky/minsky/node_modules/tiktoken"
 *
 * `/home/runner/work/…` is the GitHub Actions runner. tiktoken reads `tiktoken_bg.wasm` via
 * `fs.readFileSync` against `__dirname` and an ancestor walk rooted at it, so EVERY candidate
 * lived under a tree that exists only on CI. The result: `minsky --help` exited 1 with
 * `Missing tiktoken_bg.wasm` for every user — the first command a new user runs.
 *
 * **Why nothing caught it.** Contributors run `bun run src/cli.ts`, CI builds from the checkout,
 * and `bundle-boot-smoke` builds its own bundle and boots `mcp start --http` — a path that never
 * touches the tokenizer. The npm tarball is the one artifact nobody exercised, and it is the only
 * one a new user touches (the same blind spot mt#5013 named one layer out).
 *
 * ## The class is CJS-only, and bun offers no switch for it (mt#5067)
 *
 * Only CommonJS modules get the literal: bun's CJS→ESM wrapper injects
 * `var __dirname="…"` / `var __filename="…"` per module, while first-party ESM `__dirname`
 * is left as a runtime global (upstream's own observation on oven-sh/bun#10604: "This works if
 * we import an ES Module instead"). There is NO bundler-level setting that stops it — this is
 * oven-sh/bun#4216, open and labelled `confirmed bug` (read 2026-09-10; #10604 and #12509 were
 * closed as its duplicates). The thread's `--define "__dirname=import.meta.dir"` workaround was
 * retracted by its own author: it substitutes the string literal `"import.meta.dir"`. So this
 * registry is the permanent shape until that issue closes, not a stopgap — and the only real
 * fixes are `--external` for a DECLARED dependency, or not reaching the code path at all.
 *
 * `__filename` matters as much as `__dirname`: typescript's `getDefaultLibFilePath` walks from
 * `sys.getExecutingFilePath()`, which is `__filename`, so a check that only read `__dirname`
 * (this file until mt#5067) would have passed a bundle that still pins that lookup.
 *
 * ## What this checks, and why an allowlist rather than a ban
 *
 * A baked path is not intrinsically a defect: it only breaks when the module USES it to find
 * something at runtime. Banning all of them would fail on packages whose reachability has been
 * ruled on, which would make this check unshippable and therefore useless.
 *
 * So it is a REGISTRY, not a ban. Every baked `__dirname` or `__filename` in the bundle must
 * appear in {@link KNOWN_BAKED_PATHS} with a recorded disposition. A package that starts baking
 * one — or tiktoken RETURNING to the bundle after being externalised — fails here, at build time,
 * instead of on a user's first command.
 *
 * The check is deliberately keyed on the PACKAGE, not on the absolute path: the baked value is
 * the builder's own path, so it differs between CI and a developer machine and cannot be matched
 * literally. A prior draft of this file grepped for `/home/runner/` and would have passed on
 * every local build while failing only on CI — the inverse of useful.
 *
 * Exit 0 = every baked entry is known. Exit 1 = an unregistered one appeared (the finding).
 * Exit 2 = the check could not run — never conflated with a pass.
 *
 * Usage: `bun scripts/verify-bundle-portability.ts [path/to/minsky.js]`
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** Default bundle location, matching `package.json`'s `build` script `--outdir`. */
const DEFAULT_BUNDLE = join(process.cwd(), "dist", "minsky.js");

/** The two identifiers bun bakes into a bundled CJS module. */
export type BakedIdentifier = "__dirname" | "__filename";

/**
 * Packages whose baked `__dirname` / `__filename` is known and dispositioned.
 *
 * Adding an entry is a DECISION, not a formality: it asserts that this package either does not
 * resolve a runtime asset through the baked value, or that the consequence has been accepted.
 * Record which, so the next reader inherits a judgement rather than a name on a list. `pkg` is
 * the path AFTER the last `node_modules/` segment, exactly as {@link packageOfBakedPath} returns
 * it — a directory for a `__dirname` bake, a file for a `__filename` bake.
 */
const KNOWN_BAKED_PATHS: ReadonlyArray<{ pkg: string; disposition: string }> = [
  {
    pkg: "braintrust/dist/index.mjs",
    disposition:
      "ACCEPTED — label only. braintrust's sole use is " +
      '`typeof __filename !== "undefined" ? __filename : "unknown"` (dist/index.mjs, one ' +
      "occurrence; zero __dirname), a diagnostic string that names the module. Nothing is " +
      "resolved through it, so a wrong value cannot change behaviour. Ruled 2026-09-10, mt#5067.",
  },
];

/**
 * Packages that WERE baked and have been ruled on by REMOVAL rather than registration
 * (mt#5063, mt#5067). None may reappear: a bake from any of these is a regression of a
 * decided fix, so it is deliberately NOT in {@link KNOWN_BAKED_PATHS} and fails this check.
 *
 * - `tiktoken` — `--external` (declared dependency). Resolved `tiktoken_bg.wasm` through
 *   `__dirname`; the published 0.2.0 broke `minsky --help` on it. mt#5063.
 * - `@pnpm/tabtab` — `--external` (declared dependency). mt#5063 R2.
 * - `typescript` — `--external` (declared REQUIRED peer, 5.8.3). Reachable via
 *   `context generate --components error-context` → `ts.createProgram`, whose default-lib
 *   lookup walks from the baked `__filename`. Measured from a packed tarball with the CI
 *   build path substituted: the component fails identically on the checkout and the install
 *   today because it throws earlier (`getPreEmitDiagnostics` on a SourceFile foreign to the
 *   program — a separate defect, tracked at mt#5084), so the bake is MASKED, not harmless.
 *   External, the consumer's own typescript — lib files included — is what runs. mt#5067.
 * - `esbuild`, `rollup` — gone by externalising their only importer, `vite` (a devDependency
 *   reached solely via `cockpit start --dev`). Measured from a packed tarball: that command
 *   exits 1 with "Dev mode requires a source checkout" BEFORE the dynamic `import("vite")`,
 *   so neither bake was reachable from an installed layout; the externalisation removes them
 *   rather than merely ruling them unreachable. mt#5067.
 */
export const RETIRED_BAKES: ReadonlyArray<string> = [
  "tiktoken",
  "@pnpm/tabtab/lib",
  "typescript/lib",
  "typescript/lib/typescript.js",
  "esbuild/lib",
  "esbuild/lib/main.js",
  "rollup/dist",
];

/**
 * Matches `__dirname = <quoted abs path>` or `__filename = <quoted abs path>` as bun emits it,
 * capturing the identifier and the path.
 *
 * Accepts DOUBLE, SINGLE and BACKTICK quoting (PR #3706 R1). Minified output is a bundler's
 * choice, not a contract: bun emits double quotes today, and a matcher that silently sees
 * nothing if that changes is the failure mode this whole file argues against — a check that
 * cannot fail. The backreference keeps the closing quote matched to the opening one, so an
 * apostrophe inside a double-quoted path does not truncate the capture.
 */
const BAKED_PATH = /(__dirname|__filename)\s*=\s*(["'`])((?:(?!\2).)+)\2/g;

/**
 * The package a baked path belongs to — everything after the last `node_modules` segment.
 *
 * Backslash separators are normalised first (PR #3706 R1): a Windows-built bundle bakes
 * `C:\…\node_modules\tiktoken`, and a `/`-only matcher would return null for it — reported as
 * "no node_modules segment" rather than as `tiktoken`, which would let the exact regression
 * this file guards through on that platform.
 *
 * Returns null for a path with genuinely no `node_modules` segment. That is NOT silently
 * dropped: `auditBundle` reports it as an unknown finding, because an unrecognised SHAPE must
 * not read as clean.
 */
export function packageOfBakedPath(absPath: string): string | null {
  const normalised = absPath.replace(/\\/g, "/");
  const marker = "node_modules/";
  const at = normalised.lastIndexOf(marker);
  if (at === -1) return null;
  return normalised.slice(at + marker.length);
}

export interface PortabilityFinding {
  readonly identifier: BakedIdentifier;
  readonly path: string;
  readonly pkg: string | null;
}

/** Pure over the bundle text, so the whole check is testable without a build. */
export function auditBundle(source: string): {
  total: number;
  findings: PortabilityFinding[];
} {
  const known = new Set(KNOWN_BAKED_PATHS.map((e) => e.pkg));
  const findings: PortabilityFinding[] = [];
  let total = 0;

  for (const match of source.matchAll(BAKED_PATH)) {
    // Group 1: the identifier. Group 3: the path — group 2 is the quote the backreference pins.
    const identifier = match[1] as BakedIdentifier | undefined;
    const absPath = match[3];
    if (identifier === undefined || absPath === undefined) continue;
    total += 1;
    const pkg = packageOfBakedPath(absPath);
    if (pkg === null || !known.has(pkg)) findings.push({ identifier, path: absPath, pkg });
  }

  return { total, findings };
}

function main(): void {
  const bundlePath = process.argv[2] ?? DEFAULT_BUNDLE;

  if (!existsSync(bundlePath)) {
    // Exit 2, never 0: "no bundle to check" and "checked, clean" are different findings, and a
    // check that passes when the artifact is absent is the can't-fail probe this file argues against.
    console.error(
      `[verify-bundle-portability] CANNOT CHECK — no bundle at ${bundlePath}. ` +
        `Run \`bun run build\` first, or pass the path explicitly.`
    );
    process.exit(2);
  }

  let source: string;
  try {
    source = readFileSync(bundlePath, "utf-8");
  } catch (err) {
    console.error(
      `[verify-bundle-portability] CANNOT CHECK — cannot read ${bundlePath}: ${String(err)}`
    );
    process.exit(2);
  }

  const { total, findings } = auditBundle(source);

  if (findings.length > 0) {
    console.error(
      `[verify-bundle-portability] FAIL — ${findings.length} of ${total} baked \`__dirname\` / ` +
        `\`__filename\` value(s) are not registered in KNOWN_BAKED_PATHS:`
    );
    for (const f of findings) {
      console.error(
        `  - ${f.identifier}  ${f.pkg ?? "(no node_modules segment)"}\n      ${f.path}`
      );
    }
    console.error(
      `\n  A baked \`__dirname\` or \`__filename\` pins a runtime lookup to the machine that built the bundle.\n` +
        `  If the package resolves an asset through it, the published CLI breaks for every user.\n` +
        `  Either mark the package \`--external\` in package.json's \`build\` script (only safe for a\n` +
        `  DECLARED dependency), or add it to KNOWN_BAKED_PATHS with a recorded disposition.`
    );
    process.exit(1);
  }

  console.log(
    `[verify-bundle-portability] OK — all ${total} baked \`__dirname\` / \`__filename\` value(s) ` +
      `are registered; no package pins a runtime lookup to the build host unreviewed.`
  );
}

if (import.meta.main) main();
