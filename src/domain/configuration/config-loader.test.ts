/**
 * Tests for configuration loader unified credential system
 * 
 * Verifies that AI credentials are automatically detected from environment variables
 * without requiring explicit source field declarations.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ConfigurationLoader } from "./config-loader";
import { ENV_VARS } from "./types";

describe("ConfigurationLoader Unified Credential System", () => {
  let loader: ConfigurationLoader;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    loader = new ConfigurationLoader();
    // Save original environment
    originalEnv = {
      [ENV_VARS.GITHUB_TOKEN]: process.env[ENV_VARS.GITHUB_TOKEN],
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY,
      COHERE_API_KEY: process.env.COHERE_API_KEY,
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
    };
  });

  afterEach(() => {
    // Restore original environment
    Object.keys(originalEnv).forEach(key => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
  });

  it("should load GitHub credentials from environment variables", async () => {
    // Set environment variable
    process.env[ENV_VARS.GITHUB_TOKEN] = "ghp_test123";

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify GitHub credentials are loaded (no source field required)
    expect(result.resolved.github?.credentials?.token).toBe("ghp_test123");
  });

  it("should load OpenAI credentials from environment variables", async () => {
    // Set environment variable
    process.env.OPENAI_API_KEY = "sk-test123";

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify OpenAI credentials are loaded
    expect(result.resolved.ai?.providers?.openai?.credentials?.api_key).toBe("sk-test123");
  });

  it("should load multiple AI provider credentials from environment variables", async () => {
    // Set multiple environment variables
    process.env.OPENAI_API_KEY = "sk-openai123";
    process.env.ANTHROPIC_API_KEY = "sk-ant-anthropic456";

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify all AI credentials are loaded
    expect(result.resolved.ai?.providers?.openai?.credentials?.api_key).toBe("sk-openai123");
    expect(result.resolved.ai?.providers?.anthropic?.credentials?.api_key).toBe("sk-ant-anthropic456");
  });

  it("should load all AI provider credentials when all environment variables are set", async () => {
    // Set all AI provider environment variables
    process.env.OPENAI_API_KEY = "sk-openai123";
    process.env.ANTHROPIC_API_KEY = "sk-ant-anthropic456";
    process.env.GOOGLE_AI_API_KEY = "AIza-google789";
    process.env.COHERE_API_KEY = "cohere-key-abc";
    process.env.MISTRAL_API_KEY = "mistral-key-xyz";

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify all AI providers have credentials
    const providers = result.resolved.ai?.providers;
    expect(providers?.openai?.credentials?.api_key).toBe("sk-openai123");
    expect(providers?.anthropic?.credentials?.api_key).toBe("sk-ant-anthropic456");
    expect(providers?.google?.credentials?.api_key).toBe("AIza-google789");
    expect(providers?.cohere?.credentials?.api_key).toBe("cohere-key-abc");
    expect(providers?.mistral?.credentials?.api_key).toBe("mistral-key-xyz");
  });

  it("should not add AI config when no AI environment variables are set", async () => {
    // Ensure no AI environment variables are set
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.COHERE_API_KEY;
    delete process.env.MISTRAL_API_KEY;

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify no AI config is added from environment
    expect(result.sources.environment.ai).toBeUndefined();
  });

  it("should demonstrate unified credential system - no source field required", async () => {
    // Set both GitHub and AI credentials
    process.env[ENV_VARS.GITHUB_TOKEN] = "ghp_test123";
    process.env.OPENAI_API_KEY = "sk-openai123";

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify both credentials are loaded using the same unified system
    expect(result.resolved.github?.credentials?.token).toBe("ghp_test123");
    expect(result.resolved.ai?.providers?.openai?.credentials?.api_key).toBe("sk-openai123");
    
    // Verify no source field is required or added
    expect(result.resolved.github?.credentials?.source).toBeUndefined();
    expect(result.resolved.ai?.providers?.openai?.credentials?.source).toBeUndefined();
  });
}); 
