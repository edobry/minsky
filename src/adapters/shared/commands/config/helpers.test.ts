/**
 * Unit tests for config command helpers (mt#1181).
 *
 * Covers maskCredentials (Finding 1) and maskCredentialsInEffectiveValues /
 * isSensitivePath (Finding 2) with a focus on SENSITIVE_KEY_REGEX alignment
 * and case-insensitive path matching.
 */
import { describe, test, expect } from "bun:test";
import { maskCredentials, maskCredentialsInEffectiveValues } from "./helpers";

// Shared path constants — reused across tests to satisfy no-magic-string-duplication
const PATH_AI_OPENAI_APIKEY = "ai.providers.OpenAI.apiKEY";

// ─── maskCredentials (Finding 1) ─────────────────────────────────────────────

describe("maskCredentials — uses SENSITIVE_KEY_REGEX recursively", () => {
  test("showSecrets=true returns a deep clone, not the original reference", () => {
    const cfg = { github: { token: "ghp_abc" } };
    const result = maskCredentials(cfg, true);
    // Values must be equal
    expect(result).toEqual(cfg);
    // But must NOT be the same reference (mutation hazard — mt#1181 Finding 1)
    expect(result).not.toBe(cfg);
  });

  test("showSecrets=true clone: mutating the result does not corrupt the input", () => {
    const cfg: Record<string, unknown> = { github: { token: "ghp_original" } };
    const result = maskCredentials(cfg, true);
    (result.github as Record<string, unknown>).token = "MUTATED";
    // Original must be unchanged
    expect((cfg.github as Record<string, unknown>).token).toBe("ghp_original");
  });

  test("masks string value as '***** (configured)' sentinel", () => {
    const cfg = { github: { token: "ghp_abc123" } };
    const result = maskCredentials(cfg, false);
    expect((result.github as Record<string, unknown>).token).toMatch(/\*{20} \(configured\)/);
  });

  test("masks non-string value as '[MASKED]'", () => {
    const cfg = { db: { apiKey: 12345 } };
    const result = maskCredentials(cfg, false);
    expect((result.db as Record<string, unknown>).apiKey).toBe("[MASKED]");
  });

  test("masks deeply nested apiKey via SENSITIVE_KEY_REGEX (not hard-coded path)", () => {
    const cfg = { ai: { providers: { openai: { apiKey: "sk-secret" } } } };
    const result = maskCredentials(cfg, false);
    const openai = ((result.ai as Record<string, unknown>).providers as Record<string, unknown>)
      .openai as Record<string, unknown>;
    expect(openai.apiKey).toMatch(/\*{20} \(configured\)/);
  });

  test("masks connectionString (sessiondb pattern)", () => {
    const cfg = { sessiondb: { connectionString: "postgres://user:pass@host/db" } };
    const result = maskCredentials(cfg, false);
    expect((result.sessiondb as Record<string, unknown>).connectionString).toMatch(
      /\*{20} \(configured\)/
    );
  });

  test("does not mask non-sensitive keys", () => {
    const cfg = { ai: { model: "gpt-4o", debug: true } };
    const result = maskCredentials(cfg, false);
    expect((result.ai as Record<string, unknown>).model).toBe("gpt-4o");
    expect((result.ai as Record<string, unknown>).debug).toBe(true);
  });

  test("null/undefined sensitive values are preserved (not masked)", () => {
    const cfg = { github: { token: null } };
    const result = maskCredentials(cfg, false);
    expect((result.github as Record<string, unknown>).token).toBeNull();
  });

  test("does not mutate the original config", () => {
    const cfg = { github: { token: "ghp_original" } };
    maskCredentials(cfg, false);
    expect(cfg.github.token).toBe("ghp_original");
  });

  test("masks arrays of objects (each element independently)", () => {
    const cfg = { providers: [{ apiKey: "k1" }, { apiKey: "k2" }] };
    const result = maskCredentials(cfg, false) as { providers: Array<Record<string, unknown>> };
    expect(result.providers[0]?.apiKey).toMatch(/\*{20} \(configured\)/);
    expect(result.providers[1]?.apiKey).toMatch(/\*{20} \(configured\)/);
  });
});

// Helper to build a minimal effectiveValues entry
function entry(value: string) {
  return { value, source: "config", path: "" };
}

describe("maskCredentialsInEffectiveValues — isSensitivePath (case-insensitive)", () => {
  test("lowercase path segments are masked", () => {
    const ev = { "github.token": entry("ghp_abc123") };
    const result = maskCredentialsInEffectiveValues(ev, false);
    expect(result["github.token"]?.value).toMatch(/\*{20}/);
  });

  test("github.Token (mixed-case) is masked", () => {
    const ev = { "github.Token": entry("ghp_abc123") };
    const result = maskCredentialsInEffectiveValues(ev, false);
    expect(result["github.Token"]?.value).toMatch(/\*{20}/);
  });

  test("ai.providers.OpenAI.apiKEY (mixed-case) is masked", () => {
    const ev = { [PATH_AI_OPENAI_APIKEY]: entry("sk-secret") };
    const result = maskCredentialsInEffectiveValues(ev, false);
    expect(result[PATH_AI_OPENAI_APIKEY]?.value).toMatch(/\*{20}/);
  });

  test("SESSIONDB.ConnectionString (all-caps) is masked", () => {
    const ev = { "SESSIONDB.ConnectionString": entry("postgres://...") };
    const result = maskCredentialsInEffectiveValues(ev, false);
    expect(result["SESSIONDB.ConnectionString"]?.value).toMatch(/\*{20}/);
  });

  test("non-sensitive paths are not masked", () => {
    const ev = { "ai.providers.openai.model": entry("gpt-4o") };
    const result = maskCredentialsInEffectiveValues(ev, false);
    expect(result["ai.providers.openai.model"]?.value).toBe("gpt-4o");
  });

  test("showSecrets=true bypasses masking entirely", () => {
    const ev = {
      "github.Token": entry("ghp_abc123"),
      [PATH_AI_OPENAI_APIKEY]: entry("sk-secret"),
    };
    const result = maskCredentialsInEffectiveValues(ev, true);
    expect(result["github.Token"]?.value).toBe("ghp_abc123");
    expect(result[PATH_AI_OPENAI_APIKEY]?.value).toBe("sk-secret");
  });

  test("null / undefined values are not masked even for sensitive paths", () => {
    const ev = { "github.token": { value: null, source: "config", path: "" } };
    const result = maskCredentialsInEffectiveValues(ev, false);
    // value is null — isSensitivePath matches but maskValue is skipped per the guard
    expect(result["github.token"]?.value).toBeNull();
  });

  // mt#1181 Finding 2: hyphenated HTTP-header style path segments must match
  test("x-api-key path segment is masked (hyphen normalization)", () => {
    const ev = { "headers.x-api-key": entry("my-key-value") };
    const result = maskCredentialsInEffectiveValues(ev, false);
    expect(result["headers.x-api-key"]?.value).toMatch(/\*{20}/);
  });

  test("x-auth-token path segment is masked (hyphen normalization)", () => {
    const ev = { "headers.x-auth-token": entry("tok_abc") };
    const result = maskCredentialsInEffectiveValues(ev, false);
    expect(result["headers.x-auth-token"]?.value).toMatch(/\*{20}/);
  });

  test("proxy-authorization path segment is masked (hyphen normalization)", () => {
    const ev = { "proxy-authorization": entry("Basic xyz") };
    const result = maskCredentialsInEffectiveValues(ev, false);
    expect(result["proxy-authorization"]?.value).toMatch(/\*{20}/);
  });
});
