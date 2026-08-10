/**
 * Schema-derived credential listings (mt#3569).
 *
 * `listCredentials` reports one entry per registered {@link CredentialProvider} —
 * modules that own a credential's full lifecycle (acquire, validate, store, test).
 * That set is deliberately small and hand-registered, and it is the RIGHT answer to
 * "which credentials can I manage?"
 *
 * It is the WRONG answer to "which credentials exist?", which is what the command's
 * name and description led readers to ask it. `ai.providers.openai.apiKey` can be set
 * and working while no `openai` provider module exists, so the listing omitted it —
 * and absence read as proof of non-existence. That inference was drawn twice, once
 * escalating an unnecessary request to move a production credential.
 *
 * This module supplies the second half: every credential-bearing path the config
 * schema defines, whether or not a provider module backs it. Entries are marked
 * `source: "schema"` and are presence-only — see {@link CredentialListingSource}.
 *
 * Derived, not restated: the provider set comes from `AI_PROVIDER_IDS`, which is
 * `Object.keys()` over the schema's own shape. Adding a provider to the schema
 * surfaces it here with no edit, which is the property the previous hand-maintained
 * list lacked and why it drifted.
 */

import { AI_PROVIDER_IDS, aiProviderCredentialPaths } from "../configuration/schemas/ai";
import type { CredentialListing } from "./lifecycle";

/**
 * Human-readable names for schema-derived providers.
 *
 * A lookup miss is NOT a failure: `displayNameFor` falls back to capitalizing the
 * id, so a provider added to the schema still lists correctly with no edit here.
 * This map only improves presentation for names capitalization gets wrong.
 */
const DISPLAY_NAME_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google AI",
  cohere: "Cohere",
  mistral: "Mistral",
  morph: "Morph",
});

export function displayNameFor(providerId: string): string {
  const override = DISPLAY_NAME_OVERRIDES[providerId];
  if (override) return override;
  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

/**
 * True when `path` (dotted) resolves to a non-empty value in `config`.
 *
 * Deliberately a copy of `lifecycle.ts`'s private helper rather than an import:
 * importing it would require exporting an internal, and this module must not widen
 * that file's surface. Both are five lines of pure traversal with no shared state.
 */
function hasNestedValue(config: Record<string, unknown>, path: string): boolean {
  let current: unknown = config;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return false;
    const record = current as Record<string, unknown>;
    if (!(part in record)) return false;
    current = record[part];
  }
  return current !== undefined && current !== null && current !== "";
}

/**
 * One presence-only listing per credential-bearing provider the schema defines.
 *
 * `configured` is computed from the SAME source `listCredentials` uses for
 * provider entries — the user-level `config.yaml` — so the two halves of the merged
 * listing answer the same question. A key supplied only via an environment variable
 * therefore reports `configured: false` here, consistent with the existing
 * provider-entry semantics documented on `listCredentials`.
 *
 * `apiKey` and `apiKeyFile` both count, matching `aiValidation.hasApiKey`.
 */
export function listSchemaDerivedCredentials(
  userConfig: Record<string, unknown>
): CredentialListing[] {
  return AI_PROVIDER_IDS.map((providerId) => {
    const paths = aiProviderCredentialPaths(providerId);
    const configured = paths.some((path) => hasNestedValue(userConfig, path));
    return {
      provider: providerId,
      displayName: displayNameFor(providerId),
      // The primary path is what an operator would set; apiKeyFile is the alternate.
      configPath: paths[0] ?? `ai.providers.${providerId}.apiKey`,
      configured,
      source: "schema" as const,
    };
  });
}

/**
 * Combine the two halves of the listing, provider entries winning on id collision.
 *
 * `anthropic` and `google` are in BOTH sets. The provider entry wins because it is
 * strictly richer — it carries `lastValidatedAt` / `lastValidationDetail` and backs
 * add/remove/recheck — so a collision must never downgrade a manageable credential
 * to presence-only.
 *
 * Pure, and separated from `listCredentials` for that reason: the merge is the part
 * with a rule worth testing, and reading `config.yaml` is not. Keeping it here means
 * its tests need no filesystem, no temp HOME, and no patching.
 */
export function mergeCredentialListings(
  fromProviders: readonly CredentialListing[],
  fromSchema: readonly CredentialListing[]
): CredentialListing[] {
  const claimed = new Set(fromProviders.map((entry) => entry.provider));
  return [...fromProviders, ...fromSchema.filter((entry) => !claimed.has(entry.provider))];
}
