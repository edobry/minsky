/**
 * Auth module — token provider factory and exports.
 */

import type { TokenProvider } from "./token-provider";
import { FallbackTokenProvider } from "./fallback-token-provider";
import { GitHubAppTokenProvider } from "./github-app-token-provider";
import type { GitHubConfig } from "../configuration/schemas/github";

export type { TokenProvider };
export { FallbackTokenProvider } from "./fallback-token-provider";
export { GitHubAppTokenProvider } from "./github-app-token-provider";

/**
 * Creates the appropriate TokenProvider based on the GitHub configuration.
 *
 * If `config.serviceAccount` is present, returns a GitHubAppTokenProvider.
 * Otherwise returns a FallbackTokenProvider that uses the user token directly.
 *
 * When `config.reviewer.serviceAccount` is also present, the returned
 * GitHubAppTokenProvider performs dual-App routing: `getToken("reviewer")`
 * returns tokens from the reviewer App's installation.
 *
 * @param config - The resolved GitHub configuration section.
 * @param userToken - The human user's GitHub personal access token.
 */
export function createTokenProvider(config: GitHubConfig, userToken: string): TokenProvider {
  if (config.serviceAccount) {
    // Build optional reviewer App credentials when configured.
    const reviewerServiceAccount = config.reviewer?.serviceAccount;
    const reviewerConfig = reviewerServiceAccount
      ? {
          appId: reviewerServiceAccount.appId,
          installationId: reviewerServiceAccount.installationId,
          privateKeyFile: reviewerServiceAccount.privateKeyFile,
          privateKey: reviewerServiceAccount.privateKey,
        }
      : undefined;

    return new GitHubAppTokenProvider({
      appId: config.serviceAccount.appId,
      privateKeyFile: config.serviceAccount.privateKeyFile,
      privateKey: config.serviceAccount.privateKey,
      installationId: config.serviceAccount.installationId,
      userToken,
      reviewerConfig,
    });
  }

  return new FallbackTokenProvider(userToken);
}
