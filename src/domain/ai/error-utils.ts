/**
 * AI Error Utilities
 *
 * Common error handling functions for AI operations.
 */

import { log } from "../../utils/logger";

// Re-export getErrorMessage from the canonical location
export { getErrorMessage } from "../../errors/index";

import { getErrorMessage } from "../../errors/index";

/**
 * Handle model refresh errors with user-friendly messages
 */
export function handleRefreshError(provider: string, error: any): void {
  const errorMessage = getErrorMessage(error);

  // Handle specific known error cases
  if (errorMessage.includes("HTTP 404") || errorMessage.includes("Not Found")) {
    if (provider === "anthropic") {
      log.cliWarn(
        `⚠️  ${provider}: API endpoint not found - this provider may not support model listing`
      );
    } else {
      log.cliWarn(`⚠️  ${provider}: Model listing endpoint not found`);
    }
  } else if (errorMessage.includes("HTTP 401") || errorMessage.includes("Unauthorized")) {
    log.cliError(`❌ ${provider}: Invalid API key - please check your configuration`);
  } else if (errorMessage.includes("HTTP 403") || errorMessage.includes("Forbidden")) {
    log.cliError(`❌ ${provider}: Access denied - please check your API key permissions`);
  } else if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("network")) {
    log.cliError(`❌ ${provider}: Network error - please check your internet connection`);
  } else if (errorMessage.includes("timeout")) {
    log.cliError(`❌ ${provider}: Request timeout - please try again later`);
  } else {
    log.cliError(`❌ ${provider}: ${errorMessage}`);
  }
}
