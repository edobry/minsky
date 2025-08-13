/**
 * Enhanced AI Error Types with Better Metadata and Handling
 *
 * This module provides improved error types that include:
 * - Detailed error metadata (retry information, rate limits, etc.)
 * - Better error classification
 * - Recovery strategies
 */

/**
 * Enhanced rate limit error with detailed retry information
 */
export class RateLimitError extends Error {
  public readonly provider: string;
  public readonly retryAfter: number; // seconds
  public readonly resetTime?: Date;
  public readonly remaining: number;
  public readonly limit: number;
  public readonly code = "RATE_LIMIT_ERROR";

  constructor(
    message: string,
    provider: string,
    options: {
      retryAfter: number;
      resetTime?: Date;
      remaining?: number;
      limit?: number;
      originalError?: Error;
    }
  ) {
    super(message);
    this.name = "RateLimitError";
    this.provider = provider;
    this.retryAfter = options.retryAfter;
    this.resetTime = options.resetTime;
    this.remaining = options.remaining ?? 0;
    this.limit = options.limit ?? 100;

    // Preserve original error stack
    if (options.originalError) {
      this.stack = options.originalError.stack;
    }
  }

  /**
   * Get suggested retry delay with jitter
   */
  getRetryDelay(): number {
    // Add 10-50% jitter to prevent thundering herd
    const jitter = Math.random() * 0.4 + 0.1;
    return Math.floor(this.retryAfter * 1000 * (1 + jitter));
  }

  /**
   * Check if we should retry based on current time
   */
  canRetryNow(): boolean {
    if (!this.resetTime) {
      return Date.now() > Date.now() + this.retryAfter * 1000;
    }
    return Date.now() > this.resetTime.getTime();
  }

  /**
   * Get human-readable retry message with actionable information
   */
  getUserFriendlyMessage(): string {
    if (this.resetTime) {
      const timeUntilReset = Math.max(0, this.resetTime.getTime() - Date.now());
      const minutesUntilReset = Math.ceil(timeUntilReset / 60000);
      return `Rate limit exceeded for ${this.provider}. Retry in ${this.retryAfter}s (limit resets in ${minutesUntilReset}m). Usage: ${this.remaining}/${this.limit} requests remaining.`;
    }
    return `Rate limit exceeded for ${this.provider}. Retry in ${this.retryAfter}s. Usage: ${this.remaining}/${this.limit} requests remaining.`;
  }

  /**
   * Get recovery suggestions
   */
  getRecoverySuggestions(): string[] {
    const suggestions = [
      `Wait ${this.retryAfter} seconds before retrying`,
      "Consider using a different AI provider if available",
    ];

    if (this.remaining === 0) {
      suggestions.push("Your rate limit quota is exhausted");
      if (this.resetTime) {
        const minutesUntilReset = Math.ceil((this.resetTime.getTime() - Date.now()) / 60000);
        suggestions.push(`Rate limit resets in ${minutesUntilReset} minutes`);
      }
    }

    return suggestions;
  }
}

/**
 * Enhanced authentication error with detailed information
 */
export class AuthenticationError extends Error {
  public readonly provider: string;
  public readonly code: string;
  public readonly type: "invalid_key" | "expired_key" | "unauthorized" | "forbidden";

  constructor(
    message: string,
    provider: string,
    code: string,
    type: "invalid_key" | "expired_key" | "unauthorized" | "forbidden" = "invalid_key"
  ) {
    super(message);
    this.name = "AuthenticationError";
    this.provider = provider;
    this.code = code;
    this.type = type;
  }

  /**
   * Get user-friendly suggestions for fixing the auth issue
   */
  getSuggestions(): string[] {
    switch (this.type) {
      case "invalid_key":
        return [
          `Check your ${this.provider} API key in .minskyrc`,
          `Verify the API key is correctly formatted`,
          `Generate a new API key from ${this.provider} dashboard`,
        ];
      case "expired_key":
        return [
          `Your ${this.provider} API key has expired`,
          `Generate a new API key from ${this.provider} dashboard`,
          `Update your .minskyrc with the new key`,
        ];
      case "unauthorized":
        return [
          `Your ${this.provider} API key doesn't have required permissions`,
          `Check your account status and billing`,
          `Contact ${this.provider} support if the issue persists`,
        ];
      default:
        return [`Check your ${this.provider} configuration`];
    }
  }

  /**
   * Get user-friendly error message with context
   */
  getUserFriendlyMessage(): string {
    const typeMessages = {
      invalid_key: `Invalid API key for ${this.provider}`,
      expired_key: `Expired API key for ${this.provider}`,
      unauthorized: `Unauthorized access to ${this.provider}`,
      forbidden: `Access forbidden by ${this.provider}`,
    };
    return `${typeMessages[this.type] || `Authentication error with ${this.provider}`}. Check your API key configuration.`;
  }
}

/**
 * Enhanced server error with categorization
 */
export class ServerError extends Error {
  public readonly provider: string;
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isTransient: boolean;

  constructor(
    message: string,
    provider: string,
    statusCode: number,
    code: string = "SERVER_ERROR"
  ) {
    super(message);
    this.name = "ServerError";
    this.provider = provider;
    this.statusCode = statusCode;
    this.code = code;

    // Determine if error is likely transient
    this.isTransient = this.determineTransience(statusCode);
  }

  private determineTransience(statusCode: number): boolean {
    // 5xx errors are usually transient, 4xx are usually permanent
    return statusCode >= 500 || statusCode === 408 || statusCode === 429;
  }

  /**
   * Get suggested retry strategy
   */
  getRetryStrategy(): { shouldRetry: boolean; delayMs: number; maxAttempts: number } {
    if (!this.isTransient) {
      return { shouldRetry: false, delayMs: 0, maxAttempts: 0 };
    }

    // Exponential backoff for transient errors
    return {
      shouldRetry: true,
      delayMs: 1000, // Start with 1 second
      maxAttempts: 3,
    };
  }
}

/**
 * Enhanced network error for connection issues
 */
export class NetworkError extends Error {
  public readonly provider: string;
  public readonly type: "timeout" | "connection_refused" | "dns_error" | "unknown";
  public readonly isRetryable: boolean;

  constructor(
    message: string,
    provider: string,
    type: "timeout" | "connection_refused" | "dns_error" | "unknown" = "unknown"
  ) {
    super(message);
    this.name = "NetworkError";
    this.provider = provider;
    this.type = type;
    this.isRetryable = type === "timeout" || type === "connection_refused";
  }

  /**
   * Get retry configuration for network errors
   */
  getRetryConfig(): { maxAttempts: number; baseDelayMs: number } {
    switch (this.type) {
      case "timeout":
        return { maxAttempts: 3, baseDelayMs: 2000 };
      case "connection_refused":
        return { maxAttempts: 2, baseDelayMs: 5000 };
      default:
        return { maxAttempts: 1, baseDelayMs: 1000 };
    }
  }
}

/**
 * Utility to parse HTTP response errors and create appropriate error types
 */
export class AIErrorParser {
  /**
   * Parse HTTP response and headers to create appropriate error
   */
  static parseHttpError(
    response: Response,
    provider: string,
    responseBody?: any
  ): RateLimitError | AuthenticationError | ServerError | Error {
    const status = response.status;
    const headers = response.headers;

    // Rate limiting (429)
    if (status === 429) {
      const retryAfter = this.parseRetryAfter(headers.get("retry-after"));
      const resetTime = this.parseResetTime(headers.get("x-ratelimit-reset"));
      const remaining = parseInt(headers.get("x-ratelimit-remaining") || "0");
      const limit = parseInt(headers.get("x-ratelimit-limit") || "100");

      const message =
        responseBody?.detail ||
        responseBody?.error?.message ||
        `Rate limit exceeded for ${provider}`;

      return new RateLimitError(message, provider, {
        retryAfter,
        resetTime,
        remaining,
        limit,
      });
    }

    // Authentication errors (401, 403)
    if (status === 401 || status === 403) {
      const errorCode = responseBody?.error?.code || "AUTHENTICATION_ERROR";
      const message =
        responseBody?.error?.message ||
        responseBody?.detail ||
        `Authentication failed for ${provider}`;

      let type: "invalid_key" | "expired_key" | "unauthorized" | "forbidden";
      if (status === 403) {
        type = "forbidden";
      } else if (message.toLowerCase().includes("expired")) {
        type = "expired_key";
      } else if (message.toLowerCase().includes("unauthorized")) {
        type = "unauthorized";
      } else {
        type = "invalid_key";
      }

      return new AuthenticationError(message, provider, errorCode, type);
    }

    // Server errors (5xx)
    if (status >= 500) {
      const errorCode = responseBody?.error?.code || "SERVER_ERROR";
      const message =
        responseBody?.error?.message || responseBody?.detail || `Server error from ${provider}`;

      return new ServerError(message, provider, status, errorCode);
    }

    // Client errors (4xx)
    if (status >= 400) {
      const message =
        responseBody?.error?.message ||
        responseBody?.detail ||
        `Bad request to ${provider}: ${response.statusText}`;
      return new Error(`${provider} API error (${status}): ${message}`);
    }

    // Generic error
    return new Error(`HTTP ${status} error from ${provider}: ${response.statusText}`);
  }

  /**
   * Parse network/fetch errors
   */
  static parseNetworkError(error: Error, provider: string): NetworkError | Error {
    const message = error.message.toLowerCase();

    if (message.includes("timeout")) {
      return new NetworkError(`Request timeout for ${provider}`, provider, "timeout");
    }

    if (message.includes("connection refused") || message.includes("econnrefused")) {
      return new NetworkError(`Connection refused by ${provider}`, provider, "connection_refused");
    }

    if (message.includes("dns") || message.includes("enotfound")) {
      return new NetworkError(`DNS resolution failed for ${provider}`, provider, "dns_error");
    }

    return new NetworkError(`Network error for ${provider}: ${error.message}`, provider, "unknown");
  }

  private static parseRetryAfter(retryAfterHeader: string | null): number {
    if (!retryAfterHeader) return 60; // Default 1 minute

    const parsed = parseInt(retryAfterHeader);
    return isNaN(parsed) ? 60 : parsed;
  }

  private static parseResetTime(resetHeader: string | null): Date | undefined {
    if (!resetHeader) return undefined;

    const parsed = parseInt(resetHeader);
    if (isNaN(parsed)) return undefined;

    // Unix timestamp
    return new Date(parsed * 1000);
  }
}
