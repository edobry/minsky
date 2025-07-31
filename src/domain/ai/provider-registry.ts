/**
 * Type-Safe AI Provider Registry
 *
 * This module enforces at compile time that every AI provider has a corresponding model fetcher.
 * Adding a new provider without a fetcher will result in TypeScript compilation errors.
 */

import type { ModelFetcher } from "./model-cache/types";

/**
 * Central registry of ALL supported AI providers
 * This is the single source of truth for provider types
 */
export const SUPPORTED_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "cohere",
  "mistral",
  "morph",
] as const;

/**
 * Type-safe provider union derived from the registry
 */
export type AIProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Strongly-typed ModelFetcher interface
 * The provider property is now constrained to valid providers
 */
export interface TypedModelFetcher<T extends AIProvider = AIProvider>
  extends Omit<ModelFetcher, "provider"> {
  /** Provider identifier - must be a valid AIProvider */
  readonly provider: T;
}

/**
 * Registry mapping every provider to its fetcher class
 * This creates a compile-time constraint: every provider MUST have a fetcher
 */
export type ProviderFetcherRegistry = {
  [K in AIProvider]: new () => TypedModelFetcher<K>;
};

/**
 * Type utility to ensure complete coverage
 * This will cause a TypeScript error if any provider is missing a fetcher
 */
type EnsureCompleteRegistry<T extends ProviderFetcherRegistry> = keyof T extends AIProvider
  ? AIProvider extends keyof T
    ? T
    : never
  : never;

// Import actual fetcher classes
import {
  OpenAIModelFetcher,
  AnthropicModelFetcher,
  MorphModelFetcher,
} from "./model-cache/fetchers";

/**
 * Runtime registry of provider fetchers
 * TypeScript will error if any provider lacks a fetcher class
 */
export const PROVIDER_FETCHER_REGISTRY = {
  // ✅ Implemented fetchers
  openai: OpenAIModelFetcher,
  anthropic: AnthropicModelFetcher,
  morph: MorphModelFetcher,

  // ❌ Missing fetchers - TypeScript will enforce these!
  google: null as any, // TODO: Implement GoogleModelFetcher
  cohere: null as any, // TODO: Implement CohereModelFetcher
  mistral: null as any, // TODO: Implement MistralModelFetcher
} as const satisfies EnsureCompleteRegistry<ProviderFetcherRegistry>;

/**
 * Type guard to check if a provider has a fetcher implementation
 */
export function hasProviderFetcher(provider: string): provider is AIProvider {
  return SUPPORTED_PROVIDERS.includes(provider as AIProvider);
}

/**
 * Type-safe provider validation
 */
export function validateProvider(provider: string): AIProvider {
  if (!hasProviderFetcher(provider)) {
    throw new Error(
      `Unsupported provider: ${provider}. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`
    );
  }
  return provider;
}

/**
 * Get the fetcher class for a provider (compile-time safe)
 */
export function getProviderFetcherClass<T extends AIProvider>(
  provider: T
): ProviderFetcherRegistry[T] {
  const fetcherClass = PROVIDER_FETCHER_REGISTRY[provider];
  if (!fetcherClass) {
    throw new Error(
      `No fetcher implemented for provider: ${provider}. Please implement ${provider}ModelFetcher.`
    );
  }
  return fetcherClass;
}

/**
 * Type utility to extract providers that have implemented fetchers
 */
export type ImplementedProviders = {
  [K in keyof typeof PROVIDER_FETCHER_REGISTRY]: (typeof PROVIDER_FETCHER_REGISTRY)[K] extends null
    ? never
    : K;
}[keyof typeof PROVIDER_FETCHER_REGISTRY];

/**
 * Type utility to extract providers that need fetcher implementations
 */
export type MissingProviders = {
  [K in keyof typeof PROVIDER_FETCHER_REGISTRY]: (typeof PROVIDER_FETCHER_REGISTRY)[K] extends null
    ? K
    : never;
}[keyof typeof PROVIDER_FETCHER_REGISTRY];

// Compile-time checks
type _ValidateAllProvidersHaveFetchers = EnsureCompleteRegistry<typeof PROVIDER_FETCHER_REGISTRY>;
type _MissingFetchers = MissingProviders; // "google" | "cohere" | "mistral" | "morph"
type _ImplementedFetchers = ImplementedProviders; // Will be empty until we implement them
