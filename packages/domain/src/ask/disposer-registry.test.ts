/**
 * Census + shape enforcement for the disposer registry (mt#5046).
 *
 * Two distinct jobs, and conflating them is how a census goes vacuous:
 *
 *   - **Shape (SC1)** — every registration declares the review triple. Pure over the constant.
 *   - **Census (SC2)** — every disposal site in the ask tree is registered or exempted. Measured
 *     against the REAL tree, because the failure this exists to catch is "a new disposal path
 *     merged and nobody enrolled it", and a fixture tree cannot merge anything.
 *
 * The acceptance tests run the same `findUnregisteredDisposalSites` over synthetic input, so the
 * scan is exercised in both directions: a site that must be reported, and one that must not.
 * Without the synthetic half, a green real-tree run is equally consistent with "the tree is
 * clean" and "the scanner finds nothing" (mem#704).
 */

/* eslint-disable custom/no-real-fs-in-tests -- the census's whole purpose is measuring the REAL
 * `packages/domain/src/ask/` tree against a committed registry. An in-memory fake would assert
 * the registry against a fixture its own author wrote, which is precisely the drift this test
 * exists to catch. Same justification as `hook-module-inventory.test.ts`. */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISPOSER_REGISTRY,
  DISPOSED_STATES,
  NON_DISPOSER_TERMINAL_WRITERS,
  MACHINE_FILED_SQL_PREDICATE,
  findUnregisteredDisposalSites,
  isDisposalSite,
  hasReviewTriple,
  type CensusFile,
  type DisposerRegistration,
} from "./disposer-registry";

// `fileURLToPath` rather than `new URL(...).pathname` — the latter leaves percent escapes
// encoded and mangles drive-letter paths.
const ASK_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(ASK_DIR, "..", "..", "..", "..");

/** Every non-test `.ts` under the ask tree, recursively, as repo-relative paths. */
function askTreeFiles(dir: string = ASK_DIR): CensusFile[] {
  const out: CensusFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...askTreeFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    out.push({
      file: relative(REPO_ROOT, full).split("\\").join("/"),
      content: readFileSync(full, "utf-8"),
    });
  }
  return out;
}

describe("mt#5046 SC1 — every disposer declares the review triple", () => {
  test.each(DISPOSER_REGISTRY.map((d) => [d.id, d] as [string, DisposerRegistration]))(
    "%s declares an event stream, a population query and a cadence",
    (_id, entry) => {
      expect(hasReviewTriple(entry)).toBe(true);
    }
  );

  test("an unemitted stream must STATE the gap rather than leave it blank", () => {
    // The registry's honest encoding: three of four disposers emit nothing today. A null
    // eventType is legal only when it carries the reason, so "not instrumented" is a finding a
    // reader sees rather than an omission they have to notice.
    for (const entry of DISPOSER_REGISTRY) {
      if (entry.eventStream.eventType === null) {
        expect(entry.eventStream.gap ?? "").not.toBe("");
      }
    }
  });

  test("a registration missing its population query FAILS the triple", () => {
    // The AT's negative direction: the shape check must be capable of rejecting.
    const incomplete = {
      ...DISPOSER_REGISTRY[0],
      populationQuery: { sql: "", separates: [] },
    } as DisposerRegistration;
    expect(hasReviewTriple(incomplete)).toBe(false);
  });

  test("every population query separates the two ask populations", () => {
    // A rate over the pooled population describes neither: measured 2026-09-10, 1,713
    // machine-filed against 10 agent-authored, so pooling overstates one by ~170x.
    for (const entry of DISPOSER_REGISTRY) {
      expect(entry.populationQuery.separates.length).toBeGreaterThanOrEqual(2);
      expect(entry.populationQuery.sql).toContain(MACHINE_FILED_SQL_PREDICATE);
    }
  });
});

describe("mt#5046 SC1 — registrations point at code that exists", () => {
  // The registry is hand-maintained prose about the tree, so it can be wrong in the one way
  // prose always is. Both symbol names in the first draft of this registry were wrong
  // (`closeStaleSuspendedAsks` / `closeAsResolved` against the real
  // `runStaleSuspendedAskCloseSweep` / `closeAskAsResolved`); nothing but this test would have
  // caught it, because an unused string cannot fail to compile.
  test.each(DISPOSER_REGISTRY.map((d) => [d.id, d] as [string, DisposerRegistration]))(
    "%s names a real file and a symbol inside it",
    (_id, entry) => {
      const abs = join(REPO_ROOT, entry.file);
      expect(existsSync(abs)).toBe(true);
      expect(readFileSync(abs, "utf-8")).toContain(entry.symbol);
    }
  );

  test("every exempted file exists and carries a non-empty reason", () => {
    for (const [file, reason] of Object.entries(NON_DISPOSER_TERMINAL_WRITERS)) {
      expect(existsSync(join(REPO_ROOT, file))).toBe(true);
      expect(reason.trim()).not.toBe("");
    }
  });
});

describe("mt#5046 SC2 — census over the real ask tree", () => {
  test("every disposal site is registered or explicitly exempted", () => {
    // The failure message names the file, so a merged-but-unenrolled disposer is actionable
    // from the test output alone.
    expect(findUnregisteredDisposalSites(askTreeFiles())).toEqual([]);
  });

  test("the census denominator is non-empty — the scan can actually see the tree", () => {
    // Guards the vacuous pass: if the walker returned nothing, the assertion above would be
    // trivially true forever. This is the shape `verify-hook-root-resolution.ts` treats as
    // exit-2 rather than success.
    const files = askTreeFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => isDisposalSite(f.content)).length).toBeGreaterThanOrEqual(
      DISPOSER_REGISTRY.length
    );
  });

  test("every registered disposer is FOUND by the scan it is registered against", () => {
    // The registry and the census must agree in both directions. An entry the scanner cannot
    // see is an entry the census does not enforce — which is exactly how the policy router sat
    // unenrolled: keying on `router.ts` (which writes no terminal state and calls no write
    // primitive) would have registered it and censused nothing.
    const byFile = new Map(askTreeFiles().map((f) => [f.file, f.content]));
    for (const entry of DISPOSER_REGISTRY) {
      const content = byFile.get(entry.file);
      expect(content).toBeDefined();
      expect(isDisposalSite(content ?? "")).toBe(true);
    }
  });
});

describe("mt#5046 SC2 — the census can fail (acceptance tests)", () => {
  test("a synthetic disposal site with no registry entry is REPORTED, by name", () => {
    const synthetic: CensusFile[] = [
      {
        file: "packages/domain/src/ask/rogue-disposer.ts",
        content: 'await repo.transition(id, "cancelled");',
      },
    ];
    expect(findUnregisteredDisposalSites(synthetic)).toEqual([
      "packages/domain/src/ask/rogue-disposer.ts",
    ]);
  });

  test("the same site is silent once its file is registered", () => {
    // Uses a file the registry already carries, so this asserts the registration lookup rather
    // than re-asserting the scanner.
    const first = DISPOSER_REGISTRY[0];
    if (!first) throw new Error("expected a registered disposer");
    const synthetic: CensusFile[] = [{ file: first.file, content: 'state: "closed"' }];
    expect(findUnregisteredDisposalSites(synthetic)).toEqual([]);
  });

  test("an exempted file is silent, and a non-disposal file is never reported at all", () => {
    const exempted = Object.keys(NON_DISPOSER_TERMINAL_WRITERS)[0];
    if (!exempted) throw new Error("expected an exempted writer");
    const synthetic: CensusFile[] = [
      { file: exempted, content: 'state: "closed"' },
      { file: "packages/domain/src/ask/pure-helper.ts", content: "export const x = 1;" },
    ];
    expect(findUnregisteredDisposalSites(synthetic)).toEqual([]);
  });

  test.each([...DISPOSED_STATES])("a %s literal alone is enough to be censused", (state) => {
    // All three terminal states, not just `closed` — `cancelled` and `expired` dispose of an
    // operator-bound ask exactly as finally.
    expect(isDisposalSite(`return { ...ask, state: "${state}" };`)).toBe(true);
  });

  test("a write through a repository primitive is censused even with no state literal", () => {
    // The case a literal-only scan misses, and the reason `DISPOSAL_WRITE_CALLS` exists: three
    // of the four registered disposers never write the literal.
    expect(isDisposalSite("await repo.persistRouteOutcome(ask.id, write);")).toBe(true);
    expect(isDisposalSite("const n = 1;")).toBe(false);
  });
});
