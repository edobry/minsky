import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { aiProvidersConfigSchema, aiConfigSchema } from "./ai";

describe("AI Configuration Schema - Unknown Field Handling", () => {
  let consoleWarnSpy: (...args: any[]) => void;
  let originalConsoleWarn: typeof console.warn;
  let warnCalls: string[] = [];

  beforeEach(() => {
    originalConsoleWarn = console.warn;
    warnCalls = [];
    consoleWarnSpy = (...args: any[]) => {
      warnCalls.push(args.join(" "));
    };
    console.warn = consoleWarnSpy;
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
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
      },
      unknownProvider: {
        enabled: true,
        apiKey: "unknown-key",
      },
    };

    const result = aiProvidersConfigSchema.safeParse(configWithUnknownProvider);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      openai: {
        enabled: true,
        apiKey: "test-key",
        models: [],
        temperature: undefined,
        maxTokens: undefined,
        baseUrl: undefined,
        headers: undefined,
        model: undefined,
        apiKeyFile: undefined,
      },
    });

    // Should have logged a warning about unknown fields
    expect(warnCalls.length).toBeGreaterThan(0);
    const warningMessage = warnCalls[0];
    expect(warningMessage).toContain("Configuration Warning: Unknown fields in ai.providers:");
    expect(warningMessage).toMatch(/morph.*unknownProvider|unknownProvider.*morph/);
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
        },
      },
    };

    const result = aiConfigSchema.safeParse(aiConfigWithUnknown);

    expect(result.success).toBe(true);
    expect(result.data?.providers).not.toHaveProperty("morph");
    expect(warnCalls.length).toBeGreaterThan(0);
  });
});
