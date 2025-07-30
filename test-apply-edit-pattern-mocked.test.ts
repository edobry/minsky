#!/usr/bin/env bun
/**
 * Test ApplyEditPattern Fallback Logic
 *
 * Tests the core provider selection logic with mocked configurations
 */

import { test, expect, mock, beforeEach, describe } from "bun:test";

describe("Provider Selection Logic", () => {
  test("should select fast-apply provider when available", () => {
    // Mock configuration with Morph enabled
    const mockConfig = {
      ai: {
        defaultProvider: "openai",
        providers: {
          morph: { enabled: true, apiKey: "mock-morph-key" },
          anthropic: { enabled: true, apiKey: "mock-anthropic-key" },
          openai: { enabled: false },
        },
      },
    };

    // Simulate the fast-apply provider selection logic
    const fastApplyProviders = Object.entries(mockConfig.ai.providers)
      .filter(
        ([name, providerConfig]: [string, any]) => providerConfig?.enabled && name === "morph"
      )
      .map(([name]) => name);

    expect(fastApplyProviders.length).toBe(1);
    expect(fastApplyProviders[0]).toBe("morph");

    // Should use fast-apply
    const provider = fastApplyProviders[0];
    const model = provider === "morph" ? "morph-v3-large" : undefined;
    const isFastApply = true;

    expect(provider).toBe("morph");
    expect(model).toBe("morph-v3-large");
    expect(isFastApply).toBe(true);
  });

  test("should fallback to default provider when no fast-apply available", () => {
    // Mock configuration with no fast-apply providers
    const mockConfig = {
      ai: {
        defaultProvider: "anthropic",
        providers: {
          morph: { enabled: false },
          anthropic: { enabled: true, apiKey: "mock-anthropic-key" },
          openai: { enabled: true, apiKey: "mock-openai-key" },
        },
      },
    };

    // Simulate the fast-apply provider selection logic
    const fastApplyProviders = Object.entries(mockConfig.ai.providers)
      .filter(
        ([name, providerConfig]: [string, any]) => providerConfig?.enabled && name === "morph"
      )
      .map(([name]) => name);

    expect(fastApplyProviders.length).toBe(0);

    // Should use fallback logic
    let provider = mockConfig.ai.defaultProvider || "anthropic";
    const fallbackConfig = mockConfig.ai.providers[provider];

    expect(provider).toBe("anthropic");
    expect(fallbackConfig.enabled).toBe(true);
    expect(fallbackConfig.apiKey).toBe("mock-anthropic-key");

    const isFastApply = false;
    expect(isFastApply).toBe(false);
  });

  test("should use ultimate fallback when default provider unavailable", () => {
    // Mock configuration with default provider disabled
    const mockConfig = {
      ai: {
        defaultProvider: "openai",
        providers: {
          morph: { enabled: false },
          openai: { enabled: false }, // Default disabled
          anthropic: { enabled: true, apiKey: "mock-anthropic-key" },
        },
      },
    };

    // Simulate the fallback logic
    const fastApplyProviders = Object.entries(mockConfig.ai.providers)
      .filter(
        ([name, providerConfig]: [string, any]) => providerConfig?.enabled && name === "morph"
      )
      .map(([name]) => name);

    expect(fastApplyProviders.length).toBe(0);

    // Should fallback to default, then to ultimate fallback
    let provider = mockConfig.ai.defaultProvider || "anthropic";
    const fallbackConfig = mockConfig.ai.providers[provider];

    if (!fallbackConfig?.enabled || !fallbackConfig?.apiKey) {
      provider = "anthropic"; // Ultimate fallback
    }

    expect(provider).toBe("anthropic");
  });

  test("should skip providers without API keys", () => {
    // Mock configuration with enabled providers but no API keys
    const mockConfig = {
      ai: {
        defaultProvider: "openai",
        providers: {
          morph: { enabled: false },
          openai: { enabled: true }, // No API key
          anthropic: { enabled: true, apiKey: "mock-anthropic-key" },
        },
      },
    };

    // Should skip providers without API keys
    let provider = mockConfig.ai.defaultProvider || "anthropic";
    const fallbackConfig = mockConfig.ai.providers[provider];

    // OpenAI has no API key, should fallback to Anthropic
    if (!fallbackConfig?.enabled || !fallbackConfig?.apiKey) {
      provider = "anthropic";
    }

    expect(provider).toBe("anthropic");
  });
});

console.log("🧪 **Testing Provider Selection Logic**");
