/**
 * FallbackTokenProvider
 *
 * A simple TokenProvider implementation used when no GitHub App service account
 * is configured. All token requests return the human user's token.
 */

import type { TokenProvider } from "./token-provider";

export class FallbackTokenProvider implements TokenProvider {
  private readonly userToken: string;

  constructor(userToken: string) {
    this.userToken = userToken;
  }

  async getServiceToken(_repo?: string): Promise<string> {
    return this.userToken;
  }

  async getUserToken(): Promise<string> {
    return this.userToken;
  }

  async getServiceIdentity(): Promise<null> {
    return null;
  }

  isServiceAccountConfigured(): boolean {
    return false;
  }
}
