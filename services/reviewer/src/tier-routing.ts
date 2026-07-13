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
 * Sprint B (mt#1085): tier is resolved via the Minsky MCP authorship endpoint
 * (`authorship.get`) with a body-marker fallback.
 * mt#2121: migrated from MCP-over-HTTP to direct domain ProvenanceService import.
 *
 * Fallback chain:
 *   1. ProvenanceService authorship record (tier field) — authoritative.
 *   2. PR-body HTML comment marker (<!-- minsky:tier=N -->).
 *   3. Hybrid default: fail-closed when persistence is configured, fail-open otherwise.
 *
 * Hybrid fail-closed policy (mt#1085):
 *   - Persistence NOT configured (persistenceProvider absent): fail-OPEN. resolveTier
 *     returns null → decideRouting defaults to Tier 2. Preserves Sprint A
 *     behavior for deployments without a DB.
 *   - Persistence configured but lookup misses (record absent, DB error, parse error,
 *     tier===null) AND no body marker: fail-CLOSED. resolveTier
 *     returns 3 (Tier 3 / mandatory review). Rationale: when persistence is meant to be
 *     authoritative, an unresolvable tier must not silently default to skippable.
 *
 * A record present but with tier === null falls THROUGH to
 * the body-marker path (tier not yet computed), not directly to the default.
 */

import { log } from "./logger";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";

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
 * Look up the authorship tier for a PR via ProvenanceService directly.
 *
 * Returns:
 * - A numeric tier (1 | 2 | 3) when the record exists and has a computed tier.
 * - null when the record exists but tier is null (not yet computed).
 * - undefined when the record does not exist or the lookup failed — signals
 *   that the caller should move to the next fallback.
 *
 * @see mt#2121 — migrated from MCP-over-HTTP to direct domain imports.
 */
export async function lookupTierFromDomain(
  prNumber: number,
  persistenceProvider: BasePersistenceProvider
): Promise<AuthorshipTier | null | undefined> {
  try {
    const { ProvenanceService } = await import("@minsky/domain/provenance/provenance-service");
    const sqlProvider =
      persistenceProvider as import("@minsky/domain/persistence/types").SqlCapablePersistenceProvider;
    if (!sqlProvider.getDatabaseConnection) {
      return undefined;
    }
    const db = await sqlProvider.getDatabaseConnection();
    if (!db) {
      return undefined;
    }

    const provenanceService = new ProvenanceService(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase
    );
    const record = await provenanceService.getProvenanceForArtifact(String(prNumber), "pr");

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
    log.warn(
      `[tier-routing] provenance record for PR ${prNumber} has unexpected tier=${raw}; skipping`
    );
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[tier-routing] domain lookup failed for PR ${prNumber}: ${msg}`);
    return undefined;
  }
}

/**
 * Resolve the authorship tier for a PR using the full fallback chain:
 *   1. ProvenanceService authorship record (tier field) — authoritative.
 *   2. PR-body HTML comment marker.
 *   3. Hybrid default — see module-level docstring for the fail-open / fail-closed policy.
 *
 * When persistence is configured and the lookup misses (no record, DB error, null tier) AND the
 * body has no marker, returns 3 (fail-closed: mandatory review). When persistence is not configured,
 * returns null (fail-open: decideRouting defaults to Tier 2 behavior), preserving Sprint A
 * graceful-degradation semantics.
 *
 * @param domainLookupFn Optional override for the domain lookup function (injectable for tests).
 *   Defaults to `lookupTierFromDomain`.
 */
export async function resolveTier(
  prNumber: number,
  prBody: string,
  persistenceProvider: BasePersistenceProvider | null | undefined,
  domainLookupFn: (
    prNumber: number,
    persistenceProvider: BasePersistenceProvider
  ) => Promise<AuthorshipTier | null | undefined> = lookupTierFromDomain
): Promise<AuthorshipTier> {
  const persistenceConfigured = !!persistenceProvider;

  // Step 1: ProvenanceService lookup (no-op if persistence not configured).
  const domainTier = persistenceProvider
    ? await domainLookupFn(prNumber, persistenceProvider)
    : undefined;

  if (domainTier === 1 || domainTier === 2 || domainTier === 3) {
    // Got a concrete tier from domain — use it.
    return domainTier;
  }

  // domainTier === null means record present but tier not computed;
  // domainTier === undefined means no record or error — both fall to body marker.

  // Step 2: PR-body marker.
  const bodyTier = extractTierFromPRBody(prBody);
  if (bodyTier !== null) {
    return bodyTier;
  }

  // Step 3: Hybrid default.
  if (persistenceConfigured) {
    // Fail-closed: persistence was expected to have the answer, didn't. Mandate review.
    return 3;
  }
  // Fail-open: persistence unconfigured — preserve Sprint A behavior (Tier 2 default via decideRouting).
  return null;
}

export interface TierRoutingDecision {
  shouldReview: boolean;
  reason: string;
}

export function decideRouting(tier: AuthorshipTier, tier2Enabled: boolean): TierRoutingDecision {
  switch (tier) {
    case 1:
      return {
        shouldReview: false,
        reason:
          "Tier 1 (human-authored). Human direction is already upstream; adversarial review would add less signal than the human's own judgment expressed in the spec.",
      };
    case 2:
      return {
        shouldReview: tier2Enabled,
        reason: tier2Enabled
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
        shouldReview: tier2Enabled,
        reason: `No tier hint found in PR body. Defaulting to Tier 2 behavior; ${
          tier2Enabled ? "review enabled." : "review skipped."
        }`,
      };
  }
}
