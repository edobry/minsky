import { describe, it, expect } from "bun:test";
import {
  observabilityConfigSchema,
  observabilityValidation,
  observabilityEnvMapping,
  braintrustConfigSchema,
} from "./observability";

describe("observabilityConfigSchema", () => {
  it("accepts an empty object and applies defaults", () => {
    const parsed = observabilityConfigSchema.parse({});
    expect(parsed.providers).toBeDefined();
    expect(parsed.providers.braintrust).toBeUndefined();
    expect(parsed.defaultProvider).toBeUndefined();
  });

  it("accepts undefined and applies defaults via top-level schema integration", () => {
    // The top-level schema marks `observability` as required but
    // observabilityConfigSchema itself has a default {}, so parsing undefined
    // through the field would still work — confirm the schema's default fires.
    const parsed = observabilityConfigSchema.parse(undefined);
    expect(parsed.providers).toEqual({});
  });

  it("accepts a braintrust provider config with apiKey", () => {
    const parsed = observabilityConfigSchema.parse({
      providers: { braintrust: { apiKey: "bt-test-key" } },
    });
    expect(parsed.providers.braintrust?.apiKey).toBe("bt-test-key");
    expect(parsed.providers.braintrust?.enabled).toBe(true);
    // projectName has no hard-coded default (mt#2369: removed "minsky" default
    // so external projects don't silently log to a Minsky-named project)
    expect(parsed.providers.braintrust?.projectName).toBeUndefined();
    expect(parsed.providers.braintrust?.apiUrl).toBe("https://api.braintrust.dev");
  });

  it("accepts an explicit projectName", () => {
    const parsed = observabilityConfigSchema.parse({
      providers: { braintrust: { apiKey: "bt-test-key", projectName: "my-project" } },
    });
    expect(parsed.providers.braintrust?.projectName).toBe("my-project");
  });

  it("accepts apiKeyFile as alternative to apiKey", () => {
    const parsed = observabilityConfigSchema.parse({
      providers: { braintrust: { apiKeyFile: "/path/to/keyfile" } },
    });
    expect(parsed.providers.braintrust?.apiKey).toBeUndefined();
    expect(parsed.providers.braintrust?.apiKeyFile).toBe("/path/to/keyfile");
  });

  it("allows overriding apiUrl for self-host", () => {
    const parsed = observabilityConfigSchema.parse({
      providers: {
        braintrust: { apiKey: "x", apiUrl: "https://braintrust.internal.example.com" },
      },
    });
    expect(parsed.providers.braintrust?.apiUrl).toBe("https://braintrust.internal.example.com");
  });

  it("rejects invalid apiUrl", () => {
    expect(() => braintrustConfigSchema.parse({ apiKey: "x", apiUrl: "not-a-url" })).toThrow();
  });

  it("accepts defaultProvider=braintrust", () => {
    const parsed = observabilityConfigSchema.parse({
      defaultProvider: "braintrust",
      providers: { braintrust: { apiKey: "x" } },
    });
    expect(parsed.defaultProvider).toBe("braintrust");
  });

  it("rejects unknown defaultProvider values", () => {
    expect(() => observabilityConfigSchema.parse({ defaultProvider: "langfuse" })).toThrow();
  });
});

describe("observabilityValidation", () => {
  it("hasApiKey returns true with apiKey set", () => {
    expect(observabilityValidation.hasApiKey({ apiKey: "x", enabled: true })).toBe(true);
  });

  it("hasApiKey returns true with apiKeyFile set", () => {
    expect(observabilityValidation.hasApiKey({ apiKeyFile: "/path", enabled: true })).toBe(true);
  });

  it("hasApiKey returns false with no credential", () => {
    expect(observabilityValidation.hasApiKey({ enabled: true })).toBe(false);
  });

  it("isProviderReady requires enabled + credential", () => {
    expect(observabilityValidation.isProviderReady({ apiKey: "x", enabled: true })).toBe(true);
    expect(observabilityValidation.isProviderReady({ apiKey: "x", enabled: false })).toBe(false);
    expect(observabilityValidation.isProviderReady({ enabled: true })).toBe(false);
  });

  it("getEnabledProviders returns braintrust when enabled", () => {
    const config = observabilityConfigSchema.parse({
      providers: { braintrust: { apiKey: "x" } },
    });
    expect(observabilityValidation.getEnabledProviders(config)).toEqual(["braintrust"]);
  });

  it("getReadyProviders requires both enabled and credential", () => {
    const config = observabilityConfigSchema.parse({
      providers: { braintrust: { apiKey: "x", enabled: true } },
    });
    expect(observabilityValidation.getReadyProviders(config)).toEqual(["braintrust"]);

    const noKey = observabilityConfigSchema.parse({
      providers: { braintrust: { enabled: true } },
    });
    expect(observabilityValidation.getReadyProviders(noKey)).toEqual([]);
  });

  it("getDefaultProvider returns explicit defaultProvider when set", () => {
    const config = observabilityConfigSchema.parse({
      defaultProvider: "braintrust",
      providers: { braintrust: { apiKey: "x" } },
    });
    expect(observabilityValidation.getDefaultProvider(config)).toBe("braintrust");
  });

  it("getDefaultProvider falls back to first ready provider", () => {
    const config = observabilityConfigSchema.parse({
      providers: { braintrust: { apiKey: "x" } },
    });
    expect(observabilityValidation.getDefaultProvider(config)).toBe("braintrust");
  });

  it("getDefaultProvider returns null when no provider is ready", () => {
    const config = observabilityConfigSchema.parse({ providers: {} });
    expect(observabilityValidation.getDefaultProvider(config)).toBeNull();
  });
});

describe("observabilityEnvMapping", () => {
  it("maps BRAINTRUST_API_KEY to the correct path", () => {
    expect(observabilityEnvMapping.BRAINTRUST_API_KEY).toBe(
      "observability.providers.braintrust.apiKey"
    );
  });

  it("maps BRAINTRUST_PROJECT_NAME", () => {
    expect(observabilityEnvMapping.BRAINTRUST_PROJECT_NAME).toBe(
      "observability.providers.braintrust.projectName"
    );
  });

  it("maps BRAINTRUST_API_URL", () => {
    expect(observabilityEnvMapping.BRAINTRUST_API_URL).toBe(
      "observability.providers.braintrust.apiUrl"
    );
  });
});
