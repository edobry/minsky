/**
 * Configured-model diagnostics for `config doctor` (mt#3389).
 *
 * A provider retires a model and the configured default silently rots. Nothing
 * checks it, so the failure first appears as an opaque per-call error at the
 * moment someone tries to use it — for `claude-3-5-sonnet-20241022` (retired
 * 2025-10-28) that was `Database error (COMPLETION_ERROR): AI completion
 * failed: model: claude-3-5-sonnet-20241022`, which names no cause an operator
 * can act on.
 *
 * The provider listing is already cached locally, so comparing the configured
 * defaults against it costs nothing at diagnostic time and turns that opaque
 * failure into a named finding before anyone hits it.
 *
 * Split out of `validate-doctor-commands.ts` (which is already past the
 * 400-line warn threshold) following the `doctor-fixes.ts` precedent for
 * doctor logic that lives in a sibling module. Pure functions — the IO
 * (reading config, reading the model cache) happens in `config.doctor`'s
 * execute handler and is passed in, matching `checkReviewerRetriggerReachability`
 * (mt#2660) and `checkGithubAppPermissionDrift` (mt#3218).
 */

import type { DoctorDiagnostic } from "./validate-doctor-commands";

const CHECK_NAME = "Configured Model Validity";

/** A provider's configured default model, as read from `ai.providers.<name>.model`. */
export interface ConfiguredProviderModel {
  provider: string;
  model: string;
}

/**
 * Collect every configured provider default from the AI config.
 *
 * Iterates the providers object generically rather than naming providers, so a
 * provider added to the schema later is covered without touching this code.
 */
export function collectConfiguredProviderModels(
  aiConfig: { providers?: Record<string, { model?: string } | undefined> } | undefined
): ConfiguredProviderModel[] {
  const providers = aiConfig?.providers;
  if (!providers) {
    return [];
  }

  return Object.entries(providers)
    .filter(([, providerConfig]) => typeof providerConfig?.model === "string")
    .map(([provider, providerConfig]) => ({
      provider,
      model: providerConfig?.model as string,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Compare configured provider defaults against the cached provider listings.
 *
 * A provider absent from the cache is reported as UNVERIFIABLE, never as
 * invalid. The cache is populated as a side effect of provider calls, so a
 * fresh machine has none — claiming those models are invalid there would make
 * the check cry wolf on every new install. Per mem#719, "a detector that emits
 * unmatchable output erodes the credibility of its own correct output," so the
 * unverifiable case is deliberately kept distinct from the failing case.
 *
 * Returns `warning`, not `error`: the cache can legitimately lag a provider's
 * listing, and `config doctor` reserves `error` for configuration that cannot
 * load or validate at all.
 */
export function checkConfiguredModelsAgainstListing(
  configured: ConfiguredProviderModel[],
  cachedByProvider: Record<string, { id: string }[]>
): DoctorDiagnostic {
  if (configured.length === 0) {
    return {
      check: CHECK_NAME,
      status: "pass",
      message: "No provider default models are configured — nothing to check.",
    };
  }

  const retired: ConfiguredProviderModel[] = [];
  const unverifiable: ConfiguredProviderModel[] = [];

  for (const entry of configured) {
    const listing = cachedByProvider[entry.provider];
    if (!listing || listing.length === 0) {
      unverifiable.push(entry);
      continue;
    }
    if (!listing.some((cached) => cached.id === entry.model)) {
      retired.push(entry);
    }
  }

  if (retired.length > 0) {
    const details = retired.map((e) => `${e.provider} → '${e.model}'`).join("; ");
    const unverifiableNote =
      unverifiable.length > 0
        ? ` Not checked (no cached listing): ${unverifiable.map((e) => e.provider).join(", ")}.`
        : "";

    return {
      check: CHECK_NAME,
      status: "warning",
      message:
        `Configured default model not found in the provider's model listing: ${details}. ` +
        "A call that falls through to this default will fail with an error naming the model " +
        `id rather than a configuration problem.${unverifiableNote}`,
      suggestion:
        "Set the provider's `model` to an id the listing returns " +
        "(`minsky ai models available --provider <name>`), or refresh a stale cache with " +
        "`minsky ai models refresh`.",
    };
  }

  if (unverifiable.length === configured.length) {
    return {
      check: CHECK_NAME,
      status: "pass",
      message:
        "Could not verify configured model ids — no cached model listing is available for " +
        `${unverifiable.map((e) => e.provider).join(", ")}. This is not a finding about the ` +
        "configured values; the check simply had nothing to compare against.",
      suggestion: "Run `minsky ai models refresh` to populate the listing, then re-run doctor.",
    };
  }

  const verified = configured.length - unverifiable.length;
  const unverifiableNote =
    unverifiable.length > 0
      ? ` Not checked (no cached listing): ${unverifiable.map((e) => e.provider).join(", ")}.`
      : "";

  return {
    check: CHECK_NAME,
    status: "pass",
    message: `All ${verified} verifiable configured model id(s) are present in their provider's listing.${unverifiableNote}`,
  };
}
