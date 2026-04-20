/**
 * TokenProvider Interface
 *
 * Abstracts GitHub token acquisition for both human users and service accounts
 * (GitHub Apps). Consumers call getServiceToken() for bot operations and
 * getUserToken() for operations that must be attributed to the human user.
 */

/**
 * Provides GitHub API tokens for service and user contexts.
 */
export interface TokenProvider {
  /**
   * Returns a token for bot/service operations.
   * If no service account is configured, falls back to the user token.
   *
   * @param repo - Optional repository name (owner/repo) to scope installation tokens.
   */
  getServiceToken(repo?: string): Promise<string>;

  /**
   * Returns the human user's GitHub token.
   */
  getUserToken(): Promise<string>;

  /**
   * Returns identity information for the service account, or null if none is configured.
   */
  getServiceIdentity(): Promise<{ login: string; type: "app" | "user" } | null>;

  /**
   * Synchronous check: returns true if a service account is configured.
   */
  isServiceAccountConfigured(): boolean;
}
