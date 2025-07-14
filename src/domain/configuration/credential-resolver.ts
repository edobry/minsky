/**
 * Credential Resolver Service for Node-Config Integration
 *
 * Handles credential resolution using node-config for configuration
 * while preserving existing credential management capabilities.
 */

import config from "config";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type CredentialSource = "environment" | "file" | "prompt";

export interface CredentialConfig {
  source: CredentialSource;
  token?: string;
  token_file?: string;
  api_key?: string;
  api_key_file?: string;
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
      return this.getGitHubCredential();
    }
    return undefined;
  }

  /**
   * Get AI provider credential from configured sources
   */
  async getAICredential(provider: string): Promise<string | undefined> {
    try {
      const aiConfig = config.get("ai") as any;
      const providerConfig = aiConfig?.providers?.[provider];
      
      if (!providerConfig?.credentials) {
        return undefined;
      }

      return this.resolveCredentialFromConfig(providerConfig.credentials);
    } catch (error) {
      // If config path doesn't exist, return undefined
      return undefined;
    }
  }

  /**
   * Resolve credential from configuration object
   */
  async resolveCredentialFromConfig(credentialConfig: CredentialConfig): Promise<string | undefined> {
    switch (credentialConfig.source) {
    case "environment":
      // Node-config will have already resolved environment variables
      return credentialConfig.token || credentialConfig.api_key;
      
    case "file":
      return this.resolveFileCredential(credentialConfig);
      
    case "prompt":
      // TODO: Implement interactive prompting
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
      const githubConfig = config.get("github") as any;
      if (!githubConfig?.credentials) {
        return undefined;
      }

      return this.resolveCredentialFromConfig(githubConfig.credentials);
    } catch (error) {
      // If config path doesn't exist, return undefined
      return undefined;
    }
  }

  /**
   * Resolve credential from file
   */
  private async resolveFileCredential(credentialConfig: CredentialConfig): Promise<string | undefined> {
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

// Export singleton instance
export const credentialResolver = new DefaultCredentialResolver(); 
