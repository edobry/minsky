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
 *   3. Hybrid default: fail-closed when MCP is configured, fail-open otherwise.
 *
 * Hybrid fail-closed policy (mt#1085):
 *   - MCP NOT configured (mcpUrl or mcpToken unset): fail-OPEN. resolveTier
 *     returns null → decideRouting defaults to Tier 2. Preserves Sprint A
 *     behavior for deployments without an MCP endpoint.
 *   - MCP configured but lookup misses (record absent, HTTP error, parse error,
 *     authorshipTier===null) AND no body marker: fail-CLOSED. resolveTier
 *     returns 3 (Tier 3 / mandatory review). Rationale: when MCP is meant to be
 *     authoritative, an unresolvable tier must not silently default to skippable.
 *
 * A record present but with authorshipTier === null falls THROUGH to
 * the body-marker path (tier not yet computed), not directly to the default.
 */

import type { ReviewerConfig } from "./config";
import { callAuthorshipGet } from "./mcp-client";

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
 * Look up the authorship tier for a PR via the Minsky MCP authorship endpoint.
 *
 * Returns:
 * - A numeric tier (1 | 2 | 3) when the record exists and has a computed tier.
 * - null when the record exists but tier is null (not yet computed).
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
    const record = await callAuthorshipGet(String(prNumber), "pr", config);

    if (record === null) {
      // No record found — fall through to next fallback.
      return undefined;
    }

    const raw = record.tier;
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
      `[tier-routing] authorship record for PR ${prNumber} has unexpected tier=${raw}; skipping MCP result`
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
 *   3. Hybrid default — see module-level docstring for the fail-open / fail-closed policy.
 *
 * When MCP is configured and the lookup misses (no record, HTTP error, null tier) AND the
 * body has no marker, returns 3 (fail-closed: mandatory review). When MCP is not configured,
 * returns null (fail-open: decideRouting defaults to Tier 2 behavior), preserving Sprint A
 * graceful-degradation semantics.
 *
 * @param mcpLookupFn Optional override for the MCP lookup function (injectable for tests).
 *   Defaults to `lookupTierFromMCP`.
 */
export async function resolveTier(
  prNumber: number,
  prBody: string,
  config: ReviewerConfig,
  mcpLookupFn: (
    prNumber: number,
    config: ReviewerConfig
  ) => Promise<AuthorshipTier | null | undefined> = lookupTierFromMCP
): Promise<AuthorshipTier> {
  const mcpConfigured = !!(config.mcpUrl && config.mcpToken);

  // Step 1: MCP authorship lookup (no-op if unconfigured; callAuthorshipGet early-returns null).
  const mcpTier = await mcpLookupFn(prNumber, config);

  if (mcpTier === 1 || mcpTier === 2 || mcpTier === 3) {
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

  // Step 3: Hybrid default.
  if (mcpConfigured) {
    // Fail-closed: MCP was expected to have the answer, didn't. Mandate review.
    return 3;
  }
  // Fail-open: MCP unconfigured — preserve Sprint A behavior (Tier 2 default via decideRouting).
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
