/**
 * Intelligent retry service with exponential backoff and circuit breaker patterns.
 * Provides enterprise-grade reliability for AI completion requests.
 */

import { log } from "../../utils/logger.js";
import {
  RateLimitError,
  AuthenticationError,
  ServerError,
  NetworkError,
} from "./enhanced-error-types";

interface CircuitBreakerState {
  failureCount: number;
  state: "open" | "closed" | "half-open";
  nextAttemptTime: number;
}

export class IntelligentRetryService {
  private readonly maxRetries: number = 3;
  private readonly baseDelay: number = 1000; // 1 second
  private readonly maxDelay: number = 60000; // 60 seconds
  private readonly circuitBreakerThreshold: number = 5;
  private readonly circuitBreakerTimeout: number = 60000; // 1 minute

  private circuitBreaker = new Map<string, CircuitBreakerState>();

  constructor(options?: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    circuitBreakerThreshold?: number;
    circuitBreakerTimeout?: number;
  }) {
    this.maxRetries = options?.maxRetries ?? this.maxRetries;
    this.baseDelay = options?.baseDelay ?? this.baseDelay;
    this.maxDelay = options?.maxDelay ?? this.maxDelay;
    this.circuitBreakerThreshold = options?.circuitBreakerThreshold ?? this.circuitBreakerThreshold;
    this.circuitBreakerTimeout = options?.circuitBreakerTimeout ?? this.circuitBreakerTimeout;
  }

  async execute<T>(
    operation: () => Promise<T>,
    shouldRetry: (error: Error) => boolean,
    provider = "default"
  ): Promise<T> {
    // Check circuit breaker
    if (this.isCircuitOpen(provider)) {
      throw new Error(`Circuit breaker is open for provider: ${provider}. Try again later.`);
    }

    let lastError: Error;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await operation();

        // Success - reset circuit breaker
        this.recordSuccess(provider);

        return result;
      } catch (error) {
        lastError = error as Error;

        // Record failure
        this.recordFailure(provider);

        // Check if we should retry
        if (attempt < this.maxRetries && shouldRetry(lastError)) {
          const delay = this.calculateDelay(attempt, lastError);

          log.debug(
            `Retrying operation after ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`,
            {
              provider,
              error: lastError.message,
              delay,
            }
          );

          await this.sleep(delay);
          continue;
        }

        // No more retries or shouldn't retry
        break;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private isCircuitOpen(provider: string): boolean {
    const state = this.circuitBreaker.get(provider);
    if (!state) return false;

    if (state.state === "open") {
      if (Date.now() > state.nextAttemptTime) {
        // Transition to half-open
        state.state = "half-open";
        log.debug(`Circuit breaker transitioning to half-open for provider: ${provider}`);
        return false;
      }
      return true;
    }

    return false;
  }

  private recordSuccess(provider: string): void {
    const state = this.circuitBreaker.get(provider);
    if (state) {
      // Reset failure count and close circuit
      state.failureCount = 0;
      state.state = "closed";
      state.nextAttemptTime = 0;

      log.debug(`Circuit breaker reset for provider: ${provider}`);
    }
  }

  private recordFailure(provider: string): void {
    let state = this.circuitBreaker.get(provider);
    if (!state) {
      state = { failureCount: 0, state: "closed", nextAttemptTime: 0 };
      this.circuitBreaker.set(provider, state);
    }

    state.failureCount++;

    if (state.failureCount >= this.circuitBreakerThreshold && state.state === "closed") {
      // Open circuit breaker
      state.state = "open";
      state.nextAttemptTime = Date.now() + this.circuitBreakerTimeout;

      log.warn(`Circuit breaker opened for provider: ${provider}`, {
        failureCount: state.failureCount,
        nextAttemptTime: new Date(state.nextAttemptTime),
      });
    }
  }

  private calculateDelay(attempt: number, error: Error): number {
    // Base exponential backoff
    let delay = Math.min(this.baseDelay * Math.pow(2, attempt), this.maxDelay);

    // Special handling for rate limit errors
    if (error instanceof RateLimitError) {
      delay = Math.max(delay, error.retryAfterSeconds * 1000);
    }

    // Add jitter to prevent thundering herd
    delay = delay + Math.random() * 1000;

    return Math.floor(delay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
