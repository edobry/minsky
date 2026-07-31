/**
 * Config resolution for the Rung-2 nomination stage (mt#3408).
 *
 * Kept separate from `embedding-nomination.ts` so the scoring primitive stays
 * importable — and unit-testable — without pulling in the configuration and
 * provider-factory machinery. Consumers that need a live service call
 * `resolveNominationDeps`; tests inject `NominationDeps` directly.
 */

import { createEmbeddingServiceFromConfig } from "../ai/embedding-service-factory";
import { getConfiguration } from "../configuration";
import { isSemanticProvider, type NominationDeps } from "./embedding-nomination";

/**
 * Resolve the embedding service plus the semantic-provider flag from config.
 *
 * Returns `null` when no usable provider is configured — the caller treats that
 * exactly like any other degraded path (fall back to Rung 1, still inject, log
 * the marker). Never throws: a provider that cannot be constructed is a
 * degradation, not a hook crash.
 */
export async function resolveNominationDeps(): Promise<NominationDeps | null> {
  try {
    const config = await getConfiguration();
    const provider = config.embeddings?.provider || config.ai?.defaultProvider || "openai";

    // A non-semantic provider (the hash-based `local` dev stub) still resolves a
    // service; the flag is what stops nomination scoring against it, so the
    // caller emits the specific `non-semantic-provider` degraded reason rather
    // than a generic one.
    return {
      embeddingService: await createEmbeddingServiceFromConfig(),
      semantic: isSemanticProvider(provider),
    };
  } catch (error) {
    // intentional-swallow: an unconfigured or unconstructable provider is a
    // degraded nomination path, not a hook failure. The caller converts `null`
    // into a `provider-unconfigured` degraded result and still injects its
    // Rung-1 findings, per ADR-024's fail-to-Rung-1 invariant. Surfacing the
    // detail keeps the cause diagnosable without coupling this module to a
    // logger the hook process may not have configured.
    void error;
    return null;
  }
}
