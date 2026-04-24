/**
 * Tier-routing decision for the reviewer service.
 *
 * Not every PR needs adversarial review. Minsky's authorship tier model
 * (mt#846) describes where human attention should go; reviewer intensity
 * should match. See the Structural Review paper, section "Tier-routed
 * activation."
 *
 * Sprint A: tier is read from the PR body (implementer writes it when
 * opening the PR).
 * Sprint B (mt#1085): tier is resolved via the Minsky MCP provenance endpoint
 * with a body-marker fallback.
 *
 * Fallback chain:
 *   1. MCP provenance record (authorshipTier field) — authoritative.
 *   2. PR-body HTML comment marker (<!-- minsky:tier=N -->).
 *   3. Tier 2 (CO_AUTHORED) default.
 *
 * A record present but with authorshipTier === null falls THROUGH to
 * the body-marker path (tier not yet computed), not to the Tier-2 default.
 */

import type { ReviewerConfig } from "./config";
import { callProvenanceGet } from "./mcp-client";

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

/**
 * Look up the authorship tier for a PR via the Minsky MCP provenance endpoint.
 *
 * Returns:
 * - A numeric tier (1 | 2 | 3) when the record exists and has a computed tier.
 * - null when the record exists but authorshipTier is null (not yet computed).
 * - undefined when the record does not exist or the MCP call failed — signals
 *   that the caller should move to the next fallback.
 *
 * NOTE: AuthorshipTier is an enum in the Minsky domain (1 | 2 | 3). We map
 * by numeric value here and do NOT import domain types to keep the reviewer
 * service decoupled from the Minsky codebase.
 */
export async function lookupTierFromMCP(
  prNumber: number,
  config: ReviewerConfig
): Promise<AuthorshipTier | null | undefined> {
  try {
    const record = await callProvenanceGet(String(prNumber), "pr", config);

    if (record === null) {
      // No record found — fall through to next fallback.
      return undefined;
    }

    const raw = record.authorshipTier;
    if (raw === null || raw === undefined) {
      // Record exists but tier is not yet computed — fall through to body marker.
      return null;
    }

    // Map numeric value to the local union type.
    if (raw === 1 || raw === 2 || raw === 3) {
      return raw;
    }

    // Unknown numeric tier — treat as "no tier" and fall through.
    console.warn(
      `[tier-routing] provenance record for PR ${prNumber} has unexpected authorshipTier=${raw}; skipping MCP result`
    );
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tier-routing] MCP lookup failed for PR ${prNumber}: ${msg}`);
    return undefined;
  }
}

/**
 * Resolve the authorship tier for a PR using the full fallback chain:
 *   1. MCP provenance record
 *   2. PR-body HTML comment marker
 *   3. null (Tier 2 default applied by decideRouting)
 */
export async function resolveTier(
  prNumber: number,
  prBody: string,
  config: ReviewerConfig
): Promise<AuthorshipTier> {
  // Step 1: MCP provenance lookup.
  const mcpTier = await lookupTierFromMCP(prNumber, config);

  if (mcpTier !== undefined && mcpTier !== null) {
    // Got a concrete tier from MCP — use it.
    return mcpTier;
  }

  // mcpTier === null means record present but tier not computed;
  // mcpTier === undefined means no record or error — both fall to body marker.

  // Step 2: PR-body marker.
  const bodyTier = extractTierFromPRBody(prBody);
  if (bodyTier !== null) {
    return bodyTier;
  }

  // Step 3: Default — null signals Tier 2 behavior to decideRouting.
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
