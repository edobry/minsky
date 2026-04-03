/**
 * AI Provider Operations
 *
 * Domain logic for provider-level operations: validation testing,
 * cache refresh orchestration, and provider status queries.
 */

import type { ResolvedConfig } from "../configuration/types";
import type { DefaultAICompletionService } from "./completion-service";
import type { DefaultAIConfigurationService } from "./config-service";
import type { DefaultModelCacheService } from "./model-cache";
import { getErrorMessage, handleRefreshError } from "./error-utils";
import { log } from "../../utils/logger";

export interface ProviderValidationResult {
  name: string;
  configured: boolean;
  hasApiKey: boolean;
  connectionTest: {
    attempted: boolean;
    successful: boolean;
    error?: string;
  };
}

/**
 * Test connectivity for a set of providers.
 *
 * @param completionService - The completion service to use for testing
 * @param aiConfig - The AI configuration section of the resolved config
 * @param providerNames - Provider names to test
 * @param options - Options controlling output behavior
 * @returns Array of per-provider validation results
 */
export async function testProviderConnectivity(
  completionService: DefaultAICompletionService,
  aiConfig: NonNullable<ResolvedConfig["ai"]>,
  providerNames: string[],
  options: { silent?: boolean } = {}
): Promise<ProviderValidationResult[]> {
  const results: ProviderValidationResult[] = [];

  for (const providerName of providerNames) {
    const providerConfig = aiConfig.providers?.[providerName];
    const providerResult: ProviderValidationResult = {
      name: providerName,
      configured: !!providerConfig,
      hasApiKey: !!providerConfig?.apiKey,
      connectionTest: {
        attempted: false,
        successful: false,
        error: undefined,
      },
    };

    if (providerConfig?.apiKey) {
      try {
        providerResult.connectionTest.attempted = true;
        if (!options.silent) log.cli(`Testing ${providerName}...`);

        await completionService.complete({
          prompt: "Hello",
          provider: providerName,
          maxTokens: 5,
        });

        providerResult.connectionTest.successful = true;
        if (!options.silent) log.cli(`✓ ${providerName} connection successful`);
      } catch (error) {
        providerResult.connectionTest.error =
          error instanceof Error ? error.message : String(error);
        if (!options.silent) {
          log.cliError(
            `✗ ${providerName} connection failed: ${providerResult.connectionTest.error}`
          );
        }
      }
    } else {
      if (!options.silent) {
        log.cliWarn(`⚠ ${providerName} not configured (missing API key)`);
      }
    }

    results.push(providerResult);
  }

  return results;
}

export interface RefreshResult {
  successCount: number;
  errors: string[];
}

/**
 * Refresh cached model data for a single provider.
 *
 * Validates the provider is configured and its cache is stale
 * (unless force is set), then performs the refresh.
 */
export async function refreshSingleProvider(
  configService: DefaultAIConfigurationService,
  cacheService: DefaultModelCacheService,
  provider: string,
  force: boolean
): Promise<void> {
  const providerConfig = await configService.getProviderConfig(provider);
  if (!providerConfig) {
    throw new Error(`Provider '${provider}' is not configured.`);
  }

  if (!providerConfig.apiKey) {
    throw new Error(
      `Provider '${provider}' is missing an API key. ` + "Please configure the API key first."
    );
  }

  if (!force && !(await cacheService.isCacheStale(provider))) {
    log.info(
      `Cache for provider '${provider}' is still fresh. ` + "Use --force to refresh anyway."
    );
    return;
  }

  log.info(`Refreshing models for provider: ${provider}`);
  try {
    await cacheService.refreshProvider(provider, {
      apiKey: providerConfig.apiKey!,
      baseURL: providerConfig.baseURL,
    });
    log.cli(`✓ Successfully refreshed models for ${provider}`);
  } catch (refreshError) {
    handleRefreshError(provider, refreshError);
    throw refreshError;
  }
}

/**
 * Refresh cached model data for all configured providers.
 *
 * Skips providers without API keys, and providers with fresh caches
 * (unless force is set). Returns counts of successes and failures.
 */
export async function refreshAllProviders(
  configService: DefaultAIConfigurationService,
  cacheService: DefaultModelCacheService,
  aiConfig: NonNullable<ResolvedConfig["ai"]>,
  force: boolean
): Promise<RefreshResult> {
  const providerConfigs: Record<string, any> = {};
  const configuredProviders = Object.keys(aiConfig.providers || {});

  for (const providerName of configuredProviders) {
    const providerConfig = await configService.getProviderConfig(providerName);
    if (providerConfig && providerConfig.apiKey) {
      if (force || (await cacheService.isCacheStale(providerName))) {
        providerConfigs[providerName] = {
          apiKey: providerConfig.apiKey,
          baseURL: providerConfig.baseURL,
        };
      }
    } else if (!providerConfig?.apiKey) {
      log.cliWarn(`Skipping ${providerName}: No API key configured`);
    }
  }

  if (Object.keys(providerConfigs).length === 0) {
    log.info("All provider caches are fresh. Use --force to refresh anyway.");
    return { successCount: 0, errors: [] };
  }

  log.info(`Refreshing models for ${Object.keys(providerConfigs).length} providers...`);

  let successCount = 0;
  const errors: string[] = [];

  for (const [providerName, config] of Object.entries(providerConfigs)) {
    try {
      await cacheService.refreshProvider(providerName, config);
      log.cli(`✓ Successfully refreshed models for ${providerName}`);
      successCount++;
    } catch (refreshError) {
      handleRefreshError(providerName, refreshError);
      errors.push(providerName);
    }
  }

  return { successCount, errors };
}

export interface ProviderStatusInfo {
  name: string;
  configured: boolean;
  hasApiKey: boolean;
  lastFetched: string | undefined;
  modelCount: number;
  lastSuccess: boolean | null;
  isStale: boolean;
  error: string | undefined;
}

/**
 * Get status information for all configured providers.
 */
export async function getProviderStatuses(
  configService: DefaultAIConfigurationService,
  cacheService: DefaultModelCacheService,
  aiConfig: NonNullable<ResolvedConfig["ai"]>
): Promise<ProviderStatusInfo[]> {
  const metadata = await cacheService.getCacheMetadata();
  const providers: ProviderStatusInfo[] = [];

  for (const providerName of Object.keys(aiConfig.providers || {})) {
    const providerConfig = await configService.getProviderConfig(providerName);
    const providerMetadata = metadata.providers[providerName];
    const isStale = await cacheService.isCacheStale(providerName);

    providers.push({
      name: providerName,
      configured: !!providerConfig,
      hasApiKey: !!providerConfig?.apiKey,
      lastFetched: providerMetadata?.lastFetched?.toISOString(),
      modelCount: providerMetadata?.modelCount || 0,
      lastSuccess: providerMetadata?.lastFetchSuccessful ?? null,
      isStale,
      error: providerMetadata?.lastError,
    });
  }

  return providers;
}

/**
 * Ensure AI providers are configured, throwing if not.
 */
export function requireAIProviders(config: ResolvedConfig): NonNullable<ResolvedConfig["ai"]> {
  const aiConfig = config.ai;
  if (!aiConfig?.providers) {
    throw new Error("No AI providers configured. Please configure at least one provider.");
  }
  return aiConfig;
}
