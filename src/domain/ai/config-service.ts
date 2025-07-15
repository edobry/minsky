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
import { ConfigurationService } from "../configuration/types";
import { log } from "../../utils/logger";

export class DefaultAIConfigurationService implements AIConfigurationService {
  constructor(private configService: ConfigurationService) {}

  async getProviderConfig(provider: string): Promise<AIProviderConfig | null> {
    try {
      // Use the unified configuration system (no more bespoke credential resolution)
      const result = await (this.configService as any).loadConfiguration((process as any).cwd());
      const config = (result as any).resolved;

      // Get provider-specific config from the unified configuration
      const providerConfig = config.ai?.providers?.[provider];
      
      // If no provider config exists, return null
      if (!providerConfig) {
        return null;
      }

      // Extract API key from unified config (automatically populated by environment variable mapping)
      const apiKey = providerConfig.api_key;
      
      // If no API key is available, we can't use this provider
      if (!apiKey) {
        return null;
      }

      // Create provider config from unified configuration
      return {
        provider: provider as unknown,
        apiKey,
        baseURL: providerConfig.base_url,
        defaultModel: providerConfig.default_model,
        supportedCapabilities: await this.getProviderCapabilities(provider),
        enabled: providerConfig.enabled ?? true,
        models: providerConfig.models || [],
        maxTokens: providerConfig.max_tokens,
        temperature: providerConfig.temperature,
      } as AIProviderConfig;
    } catch (error) {
      log.debug(`Failed to get provider config for ${provider}`, { error });
      return null;
    }
  }

  async setProviderConfig(provider: string, config: AIProviderConfig): Promise<void> {
    // Note: For now, we don't implement writing config back to files
    // This would be a future enhancement to modify YAML config files
    throw new Error("Setting provider config is not yet implemented");
  }

  async getDefaultProvider(): Promise<string> {
    try {
      const result = await (this.configService as any).loadConfiguration((process as any).cwd());
      return (result.resolved.ai as any).default_provider || "openai";
    } catch (error) {
      log.error("Failed to get default provider", { error });
      return "openai";
    }
  }

  async setDefaultProvider(provider: string): Promise<void> {
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
      openai: /^sk-[a-zA-Z0-9]{20,}$/,
      anthropic: /^sk-ant-api03-[a-zA-Z0-9_-]{95}$/,
      google: /^AIza[0-9A-Za-z_-]{35}$/,
      cohere: /^[a-zA-Z0-9_-]+$/,
      mistral: /^[a-zA-Z0-9_-]+$/,
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
    };

    return capabilityMap[provider as keyof typeof capabilityMap] || [];
  }
}
