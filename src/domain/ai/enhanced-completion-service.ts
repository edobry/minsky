import { AICompletionService, AICompletionRequest, AICompletionResponse, AIModel, ValidationResult } from "./types";
import { DefaultAICompletionService } from "./completion-service";
import { IntelligentRetryService } from "./intelligent-retry-service";
import {
  RateLimitError,
  AuthenticationError,
  ServerError,
  NetworkError,
} from "./enhanced-error-types";
import { log } from "../../utils/logger";

export class EnhancedAICompletionService implements AICompletionService {
  private defaultCompletionService: DefaultAICompletionService;
  private retryService: IntelligentRetryService;

  constructor(
    defaultCompletionService: DefaultAICompletionService,
    retryService: IntelligentRetryService
  ) {
    this.defaultCompletionService = defaultCompletionService;
    this.retryService = retryService;
  }

  async complete(params: AICompletionRequest): Promise<AICompletionResponse> {
    const { provider, model } = params;

    try {
      return await this.retryService.execute(
        async () => {
          return this.defaultCompletionService.complete(params);
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

  async *stream(request: AICompletionRequest): AsyncIterable<AICompletionResponse> {
    yield* this.defaultCompletionService.stream(request);
  }

  async generateObject(request: any): Promise<unknown> {
    return this.defaultCompletionService.generateObject(request);
  }

  async getAvailableModels(provider?: string): Promise<AIModel[]> {
    return this.defaultCompletionService.getAvailableModels(provider);
  }

  async validateConfiguration(): Promise<ValidationResult> {
    return this.defaultCompletionService.validateConfiguration();
  }
}