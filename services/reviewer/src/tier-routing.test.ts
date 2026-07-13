import { describe, expect, test, mock } from "bun:test";
import { decideRouting, extractTierFromPRBody, resolveTier } from "./tier-routing";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";

// ---------------------------------------------------------------------------
// Fake persistence providers for fail-closed / fail-open tests.
// ---------------------------------------------------------------------------

/**
 * A minimal fake BasePersistenceProvider — just enough for the type to be
 * non-null. The resolveTier function only checks `!!persistenceProvider`
 * to determine the fail-open vs fail-closed default when a domainLookupFn
 * override is supplied.
 */
const fakePersistenceProvider = {} as BasePersistenceProvider;

// Reusable PR-body marker strings for tests.
const TIER1_MARKER = "<!-- minsky:tier=1 -->";

describe("extractTierFromPRBody", () => {
  test("extracts tier=1 from HTML comment hint", () => {
    expect(extractTierFromPRBody("<!-- minsky:tier=1 -->")).toBe(1);
  });

  test("extracts tier=2 from HTML comment hint", () => {
    expect(extractTierFromPRBody("some text <!-- minsky:tier=2 --> more text")).toBe(2);
  });

  test("extracts tier=3 from HTML comment hint", () => {
    expect(extractTierFromPRBody("<!-- minsky:tier=3 -->")).toBe(3);
  });

  test("handles whitespace in the marker", () => {
    expect(extractTierFromPRBody("<!--   minsky:tier=3   -->")).toBe(3);
  });

  test("returns null when no marker is present", () => {
    expect(extractTierFromPRBody("Just a PR description, no tier hint.")).toBeNull();
  });

  test("returns null for invalid tier values", () => {
    expect(extractTierFromPRBody("<!-- minsky:tier=42 -->")).toBeNull();
    expect(extractTierFromPRBody("<!-- minsky:tier=0 -->")).toBeNull();
  });
});

describe("decideRouting", () => {
  test("Tier 1: never reviewed", () => {
    expect(decideRouting(1, true).shouldReview).toBe(false);
    expect(decideRouting(1, false).shouldReview).toBe(false);
  });

  test("Tier 2: gated by tier2Enabled", () => {
    expect(decideRouting(2, true).shouldReview).toBe(true);
    expect(decideRouting(2, false).shouldReview).toBe(false);
  });

  test("Tier 3: always reviewed", () => {
    expect(decideRouting(3, true).shouldReview).toBe(true);
    expect(decideRouting(3, false).shouldReview).toBe(true);
  });

  test("null tier: defaults to Tier 2 behavior", () => {
    expect(decideRouting(null, true).shouldReview).toBe(true);
    expect(decideRouting(null, false).shouldReview).toBe(false);
  });

  test("every decision has a reason string", () => {
    for (const tier of [1, 2, 3, null] as const) {
      for (const tier2Enabled of [true, false]) {
        const decision = decideRouting(tier, tier2Enabled);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// resolveTier — fallback chain
//
// resolveTier accepts an optional domainLookupFn parameter for testing so we
// do not need to mutate the ES-module namespace (which is read-only at
// runtime). The third parameter is a BasePersistenceProvider (non-null =
// persistence configured, null = not configured).
// ---------------------------------------------------------------------------

describe("resolveTier", () => {
  test("returns domain tier when provenance record has a concrete tier", async () => {
    const fakeLookup = mock(() => Promise.resolve(3 as const));

    const tier = await resolveTier(99, "no body marker", fakePersistenceProvider, fakeLookup);
    expect(tier).toBe(3);
  });

  test("falls through to body marker when domain lookup returns null (tier not computed)", async () => {
    // null from lookup means record present but authorshipTier===null.
    const fakeLookup = mock(() => Promise.resolve(null as null));

    const tier = await resolveTier(
      99,
      "<!-- minsky:tier=2 -->",
      fakePersistenceProvider,
      fakeLookup
    );
    expect(tier).toBe(2);
  });

  test("falls through to body marker when domain lookup returns undefined (no record)", async () => {
    // undefined from lookup means no record found or error.
    const fakeLookup = mock(() => Promise.resolve(undefined));

    const tier = await resolveTier(99, TIER1_MARKER, fakePersistenceProvider, fakeLookup);
    expect(tier).toBe(1);
  });

  test("returns Tier 3 when persistence is configured, lookup returns undefined, and no body marker (fail-closed)", async () => {
    // Persistence configured (non-null provider) but lookup returns undefined
    // (no record / DB error). No body marker. → fail-closed: must return 3.
    const fakeLookup = mock(() => Promise.resolve(undefined));

    const tier = await resolveTier(99, "No marker here", fakePersistenceProvider, fakeLookup);
    expect(tier).toBe(3);
  });

  test("returns Tier 3 when persistence is configured, lookup returns null, and no body marker (fail-closed)", async () => {
    // authorshipTier===null (record exists but tier not yet computed) + no body marker
    // + persistence configured → fail-closed: must return 3.
    const fakeLookup = mock(() => Promise.resolve(null as null));

    const tier = await resolveTier(99, "No marker here", fakePersistenceProvider, fakeLookup);
    expect(tier).toBe(3);
  });

  test("falls through to body marker when persistence is not configured (no lookup override)", async () => {
    // When persistenceProvider is null, the domain lookup is skipped entirely,
    // so body marker takes over.
    const tier = await resolveTier(99, "<!-- minsky:tier=3 -->", null);
    expect(tier).toBe(3);
  });

  test("Tier 3 PR with no body marker but valid provenance record → tier=3 (integration)", async () => {
    // Spec acceptance test: Tier 3 via domain lookup, no body marker → mandatory review.
    const fakeLookup = mock(() => Promise.resolve(3 as const));

    const tier = await resolveTier(
      42,
      "PR body with no tier marker",
      fakePersistenceProvider,
      fakeLookup
    );
    expect(tier).toBe(3);

    // decideRouting must mandate review for Tier 3.
    const routing = decideRouting(tier, false);
    expect(routing.shouldReview).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Hybrid fail-closed / fail-open policy (mt#1085 Sprint B)
  // ---------------------------------------------------------------------------

  test("returns Tier 3 when persistence configured, lookup errors, and no body marker (fail-closed)", async () => {
    // Persistence configured + lookup returns undefined (DB error / no record) + empty body
    // → must fail-closed: mandatory review.
    const fakeLookup = mock(() => Promise.resolve(undefined));

    const tier = await resolveTier(101, "", fakePersistenceProvider, fakeLookup);
    expect(tier).toBe(3);
  });

  test("returns Tier 3 when persistence configured, record has null tier, and no body marker (fail-closed)", async () => {
    // Persistence configured + lookup returns null (record exists, authorshipTier===null) + empty body
    // → must fail-closed: mandatory review.
    const fakeLookup = mock(() => Promise.resolve(null as null));

    const tier = await resolveTier(102, "", fakePersistenceProvider, fakeLookup);
    expect(tier).toBe(3);
  });

  test("returns null when persistence is NOT configured and no body marker (fail-open)", async () => {
    // Persistence not configured (null provider) + empty body
    // → must fail-open: preserve Sprint A behavior (null → decideRouting defaults Tier 2).
    const fakeLookup = mock(() => Promise.resolve(undefined));

    const tier = await resolveTier(103, "", null, fakeLookup);
    expect(tier).toBeNull();
  });

  test("returns body tier when persistence lookup fails but body marker provides a tier (body wins)", async () => {
    // Persistence configured + lookup returns undefined (error) + body has tier=1
    // → body marker wins before reaching the fail-closed default.
    const fakeLookup = mock(() => Promise.resolve(undefined));

    const tier = await resolveTier(104, TIER1_MARKER, fakePersistenceProvider, fakeLookup);
    expect(tier).toBe(1);
  });
});
