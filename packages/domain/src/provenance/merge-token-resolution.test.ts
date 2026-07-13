import { describe, test, expect } from "bun:test";
import { resolveMergeToken } from "./merge-token-resolution";
import { AuthorshipTier } from "./types";

describe("resolveMergeToken", () => {
  describe("when no service account is configured", () => {
    test.each([
      [null, "null tier"],
      [AuthorshipTier.HUMAN_AUTHORED, "tier 1"],
      [AuthorshipTier.CO_AUTHORED, "tier 2"],
      [AuthorshipTier.AGENT_AUTHORED, "tier 3"],
    ])("returns 'user' for %s", (tier, _label) => {
      expect(resolveMergeToken(tier as AuthorshipTier | null, false)).toBe("user");
    });
  });

  describe("when a service account is configured", () => {
    test("returns 'user' when tier is null (mt#992: conservative default for missing provenance)", () => {
      expect(resolveMergeToken(null, true)).toBe("user");
    });

    test("returns 'user' for HUMAN_AUTHORED (tier 1 — human drove the work)", () => {
      expect(resolveMergeToken(AuthorshipTier.HUMAN_AUTHORED, true)).toBe("user");
    });

    test("returns 'user' for CO_AUTHORED (tier 2 — shared authorship, human merges)", () => {
      expect(resolveMergeToken(AuthorshipTier.CO_AUTHORED, true)).toBe("user");
    });

    test("returns 'service' for AGENT_AUTHORED (tier 3 — bot drove the work)", () => {
      expect(resolveMergeToken(AuthorshipTier.AGENT_AUTHORED, true)).toBe("service");
    });
  });
});
