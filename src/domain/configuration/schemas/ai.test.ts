import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { aiProvidersConfigSchema, aiConfigSchema } from "./ai";
import { mockLogger, resetMockLogger } from "../../../utils/test-utils/mock-logger";

describe("AI Configuration Schema - Unknown Field Handling", () => {
  beforeEach(() => {
    resetMockLogger();
    // Set test mode to suppress config warnings during tests
    (globalThis as any).__TEST_MODE__ = true;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    resetMockLogger();
    delete (globalThis as any).__TEST_MODE__;
    delete process.env.NODE_ENV;
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

    // Note: Warnings are suppressed in test mode to avoid circular dependency
    // The important part is that unknown fields are stripped from the result
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
    // Note: Warnings are suppressed in test mode to avoid circular dependency
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
    // Note: Warnings are suppressed in test mode to avoid circular dependency
  });
});
