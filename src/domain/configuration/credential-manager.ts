/**
 * Credential manager for Minsky configuration system
 * 
 * Handles multiple credential sources:
 * 1. Environment variables (highest priority)
 * 2. Global config file credentials
 * 3. Interactive prompts (when needed)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CredentialManager, CredentialSource, GlobalUserConfig, ENV_VARS, CONFIG_PATHS } from "./types";

export class DefaultCredentialManager implements CredentialManager {
  /**
   * Get credential from available sources in order of precedence
   */
  async getCredential(service: "github"): Promise<string | null> {
    switch (service) {
    case "github":
      return this.getGitHubCredential();
    default:
      return null;
    }
  }

  /**
   * Set global credential with specified source
   */
  async setGlobalCredential(
    service: "github",
    source: CredentialSource,
    value?: string
  ): Promise<void> {
    switch (service) {
    case "github":
      await this.setGitHubCredential(source, value);
      break;
    default:
      throw new Error(`Unsupported credential service: ${service}`);
    }
  }

  /**
   * Prompt user for credential interactively
   */
  async promptForCredential(service: "github"): Promise<string> {
    switch (service) {
    case "github":
      return this.promptForGitHubToken();
    default:
      throw new Error(`Cannot prompt for unsupported service: ${service}`);
    }
  }

  /**
   * Get GitHub credential from multiple sources
   */
  private async getGitHubCredential(): Promise<string | null> {
    // 1. Check environment variable first
    const envToken = process.env[ENV_VARS.GITHUB_TOKEN];
    if (envToken) {
      return envToken;
    }

    // 2. Check global config file
    const globalConfig = await this.loadGlobalConfig();
    if (globalConfig?.credentials?.github?.token) {
      return globalConfig.credentials.github.token;
    }

    // 3. Check token file if configured
    if (globalConfig?.credentials?.github?.token_file) {
      const tokenFile = this.expandTilde(globalConfig.credentials.github.token_file);
      if (existsSync(tokenFile)) {
        try {
          return readFileSync(tokenFile, { encoding: "utf8" }).trim();
        } catch {
          // Silently ignore file read errors
        }
      }
    }

    return null;
  }

  /**
   * Set GitHub credential in global config
   */
  private async setGitHubCredential(source: CredentialSource, value?: string): Promise<void> {
    const globalConfig = (await this.loadGlobalConfig()) || this.createEmptyGlobalConfig();

    if (!globalConfig.credentials) {
      globalConfig.credentials = {};
    }

    if (!globalConfig.credentials.github) {
      globalConfig.credentials.github = { source };
    }

    globalConfig.credentials.github.source = source;

    if (source === "file" && value) {
      globalConfig.credentials.github.token = value;
    }

    if (source === "prompt" && value) {
      globalConfig.credentials.github.token = value;
    }

    await this.saveGlobalConfig(globalConfig);
  }

  /**
   * Prompt user for GitHub token
   */
  private async promptForGitHubToken(): Promise<string> {
    // In a real implementation, this would use a proper prompting library
    // For now, we'll throw an error indicating interactive input is needed
    throw new Error(
      "GitHub token required. Please set GITHUB_TOKEN environment variable or configure credentials with: minsky config credentials github --token <your-token>"
    );
  }

  /**
   * Load global configuration
   */
  private async loadGlobalConfig(): Promise<GlobalUserConfig | null> {
    const configPath = this.expandTilde(CONFIG_PATHS.GLOBAL_USER);
    
    if (!existsSync(configPath)) {
      return null;
    }

    try {
      const _content = readFileSync(configPath, { encoding: "utf8" });
      return parseYaml(_content) as GlobalUserConfig;
    } catch {
      return null;
    }
  }

  /**
   * Save global configuration
   */
  private async saveGlobalConfig(_config: GlobalUserConfig): Promise<void> {
    const configPath = this.expandTilde(CONFIG_PATHS.GLOBAL_USER);
    const configDir = dirname(configPath);

    // Ensure config directory exists
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    const yamlContent = stringifyYaml(_config, {
      indent: 2,
      lineWidth: 100
    });

    writeFileSync(configPath, yamlContent, { encoding: "utf8" });
  }

  /**
   * Create empty global config with defaults
   */
  private createEmptyGlobalConfig(): GlobalUserConfig {
    return {
      version: 1,
      credentials: {}
    };
  }

  /**
   * Expand tilde in file paths
   */
  private expandTilde(filePath: string): string {
    if (filePath.startsWith("~/")) {
      return join(homedir(), filePath.slice(2));
    }
    return filePath;
  }
} 
