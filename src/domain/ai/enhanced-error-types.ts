/**
 * Enhanced error types for AI completion services with detailed metadata
 * and user-friendly error handling.
 */

export class RateLimitError extends Error {
  public readonly retryAfter: number;
  public readonly remaining: number;
  public readonly limit: number;
  public readonly resetTime?: Date;
  public readonly provider: string;

  constructor(
    message: string,
    provider: string,
    retryAfter: number,
    remaining: number,
    limit: number,
    resetTime?: Date
  ) {
    super(message);
    this.name = "RateLimitError";
    this.provider = provider;
    this.retryAfter = retryAfter;
    this.remaining = remaining;
    this.limit = limit;
    this.resetTime = resetTime;
  }

  get retryAfterSeconds(): number {
    return this.retryAfter;
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

export class AuthenticationError extends Error {
  public readonly provider: string;
  public readonly code: string;
  public readonly type: "invalid_key" | "expired_key" | "unauthorized" | "forbidden";

  constructor(message: string, provider: string, code: string, type: AuthenticationError["type"]) {
    super(message);
    this.name = "AuthenticationError";
    this.provider = provider;
    this.code = code;
    this.type = type;
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

export class ServerError extends Error {
  public readonly provider: string;
  public readonly statusCode: number;
  public readonly isTransient: boolean;

  constructor(message: string, provider: string, statusCode: number, isTransient = true) {
    super(message);
    this.name = "ServerError";
    this.provider = provider;
    this.statusCode = statusCode;
    this.isTransient = isTransient;
  }
}

export class NetworkError extends Error {
  public readonly provider: string;
  public readonly code?: string;

  constructor(message: string, provider: string, code?: string) {
    super(message);
    this.name = "NetworkError";
    this.provider = provider;
    this.code = code;
  }
}
