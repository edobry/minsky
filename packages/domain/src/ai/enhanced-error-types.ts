/**
 * Enhanced error types for AI completion services with detailed metadata
 * and user-friendly error handling.
 */

export class RateLimitError extends Error {
  public readonly provider: string;
  public readonly retryAfter: number; // seconds
  public readonly remaining: number;
  public readonly limit: number;
  public readonly resetTime?: Date;

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

  getUserFriendlyMessage(): string {
    if (this.resetTime) {
      const ms = Math.max(0, this.resetTime.getTime() - Date.now());
      const minutes = Math.ceil(ms / 60000);
      return `Rate limit exceeded for ${this.provider}. Retry in ${this.retryAfter}s (resets in ${minutes}m). Remaining ${this.remaining}/${this.limit}.`;
    }
    return `Rate limit exceeded for ${this.provider}. Retry in ${this.retryAfter}s. Remaining ${this.remaining}/${this.limit}.`;
  }
}

export type AuthenticationErrorType = "invalid_key" | "expired_key" | "unauthorized" | "forbidden";

export class AuthenticationError extends Error {
  public readonly provider: string;
  public readonly code: string;
  public readonly type: AuthenticationErrorType;

  constructor(message: string, provider: string, code: string, type: AuthenticationErrorType) {
    super(message);
    this.name = "AuthenticationError";
    this.provider = provider;
    this.code = code;
    this.type = type;
  }

  getUserFriendlyMessage(): string {
    const typeMessages: Record<AuthenticationErrorType, string> = {
      invalid_key: `Invalid API key for ${this.provider}`,
      expired_key: `Expired API key for ${this.provider}`,
      unauthorized: `Unauthorized access to ${this.provider}`,
      forbidden: `Access forbidden by ${this.provider}`,
    };
    return `${typeMessages[this.type]} – check your configuration and credentials.`;
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
