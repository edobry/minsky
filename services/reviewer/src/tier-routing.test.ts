import { describe, expect, test, mock } from "bun:test";
import { decideRouting, extractTierFromPRBody, resolveTier } from "./tier-routing";
import type { ReviewerConfig } from "./config";

// Config with MCP enabled
const mcpConfig: ReviewerConfig = {
  appId: 1,
  privateKey: "",
  installationId: 1,
  webhookSecret: "",
  provider: "openai",
  providerApiKey: "",
  providerModel: "gpt-5",
  tier2Enabled: false,
  mcpUrl: "https://minsky-mcp.example.com/mcp",
  mcpToken: "test-token",
  port: 3000,
  logLevel: "info",
};

const tier2On: ReviewerConfig = {
  appId: 1,
  privateKey: "",
  installationId: 1,
  webhookSecret: "",
  provider: "openai",
  providerApiKey: "",
  providerModel: "gpt-5",
  tier2Enabled: true,
  mcpUrl: undefined,
  mcpToken: undefined,
  port: 3000,
  logLevel: "info",
};

const tier2Off: ReviewerConfig = { ...tier2On, tier2Enabled: false };

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
    expect(decideRouting(1, tier2On).shouldReview).toBe(false);
    expect(decideRouting(1, tier2Off).shouldReview).toBe(false);
  });

  test("Tier 2: gated by tier2Enabled", () => {
    expect(decideRouting(2, tier2On).shouldReview).toBe(true);
    expect(decideRouting(2, tier2Off).shouldReview).toBe(false);
  });

  test("Tier 3: always reviewed", () => {
    expect(decideRouting(3, tier2On).shouldReview).toBe(true);
    expect(decideRouting(3, tier2Off).shouldReview).toBe(true);
  });

  test("null tier: defaults to Tier 2 behavior", () => {
    expect(decideRouting(null, tier2On).shouldReview).toBe(true);
    expect(decideRouting(null, tier2Off).shouldReview).toBe(false);
  });

  test("every decision has a reason string", () => {
    for (const tier of [1, 2, 3, null] as const) {
      for (const cfg of [tier2On, tier2Off]) {
        const decision = decideRouting(tier, cfg);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// resolveTier — fallback chain
//
// resolveTier accepts an optional mcpLookupFn parameter for testing so we do
// not need to mutate the ES-module namespace (which is read-only at runtime).
// ---------------------------------------------------------------------------

describe("resolveTier", () => {
  test("returns MCP tier when provenance record has a concrete tier", async () => {
    const fakeLookup = mock(() => Promise.resolve(3 as const));

    const tier = await resolveTier(99, "no body marker", mcpConfig, fakeLookup);
    expect(tier).toBe(3);
  });

  test("falls through to body marker when MCP lookup returns null (tier not computed)", async () => {
    // null from lookup means record present but authorshipTier===null.
    const fakeLookup = mock(() => Promise.resolve(null as null));

    const tier = await resolveTier(99, "<!-- minsky:tier=2 -->", mcpConfig, fakeLookup);
    expect(tier).toBe(2);
  });

  test("falls through to body marker when MCP lookup returns undefined (no record)", async () => {
    // undefined from lookup means no record found or error.
    const fakeLookup = mock(() => Promise.resolve(undefined));

    const tier = await resolveTier(99, "<!-- minsky:tier=1 -->", mcpConfig, fakeLookup);
    expect(tier).toBe(1);
  });

  test("falls to null default when MCP lookup returns undefined and no body marker", async () => {
    const fakeLookup = mock(() => Promise.resolve(undefined));

    const tier = await resolveTier(99, "No marker here", mcpConfig, fakeLookup);
    expect(tier).toBeNull();
  });

  test("falls to null default when MCP lookup returns null and no body marker", async () => {
    // authorshipTier===null + no body marker → null (Tier 2 default via decideRouting)
    const fakeLookup = mock(() => Promise.resolve(null as null));

    const tier = await resolveTier(99, "No marker here", mcpConfig, fakeLookup);
    expect(tier).toBeNull();
  });

  test("falls through to body marker when MCP config is missing (no lookup override)", async () => {
    // Without mcpUrl/mcpToken, callProvenanceGet returns null immediately,
    // so lookupTierFromMCP returns undefined — body marker takes over.
    // This test exercises the real default mcpLookupFn with a no-MCP config.
    const tier = await resolveTier(99, "<!-- minsky:tier=3 -->", tier2On);
    expect(tier).toBe(3);
  });

  test("Tier 3 PR with no body marker but valid provenance record → tier=3 (integration)", async () => {
    // Spec acceptance test: Tier 3 via MCP, no body marker → mandatory review.
    const fakeLookup = mock(() => Promise.resolve(3 as const));

    const tier = await resolveTier(42, "PR body with no tier marker", mcpConfig, fakeLookup);
    expect(tier).toBe(3);

    // decideRouting must mandate review for Tier 3.
    const routing = decideRouting(tier, mcpConfig);
    expect(routing.shouldReview).toBe(true);
  });
});
