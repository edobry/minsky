/**
 * Flakiness-attribution matcher (mt#3658).
 *
 * The acceptance tests are the spec's own, in its numbering: AT1 (fires with no
 * evidence), AT2 (a recorded control silences it), AT3 (the UNVERIFIED marker
 * silences it), AT4 (no vocabulary → no run), AT6 (the negated form fires).
 * AT5 — the negative control proving the evidence check is load-bearing and not
 * just the vocabulary match — is the pair of `hasIsolationControl` cases plus
 * the AT1/AT2 contrast on ONE spec body.
 */
import { describe, expect, test } from "bun:test";
import {
  detectFlakinessAttribution,
  extractFlakinessClaims,
  hasIsolationControl,
  hasUnverifiedMarkerNearClaim,
} from "./flakiness-attribution";

/** The spec body every case varies, so the contrast is the evidence alone. */
const FLAKY_SPEC = [
  "## Summary",
  "",
  "`src/foo/bar.test.ts` fails intermittently under load in the gated suite.",
  "It looks load-dependent rather than a real defect.",
].join("\n");

const CONTROL_EVIDENCE = [
  "",
  "## Isolation control",
  "",
  "`bun test --preload ./tests/setup.ts --timeout=15000 src/foo/bar.test.ts`",
  "→ 17 pass / 0 fail (249ms)",
].join("\n");

describe("detectFlakinessAttribution (mt#3658)", () => {
  test("AT1: a flakiness attribution with no control evidence matches", () => {
    const result = detectFlakinessAttribution(FLAKY_SPEC);

    expect(result.matched).toBe(true);
    expect(result.hasIsolationControl).toBe(false);
    expect(result.hasUnverifiedMarker).toBe(false);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.claims.some((c) => c.family === "attribution")).toBe(true);
    // The record has to carry what tripped it, per guard-feedback-authoring's
    // quoted-evidence requirement.
    expect(result.claims[0]?.excerpt).toContain("intermittently");
  });

  test("AT2: the same spec plus a recorded control does NOT match", () => {
    const result = detectFlakinessAttribution(FLAKY_SPEC + CONTROL_EVIDENCE);

    expect(result.hasIsolationControl).toBe(true);
    expect(result.matched).toBe(false);
    // The vocabulary still matched — only the evidence changed. This is AT5's
    // point: the evidence check, not the vocabulary, is what silences it.
    expect(result.claims.length).toBeGreaterThan(0);
  });

  test("AT3: the same spec plus the literal UNVERIFIED does NOT match", () => {
    const spec = `${FLAKY_SPEC}\n\nUNVERIFIED as load-dependent — isolation control not run.`;
    const result = detectFlakinessAttribution(spec);

    expect(result.hasUnverifiedMarker).toBe(true);
    expect(result.matched).toBe(false);
  });

  test("AT4: a spec with no flakiness vocabulary does not run", () => {
    const spec = "## Summary\n\nAdd a --dry-run flag to session delete.";
    const result = detectFlakinessAttribution(spec);

    expect(result.claims).toEqual([]);
    expect(result.matched).toBe(false);
  });

  test("AT6: the negated form fires — a denial is the same claim class (mt#3719)", () => {
    // Verbatim shape of mt#3719's spec, which read as the careful verdict and
    // was falsified by the control four minutes later.
    const spec = [
      "## Not a flake — the distinction matters for how it gets fixed",
      "",
      "It is not load-dependent and not timing-dependent: it fails deterministically",
      "wherever persistence resolves, and passes deterministically where it does not.",
    ].join("\n");

    const result = detectFlakinessAttribution(spec);

    expect(result.matched).toBe(true);
    expect(result.claims.some((c) => c.family === "denial")).toBe(true);
  });

  test("a denial is recorded as a denial, not swallowed by the attribution it contains", () => {
    const claims = extractFlakinessClaims("It is not load-dependent.");
    const forPhrase = claims.find((c) => /not load/i.test(c.phrase));

    expect(forPhrase?.family).toBe("denial");
  });
});

describe("hasIsolationControl", () => {
  test("requires BOTH an invocation and an observed count", () => {
    // A bare command is a plan, not an observation.
    expect(hasIsolationControl("bun test --timeout=15000 src/foo.test.ts")).toBe(false);
    // A count with no command could be quoting anything.
    expect(hasIsolationControl("17 pass / 0 fail")).toBe(false);
    expect(hasIsolationControl("bun test src/foo.test.ts → 17 pass / 0 fail")).toBe(true);
  });

  test("accepts the gated-runner form", () => {
    expect(hasIsolationControl("bun scripts/run-tests-gated.ts → 1533 pass")).toBe(true);
  });

  test("accepts a fail-only observation — a control that FAILS is the useful one", () => {
    // mt#3557's control failed in isolation, which is what falsified the flake
    // reading. A matcher requiring a pass count would miss exactly that case.
    expect(hasIsolationControl("bun test src/foo.test.ts → 0 pass / 3 fail")).toBe(true);
  });
});

describe("hasUnverifiedMarkerNearClaim", () => {
  const claims = extractFlakinessClaims("The suite is flaky under load.");

  test("accepts a marker beside the claim", () => {
    expect(hasUnverifiedMarkerNearClaim("The suite is flaky under load. UNVERIFIED.", claims)).toBe(
      true
    );
  });

  test("rejects a marker far from the claim — §2b says 'near the attribution'", () => {
    // A spec that marks some OTHER claim UNVERIFIED has not marked this one.
    const spec = `The suite is flaky under load.${"\n".repeat(50)}${"x".repeat(900)}UNVERIFIED`;
    expect(hasUnverifiedMarkerNearClaim(spec, claims)).toBe(false);
  });
});
