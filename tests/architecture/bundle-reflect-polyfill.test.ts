/**
 * Structural invariants that keep `dist/minsky.js` able to boot on its own (mt#3680).
 *
 * The defect these guard against: `src/cli.ts` used to carry `import "reflect-metadata"` directly.
 * That is correct ESM and does not survive bundling — reflect-metadata is CommonJS, so bun lowers
 * the import to a `var … = __toESM(require_Reflect(), 1)` declaration and emits it AFTER every ESM
 * `init_*()` statement in the same block. `init_config_setup()` reaches tsyringe, whose module body
 * ends in a `Reflect.getMetadata` guard, so the guard threw before the polyfill was ever required
 * and the bundle died at startup. Routing the import through `src/reflect-polyfill.ts` restores the
 * order, because a module's initialization is a statement and statements keep source order.
 *
 * What these tests CAN catch: a refactor that inlines the import back into `src/cli.ts`, reorders
 * it behind another import, adds a dependency to the shim that would drag more code into its eager
 * position, or re-adds a `--preload reflect-metadata` that would mask a regression by booting the
 * bundle either way.
 *
 * What they CANNOT catch: a bun version whose bundler orders things differently again, where every
 * assertion here still holds and the artifact still fails. That is behavioral, and its gate is
 * `.github/workflows/bundle-boot-smoke.yml`, which boots the built bundle bare — plus the two
 * cold-start smokes, which run it from a temp layout with no `node_modules`. Same division of
 * labor `tests/scripts/cli-entry.test.ts` documents for mt#3735's sibling import.
 *
 * The two text helpers below are themselves covered by fixture tests at the bottom of this file
 * (PR #2661 R1): they are hand-rolled parsers, and a parser that silently under-matches would make
 * every assertion above vacuously pass.
 */

import { describe, test, expect } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed sources under test (import ordering and invocation flags are properties of the committed files, not of injectable state); same exemption shape as tests/scripts/cli-entry.test.ts
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Comment syntax of the file being scanned. YAML and Dockerfiles use `#`; TS uses `//` + `/* *\/`. */
type CommentStyle = "ts" | "hash";

function read(relativePath: string): string {
  // The cast is Bun's stricter `readFileSync` overload typing, which widens the utf8 return to
  // `string | Buffer` — `scripts/cli-entry.ts`'s FsDeps docblock records the same friction.
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same exemption as the import above: these assertions ARE about the committed files, so there is no injectable state to fake
  return readFileSync(join(REPO_ROOT, relativePath), "utf8") as string;
}

/**
 * Remove comments so assertions see executable content only.
 *
 * Needed because every file checked here EXPLAINS the flag it must not USE — a raw substring scan
 * matches the explanation and fails on correct code, which is exactly what the first draft did.
 *
 * The `//` rule ignores a `//` preceded by `:` so that `http://` and `postgres://` inside string
 * literals survive. Known limit: a `//` or `#` inside a string literal in any other shape is still
 * treated as a comment start, which can only cause a false NEGATIVE (missing a flag that appears
 * after such a literal on the same line), never a false positive.
 */
function stripComments(source: string, style: CommentStyle): string {
  const withoutBlocks = style === "ts" ? source.replace(/\/\*[\s\S]*?\*\//g, "") : source;
  return withoutBlocks
    .split("\n")
    .map((line) =>
      style === "ts" ? line.replace(/(^|[^:])\/\/.*$/, "$1") : line.replace(/#.*$/, "")
    )
    .join("\n");
}

/** Lines that actually execute, comments and blank lines removed. */
function codeLines(source: string, style: CommentStyle): string[] {
  return stripComments(source, style)
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/**
 * Source-order list of every module specifier imported or re-exported for its RUNTIME effect.
 *
 * Type-only imports are excluded: TypeScript erases them, so they cannot affect evaluation order
 * and must not count as "an import before the polyfill" (PR #2661 R1).
 *
 * The `[^;]*?` between the keyword and `from` spans newlines but not statement boundaries, so
 * multi-line named imports are captured while `export const x = "…";` cannot reach forward to an
 * unrelated `from` later in the file.
 */
function importSpecifiers(source: string): string[] {
  const pattern = /^[ \t]*(?:import|export)\s+(?!type\b)(?:[^;]*?\bfrom\s*)?["']([^"']+)["']/gm;
  const specifiers: string[] = [];
  for (const match of stripComments(source, "ts").matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function bunVersionOf(workflowPath: string): string {
  const version = read(workflowPath).match(/bun-version:\s*"([^"]+)"/)?.[1];
  if (version === undefined) {
    // A workflow that stopped pinning Bun at all is the same failure this test guards against —
    // it would silently run on whatever the runner ships. Fail loudly rather than compare undefined.
    throw new Error(`No bun-version pin found in ${workflowPath}`);
  }
  return version;
}

describe("bundle reflect-metadata polyfill ordering (mt#3680)", () => {
  test("src/cli.ts imports the polyfill shim before anything else", () => {
    const specifiers = importSpecifiers(read("src/cli.ts"));

    expect(specifiers.length).toBeGreaterThan(1);
    expect(specifiers[0]).toBe("./reflect-polyfill");
  });

  test("src/cli.ts does not import reflect-metadata directly", () => {
    // A direct import here is the exact shape that does not survive bundling. It would also look
    // harmless — and would keep `bun src/cli.ts` working — which is why it needs an assertion.
    expect(importSpecifiers(read("src/cli.ts"))).not.toContain("reflect-metadata");
  });

  test("the polyfill shim imports reflect-metadata and nothing else", () => {
    // The shim is emitted eagerly, ahead of the configuration setup `src/cli.ts` deliberately runs
    // first. Anything else imported here would be hoisted into that same position.
    expect(importSpecifiers(read("src/reflect-polyfill.ts"))).toEqual(["reflect-metadata"]);
  });

  test("the Dockerfile CMD invokes the bundle without a preload", () => {
    const cmdLine = codeLines(read("Dockerfile"), "hash").find((line) => line.startsWith("CMD "));

    expect(cmdLine).toBeDefined();
    expect(cmdLine).toContain("dist/minsky.js");
    expect(cmdLine).not.toContain("--preload");
  });

  test("the bundle-boot smoke boots the bundle bare, so a regression is visible", () => {
    // A preloaded invocation boots whether or not the bundle is self-sufficient, so re-adding the
    // flag here would silently retire the gate rather than strengthen it.
    const bootLine = codeLines(read(".github/workflows/bundle-boot-smoke.yml"), "hash").find(
      (line) => line.includes("bun run") && line.includes("dist/minsky.js")
    );

    expect(bootLine).toBeDefined();
    expect(bootLine).not.toContain("--preload");
  });

  test("the cold-start smokes run the bundle with no preload", () => {
    // These spawn the bundle from a temp installed layout with no `node_modules` — the closest
    // thing in CI to a real standalone install, and the reason mt#3680 existed.
    for (const script of [
      "scripts/smoke-cold-start-hooks.ts",
      "scripts/smoke-cold-start-cockpit-web.ts",
      "scripts/smoke-cold-start-migrate.ts",
      "scripts/benchmark-cold-boot.ts",
    ]) {
      const offenders = codeLines(read(script), "ts").filter((line) => line.includes("--preload"));
      expect(offenders).toEqual([]);
    }
  });

  test("no workflow invokes the bundle with a preload (mt#3773)", () => {
    // mt#3680's own enumerating sweep was truncated with `head -20` and missed
    // `.github/workflows/deploy-minsky-mcp.yml`, whose migration step ran the bundle preloaded —
    // making the one command that touches the production schema the one that never exercised the
    // real boot path. This asserts over EVERY workflow rather than a named list, so the next site
    // added cannot escape the same way.
    const workflowDir = join(REPO_ROOT, ".github", "workflows");
    // eslint-disable-next-line custom/no-real-fs-in-tests -- enumerating the committed workflow set IS the assertion; a hardcoded list is exactly the truncation this test exists to prevent
    const workflows = readdirSync(workflowDir).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml")
    );

    // Guards against a vacuous pass without depending on how MANY workflows exist (PR #2716 R1):
    // a count threshold would break on legitimate consolidation, which has nothing to do with the
    // invariant. Naming a workflow that must be present is the same protection without the
    // repository-shape coupling — and bundle-boot-smoke.yml is the one that would have to survive
    // for this whole family of checks to still mean anything.
    expect(workflows).toContain("bundle-boot-smoke.yml");

    const offenders = workflows.flatMap((file) =>
      codeLines(read(join(".github", "workflows", file)), "hash")
        .filter((line) => line.includes("dist/minsky.js") && line.includes("--preload"))
        .map((line) => `${file}: ${line.trim()}`)
    );

    expect(offenders).toEqual([]);
  });

  test("the cold-start workflows run on the same Bun version as the bundle-boot smoke", () => {
    // Both were pinned back to 1.2.21 to hide this defect. A stale pin makes them green against a
    // runtime nothing else uses, which is indistinguishable from a passing gate.
    const reference = bunVersionOf(".github/workflows/bundle-boot-smoke.yml");

    expect(reference).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bunVersionOf(".github/workflows/cold-start-hooks.yml")).toBe(reference);
    expect(bunVersionOf(".github/workflows/cold-start-cockpit-web.yml")).toBe(reference);
  });
});

describe("text helpers (PR #2661 R1)", () => {
  /** The line each fixture expects to survive: a side-effect-only import of a local module. */
  const POLYFILL_IMPORT = 'import "./polyfill";';

  test("importSpecifiers captures a multi-line named import in source order", () => {
    const source = ['import "./polyfill";', "import {", "  a,", "  b,", '} from "./dep";'].join(
      "\n"
    );

    expect(importSpecifiers(source)).toEqual(["./polyfill", "./dep"]);
  });

  test("importSpecifiers ignores type-only imports and exports", () => {
    // Erased at runtime, so they cannot affect evaluation order — counting them would fail the
    // first-import assertion for a change that is provably harmless.
    const source = [
      'import type { Foo } from "./types";',
      'export type { Bar } from "./other-types";',
      POLYFILL_IMPORT,
    ].join("\n");

    expect(importSpecifiers(source)).toEqual(["./polyfill"]);
  });

  test("importSpecifiers does not let a non-import statement reach a later `from`", () => {
    const source = ['export const label = "hello";', 'import { x } from "./dep";'].join("\n");

    expect(importSpecifiers(source)).toEqual(["./dep"]);
  });

  test("importSpecifiers ignores specifiers mentioned only in comments", () => {
    const source = [
      "/**",
      ' * Historically this file did `import "reflect-metadata"` directly.',
      " */",
      '// import "./stale";',
      POLYFILL_IMPORT,
    ].join("\n");

    expect(importSpecifiers(source)).toEqual(["./polyfill"]);
  });

  test("codeLines drops block-comment terminators and interior lines", () => {
    const source = ["/*", " * uses --preload for a reason", " */", 'run("--flag");'].join("\n");

    expect(codeLines(source, "ts")).toEqual(['run("--flag");']);
  });

  test("codeLines strips an inline comment but keeps the code before it", () => {
    expect(codeLines('run("--flag"); // avoid --preload here', "ts")).toEqual(['run("--flag"); ']);
    expect(codeLines("CMD bun run dist/minsky.js # no --preload", "hash")).toEqual([
      "CMD bun run dist/minsky.js ",
    ]);
  });

  test("codeLines keeps a URL that contains a double slash", () => {
    // `postgres://` and `http://` appear in real invocation lines; treating them as comment starts
    // would truncate the line and could hide a flag that follows.
    expect(codeLines('connect("postgres://host/db", "--preload");', "ts")).toEqual([
      'connect("postgres://host/db", "--preload");',
    ]);
  });
});
