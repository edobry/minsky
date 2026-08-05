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
 */

import { describe, test, expect } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed sources under test (import ordering and invocation flags are properties of the committed files, not of injectable state); same exemption shape as tests/scripts/cli-entry.test.ts
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function read(relativePath: string): string {
  // The cast is Bun's stricter `readFileSync` overload typing, which widens the utf8 return to
  // `string | Buffer` — `scripts/cli-entry.ts`'s FsDeps docblock records the same friction.
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same exemption as the import above: these assertions ARE about the committed files, so there is no injectable state to fake
  return readFileSync(join(REPO_ROOT, relativePath), "utf8") as string;
}

/**
 * Lines that actually execute — comments stripped.
 *
 * Every file checked here EXPLAINS the flag it must not USE, so a raw substring scan matches the
 * explanation and fails on correct code. Covers `//`, `/* … *\/` continuation lines, and the `#`
 * form used by YAML and the Dockerfile.
 */
function codeLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return false;
    return !(
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    );
  });
}

/** Source-order list of every `import ...` / `export ... from` specifier in a module. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*(?:import|export)\b[^;]*?["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
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
    const cmdLine = read("Dockerfile")
      .split("\n")
      .find((line) => line.startsWith("CMD "));

    expect(cmdLine).toBeDefined();
    expect(cmdLine).toContain("dist/minsky.js");
    expect(cmdLine).not.toContain("--preload");
  });

  test("the bundle-boot smoke boots the bundle bare, so a regression is visible", () => {
    // A preloaded invocation boots whether or not the bundle is self-sufficient, so re-adding the
    // flag here would silently retire the gate rather than strengthen it.
    const bootLine = read(".github/workflows/bundle-boot-smoke.yml")
      .split("\n")
      .find((line) => line.includes("setsid bun run") && line.includes("dist/minsky.js"));

    expect(bootLine).toBeDefined();
    expect(bootLine).not.toContain("--preload");
  });

  test("the cold-start smokes run the bundle with no preload", () => {
    // These two spawn the bundle from a temp installed layout with no `node_modules` — the closest
    // thing in CI to a real standalone install, and the reason mt#3680 existed.
    for (const script of [
      "scripts/smoke-cold-start-hooks.ts",
      "scripts/smoke-cold-start-cockpit-web.ts",
      "scripts/smoke-cold-start-migrate.ts",
      "scripts/benchmark-cold-boot.ts",
    ]) {
      const offenders = codeLines(read(script)).filter((line) => line.includes("--preload"));
      expect(offenders).toEqual([]);
    }
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

function bunVersionOf(workflowPath: string): string {
  const version = read(workflowPath).match(/bun-version:\s*"([^"]+)"/)?.[1];
  if (version === undefined) {
    // A workflow that stopped pinning Bun at all is the same failure this test guards against —
    // it would silently run on whatever the runner ships. Fail loudly rather than compare undefined.
    throw new Error(`No bun-version pin found in ${workflowPath}`);
  }
  return version;
}
