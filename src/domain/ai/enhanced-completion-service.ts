import { AICompletionService, CompletionParams, CompletionResult, LanguageModel } from "./types";
import { DefaultAICompletionService } from "./completion-service";
import { IntelligentRetryService } from "./intelligent-retry-service";
import {
  RateLimitError,
  AuthenticationError,
  ServerError,
  NetworkError,
} from "./enhanced-error-types";
import { log } from "../../utils/logger.js";
import { CustomConfigFactory, initializeConfiguration } from "../configuration/index.js";

export class EnhancedAICompletionService implements AICompletionService {
  private defaultCompletionService: DefaultAICompletionService;
  private retryService: IntelligentRetryService;
  private configService: Awaited<ReturnType<typeof initializeConfiguration>>;

  constructor(
    defaultCompletionService: DefaultAICompletionService,
    retryService: IntelligentRetryService,
    configService: Awaited<ReturnType<typeof initializeConfiguration>>
  ) {
    this.defaultCompletionService = defaultCompletionService;
    this.retryService = retryService;
    this.configService = configService;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const { provider, model } = params;

    try {
      return await this.retryService.execute(
        async () => {
          const languageModel = await this.getLanguageModel(provider, model);
          return this.defaultCompletionService.completeWithModel(params, languageModel);
        },
        (error) => {
          if (error instanceof RateLimitError) {
            log.warn("Rate limit error encountered, retrying...", {
              error: error.message,
              retryAfter: error.retryAfterSeconds,
            });
            return true; // Retry on rate limit
          }
          if (error instanceof NetworkError) {
            log.warn("Network error encountered, retrying...", { error: error.message });
            return true; // Retry on network errors
          }
          if (error instanceof ServerError && error.statusCode && error.statusCode >= 500) {
            log.warn("Server error encountered, retrying...", {
              error: error.message,
              statusCode: error.statusCode,
            });
            return true; // Retry on 5xx server errors
          }
          return false; // Do not retry on other errors (e.g., AuthenticationError, client errors)
        }
      );
    } catch (error) {
      log.error("Failed to complete AI request after retries", { error });
      throw error; // Re-throw the final error
    }
  }

  private async getLanguageModel(provider?: string, model?: string): Promise<LanguageModel> {
    // Delegate to the original completion service for proper model resolution
    const defaultProvider = await this.configService.getDefaultProvider();
    const resolvedProvider = provider || defaultProvider;
    const providerConfig = await this.configService.getProviderConfig(resolvedProvider);

    if (!providerConfig) {
      throw new Error(`AI provider configuration not found for: ${resolvedProvider}`);
    }

    return this.defaultCompletionService.getLanguageModel(providerConfig, model);
  }
}
