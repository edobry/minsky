/**
 * AI Service Factory
 *
 * Factory functions for creating AI services from resolved configuration.
 * Eliminates repeated mock config service patterns in adapter code.
 */

import { DefaultAICompletionService } from "./completion-service";
import { DefaultAIConfigurationService } from "./config-service";
import { DefaultModelCacheService } from "./model-cache";
import { PROVIDER_FETCHER_REGISTRY } from "./provider-registry";
import { log } from "../../utils/logger";
import type { ResolvedConfig } from "../configuration/types";

/**
 * Wraps a resolved config into the shape expected by AI services.
 */
function wrapConfig(config: ResolvedConfig) {
  return {
    loadConfiguration: () => Promise.resolve({ resolved: config }),
  };
}

/**
 * Create an AI completion service from a resolved configuration.
 */
export function createCompletionService(config: ResolvedConfig): DefaultAICompletionService {
  return new DefaultAICompletionService(wrapConfig(config));
}

/**
 * Create an AI configuration service from a resolved configuration.
 */
export function createConfigService(config: ResolvedConfig): DefaultAIConfigurationService {
  return new DefaultAIConfigurationService(wrapConfig(config) as any);
}

/**
 * Create a model cache service with all available provider fetchers registered.
 */
export function createModelCacheServiceWithFetchers(): DefaultModelCacheService {
  const cacheService = new DefaultModelCacheService();

  Object.entries(PROVIDER_FETCHER_REGISTRY).forEach(([provider, FetcherClass]) => {
    if (FetcherClass && typeof FetcherClass === "function") {
      try {
        cacheService.registerFetcher(new FetcherClass());
        log.debug(`Registered model fetcher for provider: ${provider}`);
      } catch (error) {
        log.warn(`Failed to register model fetcher for provider ${provider}:`, error);
      }
    } else {
      log.warn(`No model fetcher implementation available for provider: ${provider}`);
    }
  });

  return cacheService;
}
