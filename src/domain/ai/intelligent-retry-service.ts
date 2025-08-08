/**
 * Intelligent Retry Service for AI Operations
 *
 * Provides sophisticated retry logic with:
 * - Exponential backoff with jitter
 * - Different strategies for different error types
 * - Circuit breaker pattern for persistent failures
 * - Comprehensive logging and metrics
 */

import { log } from "../../utils/logger.js";
import {
  RateLimitError,
  AuthenticationError,
  ServerError,
  NetworkError,
} from "./enhanced-error-types";

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  exponentialBase: number;
  jitterFactor: number;
  timeoutMs?: number;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attemptCount: number;
  totalDuration: number;
  retryLog: RetryAttempt[];
}

export interface RetryAttempt {
  attempt: number;
  timestamp: Date;
  delayMs?: number;
  error?: string;
  errorType?: string;
}

/**
 * Default retry configurations for different error types
 */
export const DEFAULT_RETRY_CONFIGS: Record<string, RetryConfig> = {
  rate_limit: {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 60000, // 1 minute max
    exponentialBase: 2,
    jitterFactor: 0.3,
  },
  server_error: {
    maxAttempts: 3,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
    exponentialBase: 2,
    jitterFactor: 0.2,
  },
  network_error: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 15000,
    exponentialBase: 1.5,
    jitterFactor: 0.4,
  },
  default: {
    maxAttempts: 2,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    exponentialBase: 2,
    jitterFactor: 0.1,
  },
};

export class IntelligentRetryService {
  private circuitBreaker = new Map<string, CircuitBreakerState>();

  /**
   * Execute operation with intelligent retry logic
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: {
      provider: string;
      operationType: string;
      customConfig?: Partial<RetryConfig>;
    }
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    const retryLog: RetryAttempt[] = [];
    const circuitKey = `${context.provider}:${context.operationType}`;

    // Check circuit breaker
    if (this.isCircuitOpen(circuitKey)) {
      const error = new Error(
        `Circuit breaker open for ${context.provider} ${context.operationType}`
      );
      return {
        success: false,
        error,
        attemptCount: 0,
        totalDuration: Date.now() - startTime,
        retryLog,
      };
    }

    let lastError: Error | undefined;
    let attempt = 0;

    while (true) {
      attempt++;
      const attemptStart = Date.now();

      try {
        log.debug(`AI retry attempt ${attempt}`, {
          provider: context.provider,
          operationType: context.operationType,
          circuitKey,
        });

        const result = await operation();

        // Success - reset circuit breaker
        this.recordSuccess(circuitKey);

        retryLog.push({
          attempt,
          timestamp: new Date(attemptStart),
        });

        return {
          success: true,
          result,
          attemptCount: attempt,
          totalDuration: Date.now() - startTime,
          retryLog,
        };
      } catch (error) {
        lastError = error as Error;
        const errorType = this.classifyError(lastError);
        const config = this.getRetryConfig(errorType, context.customConfig);

        retryLog.push({
          attempt,
          timestamp: new Date(attemptStart),
          error: lastError.message,
          errorType,
        });

        log.debug(`AI operation failed on attempt ${attempt}`, {
          provider: context.provider,
          errorType,
          errorMessage: lastError.message,
          willRetry: attempt < config.maxAttempts,
        });

        // Check if we should stop retrying
        if (!this.shouldRetry(lastError, attempt, config)) {
          this.recordFailure(circuitKey);
          break;
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt, config, lastError);

        retryLog[retryLog.length - 1].delayMs = delay;

        log.debug(`Retrying AI operation after ${delay}ms`, {
          provider: context.provider,
          attempt: attempt + 1,
          maxAttempts: config.maxAttempts,
        });

        await this.delay(delay);
      }
    }

    // All retries exhausted
    this.recordFailure(circuitKey);

    return {
      success: false,
      error: lastError || new Error("Unknown error"),
      attemptCount: attempt,
      totalDuration: Date.now() - startTime,
      retryLog,
    };
  }

  /**
   * Classify error to determine retry strategy
   */
  private classifyError(error: Error): string {
    if (error instanceof RateLimitError) return "rate_limit";
    if (error instanceof ServerError && error.isTransient) return "server_error";
    if (error instanceof NetworkError && error.isRetryable) return "network_error";
    if (error instanceof AuthenticationError) return "auth_error"; // Usually not retryable

    // Check error message patterns for untyped errors
    const message = error.message.toLowerCase();
    if (message.includes("rate limit") || message.includes("too many requests")) {
      return "rate_limit";
    }
    if (message.includes("timeout") || message.includes("network")) {
      return "network_error";
    }
    if (message.includes("server error") || message.includes("internal error")) {
      return "server_error";
    }

    return "default";
  }

  /**
   * Get retry configuration for error type
   */
  private getRetryConfig(errorType: string, customConfig?: Partial<RetryConfig>): RetryConfig {
    const baseConfig = DEFAULT_RETRY_CONFIGS[errorType] || DEFAULT_RETRY_CONFIGS.default;
    return { ...baseConfig, ...customConfig };
  }

  /**
   * Determine if we should retry based on error and attempt count
   */
  private shouldRetry(error: Error, attempt: number, config: RetryConfig): boolean {
    // Don't retry if we've hit max attempts
    if (attempt >= config.maxAttempts) {
      return false;
    }

    // Don't retry authentication errors
    if (error instanceof AuthenticationError) {
      return false;
    }

    // Don't retry non-transient server errors
    if (error instanceof ServerError && !error.isTransient) {
      return false;
    }

    // Don't retry non-retryable network errors
    if (error instanceof NetworkError && !error.isRetryable) {
      return false;
    }

    return true;
  }

  /**
   * Calculate delay for next retry attempt
   */
  private calculateDelay(attempt: number, config: RetryConfig, error?: Error): number {
    // For rate limits, use the specific retry-after if available
    if (error instanceof RateLimitError) {
      return error.getRetryDelay();
    }

    // Exponential backoff with jitter
    const exponentialDelay = config.baseDelayMs * Math.pow(config.exponentialBase, attempt - 1);
    const jitter = Math.random() * config.jitterFactor * exponentialDelay;
    const totalDelay = exponentialDelay + jitter;

    return Math.min(totalDelay, config.maxDelayMs);
  }

  /**
   * Simple circuit breaker implementation
   */
  private isCircuitOpen(key: string): boolean {
    const state = this.circuitBreaker.get(key);
    if (!state) return false;

    if (state.state === "open") {
      // Check if circuit should transition to half-open
      if (Date.now() > state.nextAttemptTime) {
        state.state = "half-open";
        return false;
      }
      return true;
    }

    return false;
  }

  private recordSuccess(key: string): void {
    const state = this.circuitBreaker.get(key);
    if (state) {
      state.failureCount = 0;
      state.state = "closed";
    }
  }

  private recordFailure(key: string): void {
    let state = this.circuitBreaker.get(key);
    if (!state) {
      state = {
        failureCount: 0,
        state: "closed",
        nextAttemptTime: 0,
      };
      this.circuitBreaker.set(key, state);
    }

    state.failureCount++;

    // Open circuit after 5 consecutive failures
    if (state.failureCount >= 5) {
      state.state = "open";
      state.nextAttemptTime = Date.now() + 300000; // 5 minutes

      log.warn(`Circuit breaker opened for ${key}`, {
        failureCount: state.failureCount,
        nextAttemptTime: new Date(state.nextAttemptTime),
      });
    }
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Reset circuit breaker state (for testing)
   */
  resetCircuitBreakers(): void {
    this.circuitBreaker.clear();
    log.debug("Circuit breakers reset");
  }

  /**
   * Reset circuit breaker for a specific provider
   */
  resetCircuitBreaker(provider: string): void {
    this.circuitBreaker.delete(provider);
    log.debug(`Circuit breaker reset for provider: ${provider}`);
  }

  /**
   * Get circuit breaker status for all providers
   */
  getCircuitBreakerStatus(): Record<string, CircuitBreakerState | null> {
    const status: Record<string, CircuitBreakerState | null> = {};
    for (const [key, state] of this.circuitBreaker.entries()) {
      status[key] = { ...state }; // Return copy to prevent mutation
    }
    return status;
  }

  /**
   * Force circuit breaker to closed state (recovery)
   */
  forceCircuitBreakerClosed(provider: string): void {
    this.circuitBreaker.set(provider, {
      failureCount: 0,
      state: "closed",
      nextAttemptTime: 0,
    });
    log.info(`Circuit breaker forced to closed state for provider: ${provider}`);
  }

  /**
   * Check if circuit breaker is healthy for a provider
   */
  isProviderHealthy(provider: string): boolean {
    const state = this.circuitBreaker.get(provider);
    return !state || state.state === "closed";
  }

  /**
   * Get health status for all providers
   */
  getProvidersHealth(): Record<
    string,
    {
      isHealthy: boolean;
      state: string;
      failureCount: number;
      nextAttemptTime?: Date;
    }
  > {
    const health: Record<string, any> = {};

    for (const [provider, state] of this.circuitBreaker.entries()) {
      health[provider] = {
        isHealthy: state.state === "closed",
        state: state.state,
        failureCount: state.failureCount,
        nextAttemptTime: state.nextAttemptTime > 0 ? new Date(state.nextAttemptTime) : undefined,
      };
    }

    return health;
  }
}

interface CircuitBreakerState {
  failureCount: number;
  state: "closed" | "open" | "half-open";
  nextAttemptTime: number;
}

// Export singleton instance
export const retryService = new IntelligentRetryService();
