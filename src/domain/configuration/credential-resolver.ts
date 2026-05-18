/**
 * Credential Resolver Service for Custom Configuration System
 *
 * Handles credential resolution using the new type-safe configuration system
 * while preserving existing credential management capabilities.
 */

import { get } from "./index";
import type { AIConfig } from "./schemas/ai";
import type { GitHubConfig } from "./schemas/github";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { consumeAndReportInvalidationNotice } from "../credentials/invalidations";

export type CredentialSource = "env" | "file" | "keychain" | "manual";

export interface CredentialConfig {
  source: CredentialSource;
  token?: string;
  token_file?: string;
  api_key?: string;
  api_key_file?: string;
}

function isCredentialConfig(
  obj: Record<string, unknown>
): obj is Record<string, unknown> & CredentialConfig {
  return (
    typeof obj.source === "string" && ["env", "file", "keychain", "manual"].includes(obj.source)
  );
}

export interface CredentialResolver {
  getCredential(service: "github"): Promise<string | undefined>;
  getAICredential(provider: string): Promise<string | undefined>;
  resolveCredentialFromConfig(credentialConfig: CredentialConfig): Promise<string | undefined>;
}

export class DefaultCredentialResolver implements CredentialResolver {
  /**
   * Get GitHub credential from configured sources
   */
  async getCredential(service: "github"): Promise<string | undefined> {
    if (service === "github") {
      const token = await this.getGitHubCredential();
      if (token) {
        // mt#1426: surface a one-line stderr notice if a prior recheck flagged
        // this credential as invalidated. Fire-and-forget — never blocks the
        // credential read on bookkeeping failures.
        await consumeAndReportInvalidationNotice("github");
      }
      return token;
    }
    return undefined;
  }

  /**
   * Get AI provider credential from configured sources
   */
  async getAICredential(provider: string): Promise<string | undefined> {
    try {
      const aiConfig = get("ai") as AIConfig;
      const providers = aiConfig?.providers as Record<string, unknown> | undefined;
      const providerConfig =
        providers?.[provider] !== null && typeof providers?.[provider] === "object"
          ? (providers[provider] as Record<string, unknown>)
          : null;
      const credentials =
        providerConfig?.credentials !== null &&
        typeof providerConfig?.credentials === "object" &&
        !Array.isArray(providerConfig?.credentials)
          ? (providerConfig.credentials as Record<string, unknown>)
          : null;

      if (!credentials || !isCredentialConfig(credentials)) {
        return undefined;
      }

      const token = await this.resolveCredentialFromConfig(credentials);
      if (token && (provider === "anthropic" || provider === "openai" || provider === "google")) {
        // mt#1426: stderr notice on invalidated AI credentials. Only fires for
        // providers that have a credential-lifecycle plugin (currently anthropic;
        // openai/google are listed as future surfaces of the same shape).
        await consumeAndReportInvalidationNotice(provider);
      }
      return token;
    } catch (error) {
      // If config path doesn't exist, return undefined
      return undefined;
    }
  }

  /**
   * Resolve credential from configuration object
   */
  async resolveCredentialFromConfig(
    credentialConfig: CredentialConfig
  ): Promise<string | undefined> {
    switch (credentialConfig.source) {
      case "env":
        return credentialConfig.token || credentialConfig.api_key;

      case "file":
        return this.resolveFileCredential(credentialConfig);

      case "keychain":
        throw new Error("System keychain credential resolution not yet implemented");

      case "manual":
        throw new Error("Interactive credential prompting not yet implemented");

      default:
        return undefined;
    }
  }

  /**
   * Get GitHub credential specifically
   */
  private async getGitHubCredential(): Promise<string | undefined> {
    try {
      const githubConfig = get("github") as GitHubConfig & Record<string, unknown>;
      const credentials =
        githubConfig?.credentials !== null &&
        typeof githubConfig?.credentials === "object" &&
        !Array.isArray(githubConfig?.credentials)
          ? (githubConfig.credentials as Record<string, unknown>)
          : null;
      if (!credentials || !isCredentialConfig(credentials)) {
        return undefined;
      }

      return this.resolveCredentialFromConfig(credentials);
    } catch (error) {
      // If config path doesn't exist, return undefined
      return undefined;
    }
  }

  /**
   * Resolve credential from file
   */
  private async resolveFileCredential(
    credentialConfig: CredentialConfig
  ): Promise<string | undefined> {
    // Check for direct token/api_key first
    if (credentialConfig.token) {
      return credentialConfig.token;
    }
    if (credentialConfig.api_key) {
      return credentialConfig.api_key;
    }

    // Resolve from file
    const filePath = credentialConfig.token_file || credentialConfig.api_key_file;
    if (!filePath) {
      return undefined;
    }

    const resolvedPath = this.resolveFilePath(filePath);

    if (!existsSync(resolvedPath)) {
      return undefined;
    }

    try {
      const content = readFileSync(resolvedPath, "utf8") as string;
      return content.trim() || undefined;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Resolve file path with home directory expansion
   */
  private resolveFilePath(filePath: string): string {
    if (filePath.startsWith("~/")) {
      return join(homedir(), filePath.slice(2));
    }
    return filePath;
  }
}
