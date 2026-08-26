/**
 * Call-time env-var name wiring (mt#4619).
 *
 * `config.ts`'s `REVIEWER_CALLTIME_ENV_VAR_NAMES` claims to be the single place
 * those names are written down. mt#4619 makes that true. Two drift directions
 * have to be closed, and only one of them is a type:
 *
 *  - **A reader naming an entry the registry does not have** is a compile
 *    error, because readers index a property of an `as const` object. Asserted
 *    by the `@ts-expect-error` case below, which ALSO fails the build if the
 *    object ever loses `as const` (an unused directive is itself an error).
 *  - **An entry nothing reads** is invisible to the compiler — nothing can
 *    require a call site to EXIST — so the source scan below covers it. That is
 *    the only reason this file reads source text.
 *
 * The scan asks whether each KEY is referenced anywhere under `src/`, not where
 * or in what shape. That is deliberately looser than mt#4578's sibling
 * (`recovery-flag-wiring.test.ts`), which scanned a single file for a specific
 * call shape and drew a NON-BLOCKING reviewer note for being brittle to
 * formatting. Here a reference through an alias
 * (`config-arm.ts`'s `EXPERIMENT_MODEL_ENV_VAR`), a destructure, or a wrapped
 * call all satisfy it — the property name is what is being looked for, and the
 * property name is already compile-checked at every site that uses it.
 */

/* eslint-disable custom/no-real-fs-in-tests -- the orphan-entry direction is a
 * question about the REAL source tree and only the real one. An in-memory fake
 * would assert against a fixture whose author already believed the wiring was
 * right, which is exactly the staleness this catches: the failure mode is "a
 * name was declared and nothing ever read it", and a fixture cannot drift the
 * way the tree can. Same justification and same shape as
 * `.minsky/hooks/hook-module-inventory.test.ts` — a committed registry measured
 * against the tree it describes. */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEWER_CALLTIME_ENV_VAR_NAMES } from "./config";

const SRC_DIR = import.meta.dir;
/** The declaring file — the one place a literal name is expected to appear. */
const DECLARING_FILE = "config.ts";
/** This file: it names keys, so it must not count as a reader of them. */
const THIS_FILE = "calltime-env-var-wiring.test.ts";

const REGISTRY_KEYS = Object.keys(REVIEWER_CALLTIME_ENV_VAR_NAMES);
const REGISTRY_VALUES = Object.values(REVIEWER_CALLTIME_ENV_VAR_NAMES);

/**
 * Strip comments before scanning (PR #3391 R1, NON-BLOCKING — and confirmed
 * live rather than accepted on description).
 *
 * The scan looks for a key name in source text, and this change's own docblocks
 * NAME the keys in prose — `providers.ts` says "the TOOLLOOP_RETRY_TIMEOUT_MS
 * entry in config.ts's registry". So a comment alone satisfied the consumption
 * check: deleting the real `process.env[...TOOLLOOP_RETRY_TIMEOUT_MS]` read and
 * leaving the docblock kept all 10 tests green. A genuine orphan was maskable
 * by the very prose this task added.
 *
 * The mt#4619 orphan control did not reach it, because the bogus key it added
 * appeared in no comment anywhere — a control proves the probe can fail for the
 * ONE case reverted, never that it covers the defect class.
 *
 * Over-stripping is the safe direction: it can only HIDE a real reference,
 * which fails the consumption test loudly. Under-stripping hides an orphan,
 * silently — which is the failure being fixed.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every `.ts` under `src/`, recursively, as `[relativePath, code-without-comments]`. */
function readSourceTree(): Array<[string, string]> {
  return readdirSync(SRC_DIR, { recursive: true })
    .map(String)
    .filter((p) => p.endsWith(".ts"))
    .map((p) => [p, stripComments(readFileSync(join(SRC_DIR, p), "utf8"))] as [string, string]);
}

const TREE = readSourceTree();

describe("call-time env-var registry — every declared name is read (SC3)", () => {
  test("the tree scan actually found source files", () => {
    // Without this, an empty read (wrong dir, changed API) would make every
    // "no literal survives" assertion below pass vacuously — the scan would be
    // reporting on nothing. Same class of failure the scan exists to catch.
    expect(TREE.length).toBeGreaterThan(50);
    expect(TREE.some(([p]) => p === DECLARING_FILE)).toBe(true);
  });

  test.each(REGISTRY_KEYS)("%s is referenced by some reader under src/", (key) => {
    const readers = TREE.filter(
      ([path, src]) => path !== DECLARING_FILE && path !== THIS_FILE && src.includes(key)
    );
    expect(readers.length).toBeGreaterThan(0);
  });

  test("a key named only in a comment is not a reader (PR #3391 R1)", () => {
    // Regression test for the hole the reviewer found: this change's own
    // docblocks name the keys, so before stripping, prose alone satisfied the
    // consumption check and a real orphan could hide behind it.
    const key = String(REGISTRY_KEYS[0]);
    const proseOnly = `/**\n * mentions ${key} in a block comment\n */\n// and ${key} again\nconst unrelated = 1;`;
    expect(stripComments(proseOnly).includes(key)).toBe(false);
    // The other direction matters just as much: stripping must not eat real
    // code, or every key would read as an orphan and the suite would go red for
    // the wrong reason.
    expect(stripComments(`const v = REGISTRY.${key};`).includes(key)).toBe(true);
  });

  test("a key nothing references is not found — the scan can fail", () => {
    // Negative control for the scan itself. A predicate that matched everything
    // (or a tree read that returned every file's full text under any query)
    // would report every key as consumed without ever discriminating.
    const readers = TREE.filter(
      ([path, src]) =>
        path !== DECLARING_FILE && path !== THIS_FILE && src.includes("A_KEY_NOBODY_DECLARED")
    );
    expect(readers).toHaveLength(0);
  });
});

describe("call-time env-var registry — no reader spells the literal (SC1)", () => {
  test.each(REGISTRY_VALUES)("%s appears only in the declaring file", (envVar) => {
    const offenders = TREE.filter(
      ([path, src]) => path !== DECLARING_FILE && path !== THIS_FILE && src.includes(envVar)
    ).map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe("call-time env-var registry — shape", () => {
  test("keys and values are distinct and non-empty", () => {
    expect(REGISTRY_KEYS.length).toBeGreaterThan(0);
    expect(new Set(REGISTRY_VALUES).size).toBe(REGISTRY_VALUES.length);
    for (const value of REGISTRY_VALUES) expect(value.length).toBeGreaterThan(0);
  });

  test("an entry outside the declared set does not compile, and is undefined if forced", () => {
    // The compile-time half of SC2, asserted as a test so it cannot rot. If the
    // registry ever loses `as const` — or gains an index signature — indexing an
    // undeclared property stops erroring and typecheck fails here on the now-
    // unused directive rather than silently letting a typo read no env var.
    const registry = REVIEWER_CALLTIME_ENV_VAR_NAMES;
    // @ts-expect-error NOT_A_DECLARED_ENTRY is not a key of the registry
    const forced: string | undefined = registry.NOT_A_DECLARED_ENTRY;
    // Paired runtime assertion (a bare @ts-expect-error asserts nothing at run
    // time): the forced lookup is undefined, which is why a typo'd property
    // would read no env var at all rather than the intended one.
    expect(forced).toBeUndefined();
  });
});
