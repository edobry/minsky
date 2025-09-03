/**
 * AI Configuration Schema
 *
 * Defines the schema for AI provider configuration including API keys, models,
 * and provider-specific settings for OpenAI, Anthropic, Google, Cohere, and Mistral.
 */

import { z } from "zod";
import { baseSchemas, enumSchemas } from "./base";
/**
 * Detect unknown fields in an object and collect warnings (no immediate logging to avoid circular deps)
 */
const detectAndWarnUnknownFields = (data: any, schema: z.ZodObject<any>, context: string): any => {
  if (!data || typeof data !== "object") {
    return data;
  }

  const knownKeys = new Set(Object.keys(schema.shape));
  const dataKeys = Object.keys(data);
  const unknownKeys = dataKeys.filter((key) => !knownKeys.has(key));

  if (unknownKeys.length > 0) {
    // Store warning for later logging to avoid circular dependency during module initialization
    // Warning will be logged when the schema is actually used for parsing
    const warning = {
      context,
      unknownFields: unknownKeys,
      message: `Unknown fields in ${context}: ${unknownKeys.join(", ")}. These fields will be ignored.`,
    };
    queuedConfigWarnings.push(warning);
  }

  return data;
};

// Queue for configuration warnings to avoid circular dependency during module loading
const queuedConfigWarnings: Array<{
  context: string;
  unknownFields: string[];
  message: string;
}> = [];

/**
 * Flush queued configuration warnings - call this after logger is available
 */
export function flushConfigurationWarnings() {
  if (queuedConfigWarnings.length === 0) return;

  try {
    const { log } = require("../../../utils/logger");
    for (const warning of queuedConfigWarnings) {
      log.warn(warning.message);
    }
    queuedConfigWarnings.length = 0; // Clear the queue
  } catch (error) {
    // Logger not available, keep warnings queued
  }
}

/**
 * Individual AI provider configuration
 */
export const aiProviderConfigSchema = z
  .object({
    // API key for the provider
    apiKey: baseSchemas.optionalNonEmptyString,

    // Path to file containing the API key
    apiKeyFile: baseSchemas.optionalNonEmptyString,

    // Whether this provider is enabled
    enabled: z.boolean().default(true),

    // Default model to use for this provider
    model: baseSchemas.modelName.optional(),

    // Available models for this provider
    models: z.array(baseSchemas.modelName).default([]),

    // Base URL for the API (for custom endpoints)
    baseUrl: baseSchemas.url.optional(),

    // Maximum tokens for requests
    maxTokens: baseSchemas.maxTokens.optional(),

    // Temperature setting (0-2)
    temperature: baseSchemas.temperature.optional(),

    // Custom headers for API requests
    headers: z.record(z.string()).optional(),
  })
  .strip();

/**
 * OpenAI-specific configuration
 */
export const openaiConfigSchema = aiProviderConfigSchema
  .extend({
    // OpenAI-specific organization ID
    organization: baseSchemas.optionalNonEmptyString,
  })
  .strip();

/**
 * Anthropic-specific configuration
 */
export const anthropicConfigSchema = aiProviderConfigSchema
  .extend({
    // Anthropic-specific settings can be added here
  })
  .strip();

/**
 * Google-specific configuration
 */
export const googleConfigSchema = aiProviderConfigSchema
  .extend({
    // Google-specific settings can be added here
  })
  .strip();

/**
 * Cohere-specific configuration
 */
export const cohereConfigSchema = aiProviderConfigSchema
  .extend({
    // Cohere-specific settings can be added here
  })
  .strip();

/**
 * Mistral-specific configuration
 */
export const mistralConfigSchema = aiProviderConfigSchema
  .extend({
    // Mistral-specific settings can be added here
  })
  .strip();

/**
 * Morph-specific configuration
 */
export const morphConfigSchema = aiProviderConfigSchema
  .extend({
    // Default model for Morph (fast-apply models)
    model: z.string().default("morph-v3-large"),

    // Base URL defaults to Morph API
    baseUrl: z.string().default("https://api.morphllm.com/v1"),
  })
  .strict();

/**
 * All AI providers configuration with unknown field detection
 */
const baseAiProvidersSchema = z.object({
  openai: openaiConfigSchema.optional(),
  anthropic: anthropicConfigSchema.optional(),
  google: googleConfigSchema.optional(),
  cohere: cohereConfigSchema.optional(),
  mistral: mistralConfigSchema.optional(),
  morph: morphConfigSchema.optional(),
});

export const aiProvidersConfigSchema = z
  .any()
  .transform((data) => detectAndWarnUnknownFields(data, baseAiProvidersSchema, "ai.providers"))
  .pipe(baseAiProvidersSchema.strip());

/**
 * Complete AI configuration
 */
export const aiConfigSchema = z
  .object({
    // Default provider to use when no specific provider is requested
    defaultProvider: enumSchemas.aiProvider.optional(),

    // Provider-specific configurations
    providers: aiProvidersConfigSchema.default({}),
  })
  .passthrough() // Changed from .strict() to .passthrough() to allow unknown fields
  .default({
    providers: {},
  });

// Type exports
export type AIProviderConfig = z.infer<typeof aiProviderConfigSchema>;
export type OpenAIConfig = z.infer<typeof openaiConfigSchema>;
export type AnthropicConfig = z.infer<typeof anthropicConfigSchema>;
export type GoogleConfig = z.infer<typeof googleConfigSchema>;
export type CohereConfig = z.infer<typeof cohereConfigSchema>;
export type MistralConfig = z.infer<typeof mistralConfigSchema>;
export type MorphConfig = z.infer<typeof morphConfigSchema>;
export type AIProvidersConfig = z.infer<typeof aiProvidersConfigSchema>;
export type AIConfig = z.infer<typeof aiConfigSchema>;

/**
 * Validation functions for AI configuration
 */
export const aiValidation = {
  /**
   * Check if a provider has an API key configured
   */
  hasApiKey: (config: AIProviderConfig): boolean => {
    return !!(config.apiKey || config.apiKeyFile);
  },

  /**
   * Check if a provider is enabled and has valid configuration
   */
  isProviderReady: (config: AIProviderConfig): boolean => {
    return config.enabled && aiValidation.hasApiKey(config);
  },

  /**
   * Get all enabled providers
   */
  getEnabledProviders: (config: AIConfig): string[] => {
    const providers: string[] = [];

    if (config.providers.openai?.enabled) providers.push("openai");
    if (config.providers.anthropic?.enabled) providers.push("anthropic");
    if (config.providers.google?.enabled) providers.push("google");
    if (config.providers.cohere?.enabled) providers.push("cohere");
    if (config.providers.mistral?.enabled) providers.push("mistral");
    if (config.providers.morph?.enabled) providers.push("morph");

    return providers;
  },

  /**
   * Get all ready providers (enabled + have API keys)
   */
  getReadyProviders: (config: AIConfig): string[] => {
    const providers: string[] = [];

    if (config.providers.openai && aiValidation.isProviderReady(config.providers.openai)) {
      providers.push("openai");
    }
    if (config.providers.anthropic && aiValidation.isProviderReady(config.providers.anthropic)) {
      providers.push("anthropic");
    }
    if (config.providers.google && aiValidation.isProviderReady(config.providers.google)) {
      providers.push("google");
    }
    if (config.providers.cohere && aiValidation.isProviderReady(config.providers.cohere)) {
      providers.push("cohere");
    }
    if (config.providers.mistral && aiValidation.isProviderReady(config.providers.mistral)) {
      providers.push("mistral");
    }
    if (config.providers.morph && aiValidation.isProviderReady(config.providers.morph)) {
      providers.push("morph");
    }

    return providers;
  },

  /**
   * Get the effective default provider
   */
  getDefaultProvider: (config: AIConfig): string | null => {
    if (config.defaultProvider) {
      return config.defaultProvider;
    }

    // Fall back to first ready provider
    const readyProviders = aiValidation.getReadyProviders(config);
    return readyProviders.length > 0 ? readyProviders[0]! : null;
  },

  /**
   * Get provider configuration by name
   */
  getProviderConfig: (config: AIConfig, provider: string): AIProviderConfig | null => {
    switch (provider) {
      case "openai":
        return config.providers.openai || null;
      case "anthropic":
        return config.providers.anthropic || null;
      case "google":
        return config.providers.google || null;
      case "cohere":
        return config.providers.cohere || null;
      case "mistral":
        return config.providers.mistral || null;
      case "morph":
        return config.providers.morph || null;
      default:
        return null;
    }
  },
} as const;

/**
 * Environment variable mapping for AI configuration
 */
export const aiEnvMapping = {
  // OpenAI
  OPENAI_API_KEY: "ai.providers.openai.apiKey",
  OPENAI_ORGANIZATION: "ai.providers.openai.organization",
  OPENAI_BASE_URL: "ai.providers.openai.baseUrl",

  // Anthropic
  ANTHROPIC_API_KEY: "ai.providers.anthropic.apiKey",
  ANTHROPIC_BASE_URL: "ai.providers.anthropic.baseUrl",

  // Google AI
  GOOGLE_API_KEY: "ai.providers.google.apiKey",
  GOOGLE_AI_API_KEY: "ai.providers.google.apiKey",
  GOOGLE_PROJECT_ID: "ai.providers.google.projectId",

  // Cohere
  COHERE_API_KEY: "ai.providers.cohere.apiKey",

  // Mistral
  MISTRAL_API_KEY: "ai.providers.mistral.apiKey",

  // Morph
  MORPH_API_KEY: "ai.providers.morph.apiKey",
  MORPH_BASE_URL: "ai.providers.morph.baseUrl",

  // General AI settings
  AI_DEFAULT_PROVIDER: "ai.defaultProvider",
} as const;
