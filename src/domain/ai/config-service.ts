/**
 * AI Configuration Service
 *
 * Integrates AI provider configuration with the existing Minsky configuration system.
 * Handles provider settings, credentials, and validation.
 */

import {
  AIConfigurationService,
  AIProviderConfig,
  AIModel,
  ValidationResult,
  ValidationError,
  ValidationWarning,
} from "./types";
import { enumSchemas } from "../configuration/schemas/base";
import { z } from "zod";
import { log } from "../../utils/logger";
import { processCwd } from "../../utils/process";

// Properly typed AI provider using existing enum
type AIProvider = z.infer<typeof enumSchemas.aiProvider>;

export class DefaultAIConfigurationService implements AIConfigurationService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config service interface varies between production and test implementations
  constructor(private configService: any) {} // Accept any config service for flexibility

  async getProviderConfig(provider: string): Promise<AIProviderConfig | null> {
    try {
      // Check if this is a mock config service with loadConfiguration method
      type ConfigServiceWithLoad = {
        loadConfiguration: (path: string) => Promise<{ resolved: Record<string, unknown> }>;
      };
      if ("loadConfiguration" in this.configService) {
        const result = await (this.configService as ConfigServiceWithLoad).loadConfiguration(
          processCwd()
        );
        const config = result.resolved;
        return await this.parseProviderConfig(provider, config);
      }

      // Use the real configuration provider's getConfig method
      const config = (
        this.configService as { getConfig: () => Record<string, unknown> }
      ).getConfig();
      return await this.parseProviderConfig(provider, config);
    } catch (error) {
      log.debug(`Failed to get provider config for ${provider}`, { error });
      return null;
    }
  }

  async setProviderConfig(_provider: string, _config: AIProviderConfig): Promise<void> {
    // Note: For now, we don't implement writing config back to files
    // This would be a future enhancement to modify YAML config files
    throw new Error("Setting provider config is not yet implemented");
  }

  async getDefaultProvider(): Promise<string> {
    try {
      type ConfigServiceWithLoad = {
        loadConfiguration: (path: string) => Promise<{
          resolved: { ai?: { defaultProvider?: string; default_provider?: string } };
        }>;
      };
      const result = await (this.configService as ConfigServiceWithLoad).loadConfiguration(
        processCwd()
      );
      const defaultProvider =
        result.resolved.ai?.defaultProvider || result.resolved.ai?.default_provider || "openai";
      return defaultProvider;
    } catch (error) {
      // Log at debug level only - this is expected when no config exists
      log.systemDebug("No default provider configured, using fallback: openai");
      return "openai";
    }
  }

  async setDefaultProvider(_provider: string): Promise<void> {
    // Note: For now, we don't implement writing config back to files
    throw new Error("Setting default provider is not yet implemented");
  }

  async validateProviderKey(provider: string, apiKey: string): Promise<boolean> {
    try {
      // For now, just validate the API key format
      // In a real implementation, this would make a test API call
      return this.validateAPIKeyFormat(provider, apiKey);
    } catch (error) {
      log.debug(`Failed to validate API key for ${provider}`, { error });
      return false;
    }
  }

  private validateAPIKeyFormat(provider: string, apiKey: string): boolean {
    // Basic format validation for known providers
    const formatMap: Record<string, RegExp> = {
      openai: /^sk-[a-zA-Z0-9_-]{20,}$/, // Allow dashes and underscores for modern keys
      anthropic: /^sk-ant-api03-[a-zA-Z0-9_-]{95}$/,
      google: /^AIza[0-9A-Za-z_-]{35}$/,
      cohere: /^[a-zA-Z0-9_-]+$/,
      mistral: /^[a-zA-Z0-9_-]+$/,
      morph: /^[a-zA-Z0-9_-]+$/, // Morph uses similar format to other providers
    };

    const pattern = formatMap[provider];
    return pattern ? pattern.test(apiKey) : true; // Allow unknown providers
  }

  private async getProviderCapabilities(provider: string) {
    // Return known capabilities for each provider
    const capabilityMap = {
      openai: [
        { name: "reasoning" as const, supported: true, maxTokens: 128000 },
        { name: "tool-calling" as const, supported: true },
        { name: "structured-output" as const, supported: true },
        { name: "image-input" as const, supported: true },
      ],
      anthropic: [
        { name: "reasoning" as const, supported: true, maxTokens: 200000 },
        { name: "tool-calling" as const, supported: true },
        { name: "prompt-caching" as const, supported: true },
        { name: "image-input" as const, supported: true },
      ],
      google: [
        { name: "reasoning" as const, supported: true, maxTokens: 1000000 },
        { name: "tool-calling" as const, supported: true },
        { name: "image-input" as const, supported: true },
      ],
      cohere: [
        { name: "tool-calling" as const, supported: true },
        { name: "structured-output" as const, supported: true },
      ],
      mistral: [
        { name: "tool-calling" as const, supported: true },
        { name: "structured-output" as const, supported: true },
      ],
      morph: [
        { name: "fast-apply" as const, supported: true, maxTokens: 32000 },
        { name: "reasoning" as const, supported: true, maxTokens: 32000 },
        { name: "structured-output" as const, supported: true },
      ],
    };

    return capabilityMap[provider as keyof typeof capabilityMap] || [];
  }

  private async parseProviderConfig(
    provider: string,
    config: any
  ): Promise<AIProviderConfig | null> {
    // Get provider-specific config from the unified configuration
    const providerConfig = config.ai?.providers?.[provider];

    // If no provider config exists, return null
    if (!providerConfig) {
      return null;
    }

    // Extract API key from unified config (schema-based configuration uses camelCase)
    const apiKey = providerConfig.apiKey || providerConfig.api_key; // Support both formats for compatibility

    // If no API key is available, we can't use this provider
    if (!apiKey) {
      return null;
    }

    // Create provider config from unified configuration (support both camelCase and snake_case)
    return {
      provider: provider as AIProvider,
      apiKey,
      baseURL: providerConfig.baseUrl || providerConfig.base_url,
      defaultModel: providerConfig.model || providerConfig.default_model,
      supportedCapabilities: await this.getProviderCapabilities(provider),
    };
  }
}
