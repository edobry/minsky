/**
 * Observability Configuration Schema
 *
 * Defines the schema for LLM-observability provider configuration. Mirrors the
 * `ai.providers.*` shape from `ai.ts` — observability providers are credentialed
 * external services (analogous to AI providers) with API keys, optional file-based
 * key references, and per-provider settings.
 *
 * First provider: Braintrust. Extensible to Langfuse / Phoenix / PostHog later
 * if the ≥3-option-evaluation bar from `decision-defaults.mdc §Build vs buy` is
 * met for adding a second provider.
 *
 * @see decision-defaults.mdc §Build vs buy
 * @see principal-context.mdc — framework context for tool selection
 * @see mt#1791 — originating task
 * @see mt#1778 — parent observability strategy task
 */

import { z } from "zod";
import { baseSchemas } from "./base";

/**
 * Base observability provider configuration. All providers extend this.
 */
export const observabilityProviderConfigSchema = z.object({
  // API key for the provider (sensitive; masked by config.show per mt#1262)
  apiKey: baseSchemas.optionalNonEmptyString,

  // Path to file containing the API key (alternative to inline apiKey)
  apiKeyFile: baseSchemas.optionalNonEmptyString,

  // Whether this provider is enabled
  enabled: z.boolean().default(true),

  // Base URL for the provider's API (override for self-host or alternate region)
  apiUrl: baseSchemas.url.optional(),
});

/**
 * Braintrust-specific configuration. Extends the base provider shape with
 * project routing and a default api URL.
 */
export const braintrustConfigSchema = observabilityProviderConfigSchema.extend({
  // Braintrust project to log traces and events into. Defaults to "minsky"
  // so a fresh setup ships to a project named for the product.
  projectName: z.string().min(1).default("minsky"),

  // Braintrust API base URL. Defaults to the hosted cloud endpoint.
  apiUrl: baseSchemas.url.default("https://api.braintrust.dev"),
});

/**
 * All observability providers configuration. Add additional provider keys
 * here when crossing the ≥3-option-evaluation bar in decision-defaults.mdc.
 */
export const observabilityProvidersConfigSchema = z.object({
  braintrust: braintrustConfigSchema.optional(),
});

/**
 * Complete observability configuration with default-provider selection.
 *
 * `defaultProvider` is informational — runtime emission code reads the
 * specific provider config (e.g. `observability.providers.braintrust`)
 * directly. The field is here to support future multi-provider routing
 * without a breaking schema change.
 */
export const observabilityConfigSchema = z
  .looseObject({
    // Default observability provider when multiple are configured
    defaultProvider: z.enum(["braintrust"]).optional(),

    // Provider-specific configurations
    providers: observabilityProvidersConfigSchema.default({}),
  })
  .default({
    providers: {},
  });

// Type exports
export type ObservabilityProviderConfig = z.infer<typeof observabilityProviderConfigSchema>;
export type BraintrustConfig = z.infer<typeof braintrustConfigSchema>;
export type ObservabilityProvidersConfig = z.infer<typeof observabilityProvidersConfigSchema>;
export type ObservabilityConfig = z.infer<typeof observabilityConfigSchema>;

/**
 * Validation helpers for observability configuration.
 */
export const observabilityValidation = {
  /**
   * Check if a provider has an API key configured (inline or file).
   */
  hasApiKey: (config: ObservabilityProviderConfig): boolean => {
    return !!(config.apiKey || config.apiKeyFile);
  },

  /**
   * Check if a provider is enabled AND has a usable credential.
   */
  isProviderReady: (config: ObservabilityProviderConfig): boolean => {
    return config.enabled && observabilityValidation.hasApiKey(config);
  },

  /**
   * Get all enabled providers.
   */
  getEnabledProviders: (config: ObservabilityConfig): string[] => {
    const providers: string[] = [];
    if (config.providers.braintrust?.enabled) providers.push("braintrust");
    return providers;
  },

  /**
   * Get all ready providers (enabled + have API keys).
   */
  getReadyProviders: (config: ObservabilityConfig): string[] => {
    const providers: string[] = [];
    if (
      config.providers.braintrust &&
      observabilityValidation.isProviderReady(config.providers.braintrust)
    ) {
      providers.push("braintrust");
    }
    return providers;
  },

  /**
   * Get the effective default provider — explicit if set, otherwise the
   * first ready provider.
   */
  getDefaultProvider: (config: ObservabilityConfig): string | null => {
    if (config.defaultProvider) return config.defaultProvider;
    const ready = observabilityValidation.getReadyProviders(config);
    return ready[0] ?? null;
  },
} as const;

/**
 * Environment variable to configuration path mapping.
 * Wired into the central env-var table in `sources/environment.ts`.
 */
export const observabilityEnvMapping = {
  BRAINTRUST_API_KEY: "observability.providers.braintrust.apiKey",
  BRAINTRUST_PROJECT_NAME: "observability.providers.braintrust.projectName",
  BRAINTRUST_API_URL: "observability.providers.braintrust.apiUrl",
} as const;
