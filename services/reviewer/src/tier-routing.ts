/**
 * Tier-routing decision for the reviewer service.
 *
 * Not every PR needs adversarial review. Minsky's authorship tier model
 * (mt#846) describes where human attention should go; reviewer intensity
 * should match. See the Structural Review paper, section "Tier-routed
 * activation."
 *
 * Sprint A: tier is read from the PR body (implementer writes it when
 * opening the PR). Sprint B or later: switch to reading Minsky's provenance
 * record directly via Minsky MCP.
 */

import type { ReviewerConfig } from "./config";

export type AuthorshipTier = 1 | 2 | 3 | null;

export function extractTierFromPRBody(body: string): AuthorshipTier {
  const match = body.match(/<!--\s*minsky:tier=(\d+)\s*-->/i);
  if (match && match[1]) {
    const tier = parseInt(match[1], 10);
    if (tier === 1 || tier === 2 || tier === 3) {
      return tier;
    }
  }
  return null;
}

export interface TierRoutingDecision {
  shouldReview: boolean;
  reason: string;
}

export function decideRouting(tier: AuthorshipTier, config: ReviewerConfig): TierRoutingDecision {
  switch (tier) {
    case 1:
      return {
        shouldReview: false,
        reason:
          "Tier 1 (human-authored). Human direction is already upstream; adversarial review would add less signal than the human's own judgment expressed in the spec.",
      };
    case 2:
      return {
        shouldReview: config.tier2Enabled,
        reason: config.tier2Enabled
          ? "Tier 2 (co-authored). Tier-2 review is enabled for this deployment."
          : "Tier 2 (co-authored). Tier-2 review is not enabled (MINSKY_REVIEWER_TIER2_ENABLED=false).",
      };
    case 3:
      return {
        shouldReview: true,
        reason: "Tier 3 (agent-authored). Mandatory review — this is the canonical use case.",
      };
    case null:
      return {
        shouldReview: config.tier2Enabled,
        reason: `No tier hint found in PR body. Defaulting to Tier 2 behavior; ${
          config.tier2Enabled ? "review enabled." : "review skipped."
        }`,
      };
  }
}
