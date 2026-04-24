import { describe, expect, test } from "bun:test";
import { decideRouting, extractTierFromPRBody } from "./tier-routing";
import type { ReviewerConfig } from "./config";

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
