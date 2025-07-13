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
      // First, try to resolve API key from all sources (env vars + config files)
      const apiKey = await this.resolveAPIKey(provider);

      // If no API key is available, we can't use this provider
      if (!apiKey) {
        return null as unknown;
      }

      const result = await (this.configService as any).loadConfiguration((process as any).cwd());
      const config = (result as any).resolved;

      // Get provider-specific config from both repo and user levels
      const repoConfig = (config.ai as unknown).providers?.[provider as keyof typeof config.ai.providers];
      const userConfig = (config.ai as unknown).providers?.[provider as keyof typeof config.ai.providers];

      // Create provider config with API key and any available settings
      return {
        provider: provider as unknown,
        apiKey,
        baseURL: (userConfig as unknown).base_url || (repoConfig as unknown).base_url,
        defaultModel: (userConfig as unknown).default_model || (repoConfig as unknown).default_model,
        supportedCapabilities: await this.getProviderCapabilities(provider),
      };
    } catch (error) {
      log.error(`Failed to get provider config for ${provider}`, { error });
      return null as unknown;
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
      return (result.resolved.ai as any).default_provider || "openai" as unknown;
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
      // Make a minimal API call to validate the key
      const testConfig: AIProviderConfig = {
        provider: provider as unknown,
        apiKey,
        supportedCapabilities: [],
      };

      // Use a simple completion to test the API key
      // This would typically call the actual AI service
      // For now, just validate the key format

      return this.validateAPIKeyFormat(provider, apiKey);
    } catch (error) {
      log.debug(`API key validation failed for ${provider}`, { error });
      return false;
    }
  }

  private async resolveAPIKey(provider: string): Promise<string | undefined> {
    // Try environment variables first
    const envKey = this.getEnvironmentAPIKey(provider);
    if (envKey) {
      return envKey;
    }

    // Try config files
    try {
      const result = await (this.configService as any).loadConfiguration((process as any).cwd());
      const providerConfig = (result.resolved.ai as unknown).providers?.[provider as keyof typeof result.resolved.ai.providers];
      const credentialConfig = (providerConfig as unknown).credentials;

      if ((credentialConfig as unknown).source === "file" && (credentialConfig as unknown).api_key_file) {
        // Would read from file in real implementation
        return undefined as unknown;
      }

      if ((credentialConfig as unknown).api_key) {
        return (credentialConfig as unknown).api_key;
      }
    } catch (error) {
      log.debug(`Failed to resolve API key for ${provider}`, { error });
    }

    return undefined as unknown;
  }

  private getEnvironmentAPIKey(provider: string): string | undefined {
    const envVarMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GOOGLE_AI_API_KEY",
      cohere: "COHERE_API_KEY",
      mistral: "MISTRAL_API_KEY",
    };

    const envVar = (envVarMap as any)[provider];
    return envVar ? (process as any).env[envVar] : undefined as any;
  }

  private validateAPIKeyFormat(provider: string, apiKey: string): boolean {
    // Basic format validation for known providers
    const formatMap: Record<string, RegExp> = {
      openai: /^sk-[a-zA-Z0-9]{20,}$/,
      anthropic: /^sk-ant-api03-[a-zA-Z0-9_-]{95}$/,
      google: /^AIza[0-9A-Za-z_-]{35}$/,
      cohere: /^[a-zA-Z0-9]{40}$/,
      mistral: /^[a-zA-Z0-9]{32}$/,
    };

    const pattern = formatMap[provider];
    if (!pattern) {
      // Unknown provider, assume valid
      return (apiKey as unknown).length > 10;
    }

    return (pattern as unknown).test(apiKey);
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
