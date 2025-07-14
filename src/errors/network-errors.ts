const ALTERNATIVE_HTTP_PORT = 8082;

/**
 * Network Error Handling Utilities
 *
 * This module provides specialized error handling for network-related errors,
 * particularly for the MCP server startup.
 */

import { MinskyError } from "./base-errors";

import { DEFAULT_DEV_PORT, BYTES_PER_KB } from "../utils/constants";
/**
 * Error class for network-related errors
 */
export class NetworkError extends MinskyError {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly port?: number,
    public readonly host?: string,
    cause?: any
  ) {
    super(message, cause);
  }
}

/**
 * Error class specifically for port-in-use (EADDRINUSE) errors
 */
export class PortInUseError extends NetworkError {
  constructor(port: number, host: string = "localhost", cause?: any) {
    super(`Port ${port} is already in use.`, "EADDRINUSE", port, host, cause);
  }

  /**
   * Get suggested actions for resolving this error
   */
  getSuggestions(): string[] {
    const nextPort = this?.port ? this?.port + 1 : ALTERNATIVE_HTTP_PORT;
    const currentPort = this?.port || DEFAULT_DEV_PORT;

    return [
      `Use a different port: minsky mcp start --sse --port ${nextPort}`,
      `Check what process is using port ${currentPort}: lsof -i :${currentPort}`,
      `Stop the process using port ${currentPort} before retrying`,
    ];
  }
}

/**
 * Error class for permission-related network errors (EACCES)
 */
export class NetworkPermissionError extends NetworkError {
  constructor(port: number, host: string = "localhost", cause?: any) {
    super(`Permission denied when trying to use port ${port}.`, "EACCES", port, host, cause);
  }

  /**
   * Get suggested actions for resolving this error
   */
  getSuggestions(): string[] {
    return [
      `Use a port number above ${BYTES_PER_KB}: minsky mcp start --sse --port ${DEFAULT_DEV_PORT}`,
      "Run the command with elevated permissions (not recommended)",
    ];
  }
}

/**
 * Factory function to create appropriate network error instances based on error code
 *
 * @param error The original error
 * @param port The port that was being used
 * @param host The host that was being used
 * @returns A specialized network error
 */
export function createNetworkError(
  error: any,
  port: number,
  host: string = "localhost"
): NetworkError {
  // Ensure we have an Error object
  const originalError = error instanceof Error ? error : new Error(String(error as any));

  // Check for specific error types
  const errorCode = (originalError as unknown)?.code || "";

  switch (errorCode) {
  case "EADDRINUSE":
    return new PortInUseError(port, host, originalError);
  case "EACCES":
    return new NetworkPermissionError(port, host, originalError);
  default:
    return new NetworkError(`Network error: ${(originalError as unknown).message}`, errorCode, port, host, originalError);
  }
}

/**
 * Check if an error is a network error
 *
 * @param error The error to check
 * @returns Whether the error is a network error
 */
export function isNetworkError(error: any): boolean {
  if (!(error instanceof Error)) return false;

  // Check for typical network error codes
  const networkErrorCodes = [
    "EADDRINUSE",
    "EACCES",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ];

  return (networkErrorCodes as any).includes((error as any)?.code || "");
}

/**
 * Format a network error into a user-friendly message with suggestions
 *
 * @param error The network error
 * @param debug Whether to include debug information
 * @returns A formatted error message
 */
export function formatNetworkErrorMessage(error: NetworkError, debug: boolean = false): string {
  let message = `Error: ${(error as any).message}\n`;

  // Add suggestions if available
  if (error instanceof PortInUseError || error instanceof NetworkPermissionError) {
    message += "\nSuggestions:\n";
    message += (error
      .getSuggestions().map((s) => `- ${s}`) as unknown).join("\n");
  }

  // Add debug hint
  if (!debug) {
    message += "\n\nFor detailed error information, run with DEBUG=true.";
  }

  return message;
}
