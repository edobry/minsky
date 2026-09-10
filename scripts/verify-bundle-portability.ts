#!/usr/bin/env bun
/**
 * mt#5063 — the published bundle must not be hard-coded to the machine that built it.
 *
 * ## The defect this exists to catch
 *
 * `bun build` replaces `__dirname` in bundled CommonJS modules with a STRING LITERAL captured
 * at build time. For a module that resolves a runtime asset relative to `__dirname`, that
 * silently pins the lookup to the builder's filesystem. Measured on the published
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
 * ## What this checks, and why an allowlist rather than a ban
 *
 * A baked `__dirname` is not intrinsically a defect: it only breaks when the module USES it to
 * find something at runtime. Banning all of them would fail on four packages whose reachability
 * is unestablished, which would make this check unshippable and therefore useless.
 *
 * So it is a REGISTRY, not a ban. Every baked `__dirname` in the bundle must appear in
 * {@link KNOWN_BAKED_DIRNAMES} with a recorded disposition. A package that starts baking one —
 * or tiktoken RETURNING to the bundle after being externalised — fails here, at build time,
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

/**
 * Packages whose baked `__dirname` is known and dispositioned.
 *
 * Adding an entry is a DECISION, not a formality: it asserts that this package either does not
 * resolve a runtime asset through `__dirname`, or that the consequence has been accepted. Record
 * which, so the next reader inherits a judgement rather than a name on a list.
 */
const KNOWN_BAKED_DIRNAMES: ReadonlyArray<{ pkg: string; disposition: string }> = [
  {
    pkg: "typescript/lib",
    disposition:
      "Transitive (declared in neither dependencies nor devDependencies), so it CANNOT be " +
      "externalised the way tiktoken was — an external import of a package that may not be " +
      "installed fails at the point of use instead of at build. TypeScript resolves its " +
      "`lib.*.d.ts` files relative to __dirname, so this could fire; reachability from the CLI " +
      "is UNESTABLISHED, not ruled out. Tracked at mt#5067.",
  },
  {
    pkg: "rollup/dist",
    disposition:
      "Transitive; same externalisation constraint as typescript. Its baked __dirname sits " +
      "beside native-binary/platform detection, so it could fire. Reachability UNESTABLISHED. " +
      "Tracked at mt#5067.",
  },
  {
    pkg: "esbuild/lib",
    disposition:
      "Transitive; same constraint. esbuild resolves its platform BINARY relative to __dirname, " +
      "which is the most likely of the four to fire if reached. Reachability UNESTABLISHED. " +
      "Tracked at mt#5067.",
  },
  {
    pkg: "@pnpm/tabtab/lib",
    disposition:
      "Transitive; same constraint. Drives shell-completion install and reads its own lib paths. " +
      "Reachability UNESTABLISHED. Tracked at mt#5067.",
  },
];

/** Matches `__dirname="<abs path>"` as bun emits it, capturing the path. */
const BAKED_DIRNAME = /__dirname\s*=\s*"([^"]+)"/g;

/**
 * The package a baked path belongs to — everything after the last `node_modules/`.
 *
 * Returns null for a path with no `node_modules` segment, which is not a package bake and is
 * left to the caller to report as unknown rather than silently dropped.
 */
export function packageOfBakedPath(absPath: string): string | null {
  const marker = "node_modules/";
  const at = absPath.lastIndexOf(marker);
  if (at === -1) return null;
  return absPath.slice(at + marker.length);
}

export interface PortabilityFinding {
  readonly path: string;
  readonly pkg: string | null;
}

/** Pure over the bundle text, so the whole check is testable without a build. */
export function auditBundle(source: string): {
  total: number;
  findings: PortabilityFinding[];
} {
  const known = new Set(KNOWN_BAKED_DIRNAMES.map((e) => e.pkg));
  const findings: PortabilityFinding[] = [];
  let total = 0;

  for (const match of source.matchAll(BAKED_DIRNAME)) {
    const absPath = match[1];
    if (absPath === undefined) continue;
    total += 1;
    const pkg = packageOfBakedPath(absPath);
    if (pkg === null || !known.has(pkg)) findings.push({ path: absPath, pkg });
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
      `[verify-bundle-portability] FAIL — ${findings.length} of ${total} baked \`__dirname\` ` +
        `value(s) are not registered in KNOWN_BAKED_DIRNAMES:`
    );
    for (const f of findings) {
      console.error(`  - ${f.pkg ?? "(no node_modules segment)"}\n      ${f.path}`);
    }
    console.error(
      `\n  A baked \`__dirname\` pins a runtime lookup to the machine that built the bundle.\n` +
        `  If the package resolves an asset through it, the published CLI breaks for every user.\n` +
        `  Either mark the package \`--external\` in package.json's \`build\` script (only safe for a\n` +
        `  DECLARED dependency), or add it to KNOWN_BAKED_DIRNAMES with a recorded disposition.`
    );
    process.exit(1);
  }

  console.log(
    `[verify-bundle-portability] OK — all ${total} baked \`__dirname\` value(s) are registered; ` +
      `no package pins a runtime lookup to the build host unreviewed.`
  );
}

if (import.meta.main) main();
