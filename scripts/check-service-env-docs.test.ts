/**
 * The env-var/DEPLOY.md census, and the extractors it rests on (mt#1566).
 *
 * Two halves, deliberately separated:
 *
 *  - **Extractor unit tests** run against inline fixtures. They are where the
 *    three read patterns are pinned, and they can fail for a reason you can read.
 *  - **The census** runs against the REAL `services/` tree, which is the only
 *    thing that can answer "is a newly-added env var documented". A fixture
 *    cannot drift the way the tree can — the same justification as
 *    `.minsky/hooks/hook-module-inventory.test.ts`.
 */

import { describe, test, expect } from "bun:test";
import {
  extractDirectReads,
  extractHelperReads,
  extractRegistryNames,
  extractEnvNames,
  stripComments,
  auditAll,
  loadGrandfather,
  ENV_HELPER_NAMES,
} from "./check-service-env-docs";

/**
 * The grandfather list MAY ONLY SHRINK.
 *
 * This ceiling is the mechanism: raising it is a visible, deliberate edit that a
 * reviewer sees, where growing a JSON list quietly is not. Lower it as mt#4990
 * documents vars; never raise it. If a new service legitimately needs a large
 * exemption, that is a decision worth arguing for in a PR, which is exactly what
 * having to edit this number forces.
 */
const GRANDFATHER_CEILING = 37; // 2026-09-04, all `reviewer`. Burn-down: mt#4990.

describe("extractors — the three read patterns", () => {
  test('pattern 1: process.env.X and process.env["X"]', () => {
    const code = `const a = process.env.MINSKY_ALPHA; const b = process.env["MINSKY_BETA"];`;
    expect(extractDirectReads(code).sort()).toEqual(["MINSKY_ALPHA", "MINSKY_BETA"]);
  });

  test("pattern 2: the config helper family", () => {
    const code = `
      const p = requireEnv("REVIEWER_PROVIDER");
      const m = optionalEnv("REVIEWER_MODEL", "gpt-5");
      const t = parsePositiveIntEnv("REVIEWER_MODEL_TIMEOUT_MS", 120_000);
    `;
    expect(extractHelperReads(code).sort()).toEqual([
      "REVIEWER_MODEL",
      "REVIEWER_MODEL_TIMEOUT_MS",
      "REVIEWER_PROVIDER",
    ]);
  });

  test("pattern 2 covers every helper the module declares", () => {
    // Guards the list itself: adding a helper to ENV_HELPER_NAMES without the
    // regex picking it up would silently narrow coverage.
    for (const helper of ENV_HELPER_NAMES) {
      expect(extractHelperReads(`${helper}("MINSKY_PROBE_VALUE")`)).toEqual(["MINSKY_PROBE_VALUE"]);
    }
  });

  test("pattern 3: names inside a *_ENV_VARS / *_ENV_VAR_NAMES registry", () => {
    const code = `
      export const RECOVERY_FLAG_ENV_VARS = [
        ["composition_convergence", "REVIEWER_COMPOSITION_CONVERGENCE_ENABLED"],
      ] as const;
      export const REVIEWER_CALLTIME_ENV_VAR_NAMES = {
        TOOLLOOP_RETRY_ON_TIMEOUT: "REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT",
      } as const;
    `;
    const found = extractRegistryNames(code);
    expect(found).toContain("REVIEWER_COMPOSITION_CONVERGENCE_ENABLED");
    expect(found).toContain("REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT");
  });

  test("pattern 3 stops at its own declaration — a later literal is not swept in", () => {
    // The bracket-depth walk is the reason this is not one regex. Without it a
    // greedy match would run to the last bracket in the file and absorb every
    // SCREAMING_SNAKE literal after it, reporting names nothing reads.
    const code = `
      const SOME_ENV_VARS = ["MINSKY_INSIDE"] as const;
      const somethingElse = { label: "MINSKY_OUTSIDE" };
    `;
    const found = extractRegistryNames(code);
    expect(found).toContain("MINSKY_INSIDE");
    expect(found).not.toContain("MINSKY_OUTSIDE");
  });

  test("a name mentioned only in a comment is not a read", () => {
    // Otherwise this file's own prose, and every docblock naming a var, would
    // register as a read — and worse, would make an unread var look read.
    const code = `
      /** mentions MINSKY_ONLY_PROSE in a block comment */
      // and MINSKY_ONLY_PROSE again
      const real = process.env.MINSKY_REAL_READ;
    `;
    expect(stripComments(code)).not.toContain("MINSKY_ONLY_PROSE");
    expect(extractEnvNames(code)).toEqual(["MINSKY_REAL_READ"]);
  });

  test("stripComments preserves line numbering (PR #3638 R1, BLOCKING)", () => {
    // The reported `file:line` is computed on the stripped source, so a strip
    // that collapses a block comment shifts every line after it. Measured drift
    // before the fix was 231 lines on services/reviewer/src/server.ts — a
    // location that points at unrelated code while looking authoritative.
    const code = [
      "const before = 1;",
      "/*",
      " * three",
      " * lines",
      " */",
      "const after = 2;",
    ].join("\n");
    const stripped = stripComments(code);
    expect(stripped.split("\n").length).toBe(code.split("\n").length);
    // And the name still lands on its real line.
    expect(stripped.split("\n").findIndex((l) => l.includes("after"))).toBe(5);
  });

  test("a brace inside a string literal does not close a registry early", () => {
    // The bracket walk is string-aware (PR #3638 R1, NON-BLOCKING). Without it
    // the `}` in the first value ends the scan and MINSKY_SECOND is never seen —
    // a silent under-read, which is this check's worst failure direction.
    const code = `const TRICKY_ENV_VARS = { a: "MINSKY_FIRST_}", b: "MINSKY_SECOND" } as const;`;
    const found = extractRegistryNames(code);
    expect(found).toContain("MINSKY_SECOND");
  });

  test("extractEnvNames unions all three patterns", () => {
    const code = `
      const DEMO_ENV_VARS = ["MINSKY_FROM_REGISTRY"] as const;
      const a = process.env.MINSKY_FROM_DIRECT;
      const b = requireEnv("MINSKY_FROM_HELPER");
    `;
    expect([...new Set(extractEnvNames(code))].sort()).toEqual([
      "MINSKY_FROM_DIRECT",
      "MINSKY_FROM_HELPER",
      "MINSKY_FROM_REGISTRY",
    ]);
  });
});

describe("census over the real services/ tree", () => {
  const grandfather = loadGrandfather();
  const reports = auditAll(grandfather);

  test("the census actually found services to audit", () => {
    // Without this, an empty walk (wrong root, changed layout) would make every
    // assertion below pass vacuously — the check would report on nothing.
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.some((r) => r.hasDeployDoc)).toBe(true);
    // Any service reading anything is enough to prove the walk reached source.
    // An earlier `> 10` coupled this to today's counts (PR #3638 R1,
    // NON-BLOCKING) — it would fail on a legitimate cleanup that removed env
    // vars, which is the direction this whole task is trying to encourage.
    expect(reports.some((r) => r.read.length > 0)).toBe(true);
  });

  test("no service reads an env var that is undocumented and ungrandfathered", () => {
    const failing = reports.flatMap((r) => r.failing.map((n) => `${r.service}: ${n}`));
    expect(failing).toEqual([]);
  });

  test("the grandfather list may only shrink", () => {
    const total = Object.values(grandfather.names).flat().length;
    expect(total).toBeLessThanOrEqual(GRANDFATHER_CEILING);
  });

  test("no grandfathered name is already documented — the list carries no dead weight", () => {
    // The other half of shrink-only: documenting a var in DEPLOY.md without
    // removing it from the list would leave the count overstating the debt, and
    // the ceiling would stop being a real bound.
    const stale = reports.flatMap((r) => r.staleGrandfathered.map((n) => `${r.service}: ${n}`));
    expect(stale).toEqual([]);
  });

  test("a service with a Dockerfile and no DEPLOY.md is reported, not silently skipped", () => {
    // `services/cockpit` is that case today. The assertion is about the SHAPE of
    // the report rather than about cockpit specifically: whatever the set is, a
    // deployable service without a runbook must be visible on the report and
    // must not manufacture per-var failures against a file that does not exist.
    for (const r of reports.filter((r) => r.hasDockerfile && !r.hasDeployDoc)) {
      expect(r.failing).toEqual([]);
      expect(r.hasDeployDoc).toBe(false);
    }
  });
});
