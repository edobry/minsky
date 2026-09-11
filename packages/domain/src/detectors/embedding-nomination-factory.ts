/**
 * Config resolution for the Rung-2 nomination stage (mt#3408).
 *
 * Kept separate from `embedding-nomination.ts` so the scoring primitive stays
 * importable — and unit-testable — without pulling in the configuration and
 * provider-factory machinery. Consumers that need a live service call
 * `resolveNominationDeps`; tests inject `NominationDeps` directly.
 */

// The provider factory and the configuration system are tsyringe-decorated, so
// importing this module drags in a reflect polyfill requirement. Hook processes
// and standalone scripts that pull in a consumer of this file (e.g.
// `retrospective-trigger-scanner`) would otherwise crash at import time with
// "tsyringe requires a reflect polyfill" — which is how the replay harness
// broke when the scanner first took this dependency. Importing it HERE keeps
// the requirement with the module that creates it, rather than making every
// downstream consumer remember.
import "reflect-metadata";

import { createEmbeddingServiceFromConfig } from "../ai/embedding-service-factory";
import type { EmbeddingService } from "../ai/embeddings/types";
import { getConfiguration } from "../configuration";
import { getLoggableErrorSummary } from "../errors/index";
import { scrubText } from "../transcripts/credential-scrubber";
import { isSemanticProvider, type NominationDeps } from "./embedding-nomination";

/**
 * The slice of configuration the resolver reads. Structural rather than the
 * full `Configuration` so the configured-check is a pure function over a value
 * a test can hand it, and so the resolver's own tests never need the
 * process-global configuration singleton.
 */
export interface EmbeddingProviderConfigView {
  ai?: {
    defaultProvider?: string;
    providers?: {
      openai?: { apiKey?: string };
      google?: { apiKey?: string };
    };
  };
  embeddings?: {
    provider?: string;
  };
}

/**
 * What resolving the Rung-2 dependencies produced (mt#5051).
 *
 * Three arms, deliberately not `NominationDeps | null`. ADR-035 §Decision rule 3:
 * *"'Configured but failing' MUST be distinguishable from 'not configured.'"* —
 * `unconfigured` is the quiet, expected local/dev state (no key for the chosen
 * provider); `unavailable` is a fault (configuration never initialized, an
 * unsupported provider name, a constructor that threw) and carries the cause.
 * A bare `null` rendered both as one `provider-unconfigured` label in every
 * consumer, which is how 214 of 388 calibration records read "no provider" while
 * the actual cause was a process that never bootstrapped configuration (mt#5000).
 *
 * The discriminant is `kind`, matching `CognitionResult.kind` (ADR-007) and the
 * stale-state scan's `DepsStageOutcome.kind`; the `unavailable` arm's fields are
 * the same names `CognitionResult`'s degraded arm uses, so a later mt#1323
 * migration onto the cognition provider is a rename rather than a third
 * vocabulary. No `lastAttemptAt` (ADR-035 rule 4's third field): this resolver
 * is not memoized and never retries, so every call IS the attempt.
 */
export type NominationDepsResolution =
  | { kind: "resolved"; deps: NominationDeps }
  | { kind: "unconfigured"; provider: string }
  | { kind: "unavailable"; provider: string; reason: string };

/** The provider name the embedding factory will construct for this config. */
function resolveEmbeddingProviderName(config: EmbeddingProviderConfigView): string {
  return config.embeddings?.provider || config.ai?.defaultProvider || "openai";
}

/**
 * Whether the named embedding provider has what its service's `fromConfig()`
 * requires — the same key checks `OpenAIEmbeddingService.fromConfig` and
 * `GeminiEmbeddingService.fromConfig` perform before constructing, hoisted so
 * "no key" can be decided BEFORE construction instead of inferred from a throw.
 *
 * `local` is the hash stub and needs nothing. An unknown name returns true on
 * purpose: someone configured it, so it is a fault for construction to report
 * (`Embedding provider not supported: …`), not a healthy unconfigured state.
 */
export function isEmbeddingProviderConfigured(
  provider: string,
  config: EmbeddingProviderConfigView
): boolean {
  switch (provider) {
    case "openai":
      return Boolean(config.ai?.providers?.openai?.apiKey);
    case "gemini":
      return Boolean(config.ai?.providers?.google?.apiKey);
    default:
      return true;
  }
}

/**
 * One-line human rendering of a non-resolved outcome, for scripts' SKIP lines.
 * A script that printed "no embedding provider configured" over a configured-but-
 * broken provider was this task's defect in script form.
 */
export function describeNominationDepsResolution(
  resolution: Exclude<NominationDepsResolution, { kind: "resolved" }>
): string {
  return resolution.kind === "unconfigured"
    ? `unconfigured (${resolution.provider}: no key)`
    : `unavailable (${resolution.provider}): ${resolution.reason}`;
}

/** Injectable IO for {@link resolveNominationDeps}; production callers pass nothing. */
export interface ResolveNominationDepsIo {
  readConfig?: () => EmbeddingProviderConfigView;
  createService?: () => Promise<EmbeddingService>;
}

/**
 * Resolve the embedding service plus the semantic-provider flag from config.
 *
 * Never throws: every failure is an arm of {@link NominationDepsResolution}.
 * The caller treats anything but `resolved` as a degraded path (fall back to
 * Rung 1, still inject, log the marker) — and now says WHICH degraded path.
 * `reason` is credential-scrubbed here, at the source, because consumers persist
 * it into calibration records and render it into guard-health output.
 */
export async function resolveNominationDeps(
  io: ResolveNominationDepsIo = {}
): Promise<NominationDepsResolution> {
  const readConfig = io.readConfig ?? getConfiguration;
  const createService = io.createService ?? createEmbeddingServiceFromConfig;
  // "unknown" survives only when readConfig itself throws — configuration was
  // never initialized, so there is no provider name to report.
  let provider = "unknown";
  try {
    const config = readConfig();
    provider = resolveEmbeddingProviderName(config);
    if (!isEmbeddingProviderConfigured(provider, config)) {
      return { kind: "unconfigured", provider };
    }

    // A non-semantic provider (the hash-based `local` dev stub) still resolves a
    // service; the flag is what stops nomination scoring against it, so the
    // caller emits the specific `non-semantic-provider` degraded reason rather
    // than a generic one.
    return {
      kind: "resolved",
      deps: {
        embeddingService: await createService(),
        semantic: isSemanticProvider(provider),
      },
    };
  } catch (error) {
    return {
      kind: "unavailable",
      provider,
      reason: scrubText(getLoggableErrorSummary(error)).text,
    };
  }
}
