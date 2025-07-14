/**
 * Tests for configuration loader unified credential system
 * 
 * Verifies that credentials are automatically detected from environment variables
 * with names computed from config paths using generic mapping.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ConfigurationLoader } from "./config-loader";
import { ENV_VARS } from "./types";

describe("ConfigurationLoader Unified Credential System", () => {
  let loader: ConfigurationLoader;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    loader = new ConfigurationLoader();
    // Save original environment for any keys we'll modify in tests
    originalEnv = {};
  });

  afterEach(() => {
    // Restore original environment for any keys we modified
    Object.keys(originalEnv).forEach(key => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
  });

  function setTestEnvVar(key: string, value: string) {
    // Save original value before setting test value
    originalEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function clearTestEnvVar(key: string) {
    // Save original value before clearing
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }

  it("should load GitHub credentials from environment variables", async () => {
    // Test the generic mapping logic: GITHUB_TOKEN -> github.token
    setTestEnvVar("GITHUB_TOKEN", "ghp_test123");

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify GitHub credentials are loaded using generic mapping
    expect(result.resolved.github?.token).toBe("ghp_test123");
  });

  it("should load OpenAI credentials from environment variables", async () => {
    // Test the generic mapping logic: AI_PROVIDERS_OPENAI_API_KEY -> ai.providers.openai.api_key
    setTestEnvVar("AI_PROVIDERS_OPENAI_API_KEY", "sk-test123");

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify OpenAI credentials are loaded using generic mapping
    expect(result.resolved.ai?.providers?.openai?.api_key).toBe("sk-test123");
  });

  it("should load multiple AI provider credentials from environment variables", async () => {
    // Test generic mapping logic with multiple providers
    setTestEnvVar("AI_PROVIDERS_OPENAI_API_KEY", "sk-openai123");
    setTestEnvVar("AI_PROVIDERS_ANTHROPIC_API_KEY", "sk-ant-anthropic456");

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify both credentials are loaded using generic mapping
    expect(result.resolved.ai?.providers?.openai?.api_key).toBe("sk-openai123");
    expect(result.resolved.ai?.providers?.anthropic?.api_key).toBe("sk-ant-anthropic456");
  });

  it("should handle arbitrary environment variable mapping", async () => {
    // Test that any environment variable follows the generic mapping rule
    setTestEnvVar("CUSTOM_CONFIG_TEST_VALUE", "test123");

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify the generic mapping works: CUSTOM_CONFIG_TEST_VALUE -> custom.config.test.value
    expect((result.sources.environment as any).custom?.config?.test?.value).toBe("test123");
  });

  it("should not add config when no relevant environment variables are set", async () => {
    // Test that no config is added when no relevant environment variables exist
    clearTestEnvVar("AI_PROVIDERS_OPENAI_API_KEY");
    clearTestEnvVar("GITHUB_TOKEN");

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify no config sections are added from environment when no vars are set
    expect(result.sources.environment.ai).toBeUndefined();
    expect(result.sources.environment.github).toBeUndefined();
  });

  it("should demonstrate unified credential system with generic mapping", async () => {
    // Test that different credential types use the same generic mapping system
    setTestEnvVar("GITHUB_TOKEN", "ghp_test123");
    setTestEnvVar("AI_PROVIDERS_OPENAI_API_KEY", "sk-openai123");

    // Load configuration
    const result = await loader.loadConfiguration(process.cwd());

    // Verify both credentials use the same generic mapping logic
    expect(result.resolved.github?.token).toBe("ghp_test123");
    expect(result.resolved.ai?.providers?.openai?.api_key).toBe("sk-openai123");
  });
}); 
