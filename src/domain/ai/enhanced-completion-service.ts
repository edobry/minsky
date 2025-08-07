import type { AICompletionService, CompletionRequest, CompletionResponse } from "./types";
import type { AIConfigurationService } from "../configuration";
import { DefaultAICompletionService } from "./completion-service";
import { IntelligentRetryService } from "./intelligent-retry-service";
import {
  RateLimitError,
  AuthenticationError,
  ServerError,
  NetworkError,
} from "./enhanced-error-types";

export class EnhancedAICompletionService implements AICompletionService {
  private readonly retryService: IntelligentRetryService;
  private readonly completionService: DefaultAICompletionService;

  constructor(private readonly configService: AIConfigurationService) {
    this.completionService = new DefaultAICompletionService(configService);
    this.retryService = new IntelligentRetryService();
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.retryService.executeWithRetry(async () => {
      try {
        return await this.completionService.complete(request);
      } catch (error) {
        // Enhanced error classification and handling
        if (error instanceof RateLimitError) {
          throw error; // Already properly typed
        }

        if (error instanceof AuthenticationError) {
          throw error; // Already properly typed
        }

        if (error instanceof ServerError) {
          if (error.isTransient) {
            throw error; // Retry will handle transient errors
          }
          throw error; // Don't retry non-transient server errors
        }

        if (error instanceof NetworkError) {
          throw error; // Retry will handle network errors
        }

        // Re-throw unknown errors
        throw error;
      }
    }, request.provider);
  }

  private async getLanguageModel(provider?: string, model?: string): Promise<any> {
    // Stub implementation - delegate to original service
    return {};
  }
}
