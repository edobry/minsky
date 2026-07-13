/**
 * Regression guard for mt#2727: every `ai.*` command's `execute()` must
 * RETURN structured data, not `undefined`. These builders are exactly what
 * each command's `execute()` returns (see provider-commands.ts,
 * completion-commands.ts, model-cache-commands.ts) — asserting their shape
 * here is a direct guard against ever regressing back to the
 * print-and-return-undefined pattern that broke every read-only `ai_*` MCP
 * tool (they returned the literal string `"undefined"`).
 *
 * These are pure-function tests with no service-factory mocking, since
 * `custom/no-global-module-mocks` bans `mock.module()` outside
 * `tests/setup.ts` — dependency injection (or, here, pure functions with no
 * dependencies at all) is the required pattern.
 */
import { describe, test, expect } from "bun:test";
import {
  buildValidateResult,
  buildProvidersListResult,
  buildModelsAvailableResult,
  buildModelsListResult,
  buildCompleteResult,
} from "./result-builders";

describe("buildValidateResult", () => {
  test("returns a defined structured object, not undefined", () => {
    const result = buildValidateResult({
      valid: true,
      json: false,
      errors: [],
      warnings: [],
      providers: [],
    });
    expect(result).toBeDefined();
    expect(result).not.toBe("undefined");
  });

  test("valid config: success mirrors valid, carries providers", () => {
    const providers = [
      {
        name: "anthropic",
        configured: true,
        hasApiKey: true,
        connectionTest: { attempted: true, successful: true },
      },
    ];
    const result = buildValidateResult({
      valid: true,
      json: true,
      errors: [],
      warnings: [],
      providers,
    });
    expect(result.success).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.json).toBe(true);
    expect(result.providers).toEqual(providers);
  });

  test("invalid config: success is false, errors/warnings preserved", () => {
    const errors = [{ field: "apiKey", message: "missing", code: "MISSING" }];
    const warnings = [{ field: "model", message: "deprecated", code: "DEPRECATED" }];
    const result = buildValidateResult({
      valid: false,
      json: false,
      errors,
      warnings,
      providers: [],
    });
    expect(result.success).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(errors);
    expect(result.warnings).toEqual(warnings);
  });
});

describe("buildProvidersListResult", () => {
  test("returns a defined structured object carrying the providers array", () => {
    const providers = [
      {
        name: "anthropic",
        configured: true,
        hasApiKey: true,
        lastFetched: undefined,
        modelCount: 12,
        lastSuccess: true,
        isStale: false,
        error: undefined,
      },
    ];
    const result = buildProvidersListResult(providers, true, "json");
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.json).toBe(true);
    expect(result.format).toBe("json");
    expect(result.providers).toEqual(providers);
  });

  test("empty providers array is preserved, not coerced away", () => {
    const result = buildProvidersListResult([], false, "table");
    expect(result.providers).toEqual([]);
  });
});

describe("buildModelsAvailableResult", () => {
  test("non-empty models: no emptyGuidance, models array preserved", () => {
    const models = [
      {
        id: "claude-opus",
        provider: "anthropic",
        name: "Claude Opus",
        capabilities: [],
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    ];
    const result = buildModelsAvailableResult({
      provider: "anthropic",
      models,
      json: false,
      format: "table",
    });
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.models).toEqual(models);
    expect(result.emptyGuidance).toBeUndefined();
  });

  test("empty models with a provider filter: guidance names the provider", () => {
    const result = buildModelsAvailableResult({
      provider: "openai",
      models: [],
      json: false,
      format: "table",
    });
    expect(result.emptyGuidance).toBeDefined();
    expect(result.emptyGuidance?.header[0]).toContain("openai");
    expect(result.emptyGuidance?.reasons.length).toBeGreaterThan(0);
    expect(result.emptyGuidance?.configHint).toBeUndefined();
  });

  test("empty models with no provider filter: guidance includes configHint", () => {
    const result = buildModelsAvailableResult({
      provider: undefined,
      models: [],
      json: false,
      format: "table",
    });
    expect(result.provider).toBeNull();
    expect(result.emptyGuidance?.configHint).toBeDefined();
  });
});

describe("buildModelsListResult", () => {
  test("returns a defined structured object carrying models by provider", () => {
    const models = {
      anthropic: [
        {
          id: "claude-opus",
          provider: "anthropic",
          name: "Claude Opus",
          capabilities: [],
          contextWindow: 200000,
          maxOutputTokens: 8192,
          status: "available" as const,
          fetchedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    };
    const result = buildModelsListResult({
      models,
      json: false,
      format: "table",
      showCache: false,
    });
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.models).toEqual(models);
    expect(result.cacheMetadata).toBeUndefined();
  });

  test("showCache carries cacheMetadata through when provided", () => {
    const cacheMetadata = {
      lastUpdated: new Date("2026-01-01T00:00:00Z"),
      ttl: 3600000,
      nextRefresh: new Date("2026-01-01T01:00:00Z"),
      providers: {},
    } as never;
    const result = buildModelsListResult({
      models: {},
      json: false,
      format: "table",
      showCache: true,
      cacheMetadata,
    });
    expect(result.cacheMetadata).toBe(cacheMetadata);
  });
});

describe("buildCompleteResult", () => {
  test("returns a defined structured object, not undefined — the core mt#2727 regression", () => {
    const result = buildCompleteResult({
      content: "Hello, world!",
      model: "claude-opus",
      provider: "anthropic",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      streamed: false,
    });
    expect(result).toBeDefined();
    expect(result).not.toBe("undefined");
    expect(result.success).toBe(true);
    expect(result.content).toBe("Hello, world!");
    expect(result.model).toBe("claude-opus");
    expect(result.provider).toBe("anthropic");
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
    expect(result.streamed).toBe(false);
  });

  test("null model/provider/usage default cleanly to null (not undefined)", () => {
    const result = buildCompleteResult({ content: "hi", streamed: true });
    expect(result.model).toBeNull();
    expect(result.provider).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.streamed).toBe(true);
  });
});
