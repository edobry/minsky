// Tests for the Rung-2 identity/equivalence claim class (mt#4155).
//
// The gap: every `PREDICATE_PATTERNS` entry is a BEHAVIOR verb (`clamps`,
// `returns`, `throws`) or one of mt#3050's five SOURCING verbs. A claim that
// asserts a symbol's IDENTITY or EQUIVALENCE — "`X` is the single reader" —
// names neither, so the symbol is extracted and no predicate anchors it.
// mt#4106 measured four such claims: `extracted: true`, `matched: false`.
//
// These tests exercise the PURE seam, so they need no embedding provider: the
// nominator is injected. `createIdentityClaimNominator`'s real provider wiring
// is exercised separately by the live run recorded in the PR body.

import { describe, test, expect } from "bun:test";
import {
  detectCodeMechanismAssertion,
  identityClaimsFromSegments,
  augmentWithIdentityNomination,
  isRung2NominationEnabled,
  IDENTITY_CLAIM_EXEMPLAR_SET,
  IDENTITY_CLAIM_FAMILY,
  RUNG2_NOMINATION_ENV_VAR,
  SYMBOL_FREE_SKIP_ENV_VAR,
} from "./code-mechanism-assertion-detector";
import type { IdentityClaimNominator } from "./code-mechanism-assertion-detector";
// One helper, one definition — see its docblock for why it is not duplicated here.
import { withEnv } from "./code-mechanism-assertion-symbol-free.test";

/** The phantom symbol three of the four mt#4106 fixtures carry. */
const PHANTOM_SYMBOL = "readResidentBytes";

interface Fixture {
  id: string;
  symbol: string;
  body: string;
}

// The four bodies mt#4106 measured, verbatim from
// `scripts/replay-artifact-surface-claims.ts`. Named rather than indexed so the
// tests below read as the case they exercise.

const FIXTURE_SUCCESS_CRITERIA: Fixture = {
  id: "instance-1a-mt4104-success-criteria",
  symbol: PHANTOM_SYMBOL,
  body: [
    "3. `readResidentBytes` in `src/mcp/orphan-exit.ts` is converted to it — and mt#3973's",
    "   `MINSKY_MCP_MEMORY_CAPTURE_MB` watermark, which shares the same reader, is converted with",
    "   it.",
  ].join("\n"),
};

const FIXTURE_SCOPE: Fixture = {
  id: "instance-1b-mt4104-scope",
  symbol: PHANTOM_SYMBOL,
  body: [
    "- **`readResidentBytes` (`src/mcp/orphan-exit.ts:331`) — the single reader carrying the",
    "  defect.** It is injected, not called directly, at **five** wiring sites, so converting the",
    "  one function converts every consumer at once.",
  ].join("\n"),
};

const FIXTURE_MEMORY_CAPTURE: Fixture = {
  id: "instance-2-mt4104-scope-memory-capture",
  symbol: "HEAP_SNAPSHOT_RSS_MULTIPLIER",
  body: [
    "- `src/mcp/memory-capture.ts` — its `HEAP_SNAPSHOT_RSS_MULTIPLIER` arithmetic is expressed in",
    "  the same unit against the same reading. Changing what the input means changes what that",
    "  projection means; re-derive it here.",
  ].join("\n"),
};

const FIXTURE_GAP_RESOLUTION: Fixture = {
  id: "instance-1c-mt4099-gap-resolution",
  symbol: PHANTOM_SYMBOL,
  body: [
    "The primitive takes a pid so it works for both the calling process and another pid,",
    "converting `readResidentBytes` AND mt#3973's capture watermark, and the two mt#3764 watchers",
    "that consume them.",
  ].join("\n"),
};

const MT4106_FIXTURES: Fixture[] = [
  FIXTURE_SUCCESS_CRITERIA,
  FIXTURE_SCOPE,
  FIXTURE_MEMORY_CAPTURE,
  FIXTURE_GAP_RESOLUTION,
];

/** A nominator that nominates the whole prose as one identity-family segment. */
const alwaysNominates: IdentityClaimNominator = async (prose) => ({
  kind: "nominated",
  segments: [{ family: IDENTITY_CLAIM_FAMILY, segment: prose }],
});

describe("identity-claim nomination (mt#4155)", () => {
  test("the lexical path misses all four mt#4106 fixtures — the documented gap", () => {
    for (const fixture of MT4106_FIXTURES) {
      const result = detectCodeMechanismAssertion(fixture.body, "");
      expect(result.matched).toBe(false);
      expect(result.claims).toEqual([]);
    }
  });

  test("identityClaimsFromSegments recovers a claim naming the symbol, on each fixture", () => {
    for (const fixture of MT4106_FIXTURES) {
      const { claims } = identityClaimsFromSegments([fixture.body], "");
      expect(claims.length).toBeGreaterThan(0);
      expect(claims.map((c) => c.symbol)).toContain(fixture.symbol);
    }
  });

  test("a symbol read this turn is excluded, exactly as the lexical path excludes it", () => {
    const { claims, backedCount } = identityClaimsFromSegments(
      [FIXTURE_SUCCESS_CRITERIA.body],
      `contents of src/mcp/orphan-exit.ts including ${PHANTOM_SYMBOL}`
    );
    expect(claims.map((c) => c.symbol)).not.toContain(PHANTOM_SYMBOL);
    expect(backedCount).toBeGreaterThan(0);
  });

  test("augment reports rung 2 and merges the nominated claim", async () => {
    const base = detectCodeMechanismAssertion(FIXTURE_SCOPE.body, "");
    const augmented = await augmentWithIdentityNomination(
      base,
      FIXTURE_SCOPE.body,
      "",
      "",
      alwaysNominates
    );
    expect(augmented.detectionRung).toBe("2-embedding");
    expect(augmented.matched).toBe(true);
    expect(augmented.claims.map((c) => c.symbol)).toContain(FIXTURE_SCOPE.symbol);
  });

  test("with no nominator the result is the lexical one — Rung 2 ships disabled", async () => {
    const base = detectCodeMechanismAssertion(FIXTURE_SCOPE.body, "");
    const augmented = await augmentWithIdentityNomination(base, FIXTURE_SCOPE.body, "");
    expect(augmented.detectionRung).toBe("1-lexical");
    expect(augmented.matched).toBe(false);
    expect(augmented.claims).toEqual([]);
  });

  test("a degraded nomination falls back to Rung 1 and records the reason", async () => {
    const base = detectCodeMechanismAssertion(FIXTURE_SCOPE.body, "");
    const degrading: IdentityClaimNominator = async () => ({
      kind: "degraded",
      reason: "timeout",
    });
    const augmented = await augmentWithIdentityNomination(
      base,
      FIXTURE_SCOPE.body,
      "",
      "",
      degrading
    );
    expect(augmented.detectionRung).toBe("1-lexical");
    expect(augmented.nominationDegradedReason).toBe("timeout");
    expect(augmented.matched).toBe(false);
  });

  test("a nominator that throws degrades rather than taking out the verdict", async () => {
    const base = detectCodeMechanismAssertion(FIXTURE_SCOPE.body, "");
    const throwing: IdentityClaimNominator = async () => {
      throw new Error("provider exploded");
    };
    const augmented = await augmentWithIdentityNomination(
      base,
      FIXTURE_SCOPE.body,
      "",
      "",
      throwing
    );
    expect(augmented.detectionRung).toBe("1-lexical");
    expect(augmented.nominationDegradedReason).toContain("provider exploded");
  });

  test("with only the identity family active, symbol-free prose spends no round-trip", async () => {
    // mt#3726 amended this test rather than deleting it. The gate it asserts is
    // still real and still worth keeping — it just became CONDITIONAL: skipping
    // a symbol-free turn is correct when the identity family is the only thing
    // that could match, and wrong once the symbol-free cohort is active, whose
    // whole subject is turns exactly like this one.
    await withEnv(SYMBOL_FREE_SKIP_ENV_VAR, "1", async () => {
      let called = 0;
      const counting: IdentityClaimNominator = async (prose) => {
        called++;
        return { kind: "nominated", segments: [{ family: IDENTITY_CLAIM_FAMILY, segment: prose }] };
      };
      const text = "This turn is the single reader of nothing in particular.";
      const base = detectCodeMechanismAssertion(text, "");
      const augmented = await augmentWithIdentityNomination(base, text, "", "", counting);
      expect(called).toBe(0);
      expect(augmented.detectionRung).toBe("1-lexical");
    });
  });

  test("the exemplar set is the identity family and names no concrete symbol", () => {
    expect(IDENTITY_CLAIM_EXEMPLAR_SET.family).toBe(IDENTITY_CLAIM_FAMILY);
    expect(IDENTITY_CLAIM_EXEMPLAR_SET.exemplars.length).toBeGreaterThan(0);
    for (const exemplar of IDENTITY_CLAIM_EXEMPLAR_SET.exemplars) {
      expect(exemplar).not.toContain("`");
    }
  });

  test("Rung 2 is off unless the operator opts in", () => {
    // Was the third hand-rolled env mutation, and the one with no `finally` at
    // all — a throw between the two assertions leaked the var into every test
    // after it. PR #3178 R1's nit named one site; this is the same class.
    withEnv(RUNG2_NOMINATION_ENV_VAR, undefined, () => {
      expect(isRung2NominationEnabled()).toBe(false);
    });
    withEnv(RUNG2_NOMINATION_ENV_VAR, "1", () => {
      expect(isRung2NominationEnabled()).toBe(true);
    });
  });
});
