/**
 * TokenProvider Interface
 *
 * Abstracts GitHub token acquisition for both human users and service accounts
 * (GitHub Apps). Consumers call getServiceToken() for bot operations and
 * getUserToken() for operations that must be attributed to the human user.
 *
 * Role-keyed extension: callers may pass a `role` to `getToken()` to obtain a
 * token for a specific service-account identity. The two recognised roles are:
 *   - "implementer": the minsky-ai App (default; backward-compatible)
 *   - "reviewer":    the minsky-reviewer App when configured; falls back to
 *                    the implementer App in single-App deployments.
 */

/**
 * The set of recognized service-account roles.
 *
 * CRITICAL: scope expansion beyond these two values requires principal review.
 * Do NOT add new roles without updating mt#1509 and the sibling tasks
 * mt#1510/1511/1512.
 */
export type TokenRole = "implementer" | "reviewer";

/**
 * Provides GitHub API tokens for service and user contexts.
 */
export interface TokenProvider {
  /**
   * Returns a token for the specified service-account role.
   *
   * When `role` is omitted it defaults to "implementer" for backward
   * compatibility with existing callers.
   *
   * When `github.reviewer.serviceAccount` is configured, `role: "reviewer"`
   * returns a token from the minsky-reviewer App installation; otherwise both
   * roles return the single minsky-ai App token.
   *
   * @param role - Which service-account identity to use (default: "implementer").
   * @param repo - Optional repository name (owner/repo) to scope installation tokens.
   */
  getToken(role?: TokenRole, repo?: string): Promise<string>;

  /**
   * Returns a token for bot/service operations.
   * If no service account is configured, falls back to the user token.
   *
   * @param repo - Optional repository name (owner/repo) to scope installation tokens.
   * @deprecated Prefer `getToken(role?, repo?)`. This method remains for
   *   backward-compatibility and defaults to the "implementer" role.
   */
  getServiceToken(repo?: string): Promise<string>;

  /**
   * Returns the human user's GitHub token.
   */
  getUserToken(): Promise<string>;

  /**
   * Returns identity information for the service account, or null if none is configured.
   *
   * @param role - Which service-account identity to query (default: "implementer").
   *   When `role: "reviewer"` is passed and a reviewer App is configured, returns
   *   the reviewer App's identity. Otherwise falls back to the implementer App.
   */
  getServiceIdentity(role?: TokenRole): Promise<{ login: string; type: "app" | "user" } | null>;

  /**
   * Synchronous check: returns true if a service account is configured.
   */
  isServiceAccountConfigured(): boolean;

  /**
   * Synchronous check: returns true if the *specific* service-account role
   * is configured with its own credentials.
   *
   * - `"implementer"` → true iff a primary GitHub App service account is
   *   configured (i.e., `isServiceAccountConfigured()` is true).
   * - `"reviewer"`    → true iff a reviewer App service account is configured
   *   (i.e., `github.reviewer.serviceAccount` is present). Distinct from
   *   `getToken("reviewer")`, which silently falls back to the implementer
   *   App when reviewer is not configured. Callers that need to enforce a
   *   strict identity (e.g., APPROVE / REQUEST_CHANGES on a self-authored
   *   bot PR, where a fallback would re-introduce the self-approval bug)
   *   must check this method *before* calling `getToken("reviewer")`.
   */
  isRoleConfigured(role: TokenRole): boolean;
}
