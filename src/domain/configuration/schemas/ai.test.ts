import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { aiProvidersConfigSchema, aiConfigSchema } from "./ai";
import { mockLogger, resetMockLogger } from "../../../utils/test-utils/mock-logger";

describe.skip("AI Configuration Schema - Unknown Field Handling", () => {
  beforeEach(() => {
    resetMockLogger();
  });

  afterEach(() => {
    resetMockLogger();
  });

  test("should handle unknown AI providers gracefully", () => {
    const configWithUnknownProvider = {
      openai: {
        enabled: true,
        apiKey: "test-key",
      },
      morph: {
        enabled: true,
        apiKey: "morph-key",
        model: "morph-v3-large",
        baseUrl: "https://api.morphllm.com/v1",
      },
      unknownProvider: {
        enabled: true,
        apiKey: "unknown-key",
      },
    };

    const result = aiProvidersConfigSchema.safeParse(configWithUnknownProvider);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      morph: {
        apiKey: "morph-key",
        baseUrl: "https://api.morphllm.com/v1",
        enabled: true,
        model: "morph-v3-large",
        models: [],
      },
      openai: {
        apiKey: "test-key",
        enabled: true,
        models: [],
      },
    });

    // Should have logged a warning about unknown fields (only unknownProvider, not morph which is now valid)
    const warnCalls = mockLogger.warn.mock.calls;
    expect(warnCalls.length).toBeGreaterThan(0);
    const warningMessage = warnCalls[0][0];
    expect(warningMessage).toContain("Configuration Warning: Unknown fields in ai.providers:");
    expect(warningMessage).toContain("unknownProvider");
    expect(warningMessage).not.toContain("morph");
  });

  test("should not warn when all fields are known", () => {
    const validConfig = {
      openai: {
        enabled: true,
        apiKey: "test-key",
      },
      anthropic: {
        enabled: false,
      },
    };

    const result = aiProvidersConfigSchema.safeParse(validConfig);

    expect(result.success).toBe(true);
    const warnCalls = mockLogger.warn.mock.calls;
    expect(warnCalls.length).toBe(0);
  });

  test("should handle unknown fields in individual providers", () => {
    const configWithUnknownProviderFields = {
      openai: {
        enabled: true,
        apiKey: "test-key",
        unknownField: "should-be-stripped",
      },
    };

    const result = aiProvidersConfigSchema.safeParse(configWithUnknownProviderFields);

    expect(result.success).toBe(true);
    expect(result.data?.openai).not.toHaveProperty("unknownField");
  });

  test("should validate known fields correctly", () => {
    const configWithInvalidValues = {
      openai: {
        enabled: "not-a-boolean", // Invalid type
        apiKey: "test-key",
      },
    };

    const result = aiProvidersConfigSchema.safeParse(configWithInvalidValues);
    expect(result.success).toBe(false);
  });

  test("should handle complete AI config with unknown providers", () => {
    const aiConfigWithUnknown = {
      defaultProvider: "openai",
      providers: {
        openai: {
          enabled: true,
          apiKey: "test-key",
        },
        morph: {
          enabled: true,
          apiKey: "morph-key",
          model: "morph-v3-large",
          baseUrl: "https://api.morphllm.com/v1",
        },
      },
    };

    const result = aiConfigSchema.safeParse(aiConfigWithUnknown);

    expect(result.success).toBe(true);
    expect(result.data?.providers).toHaveProperty("morph");
    expect(result.data?.providers?.morph).toEqual({
      enabled: true,
      apiKey: "morph-key",
      models: [],
      model: "morph-v3-large",
      baseUrl: "https://api.morphllm.com/v1",
    });
    // No warnings should be logged since morph is now a valid provider
    const warnCalls = mockLogger.warn.mock.calls;
    expect(warnCalls.length).toBe(0);
  });
});
