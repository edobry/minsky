/**
 * FallbackTokenProvider
 *
 * A simple TokenProvider implementation used when no GitHub App service account
 * is configured. All token requests return the human user's token.
 */

import type { TokenProvider, TokenRole } from "./token-provider";

export class FallbackTokenProvider implements TokenProvider {
  private readonly userToken: string;

  constructor(userToken: string) {
    this.userToken = userToken;
  }

  /**
   * Role-keyed token accessor. In fallback (no service account) mode every
   * role returns the user token, preserving backward-compatible behaviour.
   */
  async getToken(_role?: TokenRole, _repo?: string): Promise<string> {
    return this.userToken;
  }

  async getServiceToken(_repo?: string): Promise<string> {
    return this.userToken;
  }

  async getUserToken(): Promise<string> {
    return this.userToken;
  }

  async getServiceIdentity(_role?: TokenRole): Promise<null> {
    return null;
  }

  isServiceAccountConfigured(): boolean {
    return false;
  }
}
