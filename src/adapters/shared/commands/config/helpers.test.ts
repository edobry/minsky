/**
 * Unit tests for config command helpers (mt#1181).
 *
 * Covers maskCredentialsInEffectiveValues / isSensitivePath with a focus on
 * case-insensitive path matching — the key behaviour fixed in mt#1181 Finding 2.
 */
import { describe, test, expect } from "bun:test";
import { maskCredentialsInEffectiveValues } from "./helpers";

// Shared path constants — reused across tests to satisfy no-magic-string-duplication
const PATH_AI_OPENAI_APIKEY = "ai.providers.OpenAI.apiKEY";

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
});
