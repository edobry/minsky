/**
 * Unit tests for config command helpers (mt#1181).
 *
 * Covers maskCredentials (Finding 1) and maskCredentialsInEffectiveValues /
 * isSensitivePath (Finding 2) with a focus on SENSITIVE_KEY_REGEX alignment
 * and case-insensitive path matching.
 */
import { describe, test, expect } from "bun:test";
import { maskCredentials, maskCredentialsInEffectiveValues, maskValueForPath } from "./helpers";

// Shared path constants — reused across tests to satisfy no-magic-string-duplication
const PATH_AI_OPENAI_APIKEY = "ai.providers.OpenAI.apiKEY";
const PATH_AI_OPENAI_MODEL = "ai.providers.openai.model";
const PATH_HEADERS_X_API_KEY = "headers.x-api-key";

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

  test("masks connectionString (persistence pattern)", () => {
    const cfg = {
      persistence: { postgres: { connectionString: "postgres://user:pass@host/db" } },
    };
    const result = maskCredentials(cfg, false);
    const persistence = result.persistence as Record<string, unknown>;
    const pg = persistence.postgres as Record<string, unknown>;
    expect(pg.connectionString).toMatch(/\*{20} \(configured\)/);
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
    const ev = { [PATH_AI_OPENAI_MODEL]: entry("gpt-4o") };
    const result = maskCredentialsInEffectiveValues(ev, false);
    expect(result[PATH_AI_OPENAI_MODEL]?.value).toBe("gpt-4o");
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
    const ev = { [PATH_HEADERS_X_API_KEY]: entry("my-key-value") };
    const result = maskCredentialsInEffectiveValues(ev, false);
    expect(result[PATH_HEADERS_X_API_KEY]?.value).toMatch(/\*{20}/);
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

// ─── mt#3634: composite values under a non-sensitive path ────────────────────

describe("maskCredentialsInEffectiveValues — masks credentials NESTED IN VALUES", () => {
  // Every pre-existing test in the block above passes a scalar string, which is
  // why the gap survived: `isSensitivePath` inspects the KEY PATH only, so a
  // composite value under a non-sensitive path was returned verbatim. The
  // originating leak was `knowledgeBases[0].auth.token` — a live Notion token
  // emitted in full while the identical value was masked in the `configuration`
  // tree by the sibling masker.
  //
  // These assert the GENERAL form, not the array shape that happened to leak.
  const SECRET = "ntn_liveTokenValue";

  function compositeEntry(value: unknown) {
    return { value, source: "user", path: "knowledgeBases" };
  }

  test("array of objects: a nested token under a non-sensitive path is masked (the originating leak)", () => {
    const ev = {
      knowledgeBases: compositeEntry([
        { name: "minsky-design", auth: { token: SECRET }, sync: { schedule: "on-demand" } },
      ]),
    };

    const result = maskCredentialsInEffectiveValues(ev, false);

    const kb = result.knowledgeBases?.value as Array<Record<string, unknown>>;
    expect((kb[0]?.auth as Record<string, unknown>).token).toMatch(/\*{20} \(configured\)/);
    // The whole serialized payload must not carry it anywhere.
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("plain object (no array): the same leak shape without an array", () => {
    const ev = { integrations: compositeEntry({ notion: { auth: { token: SECRET } } }) };

    const result = maskCredentialsInEffectiveValues(ev, false);

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("deeply nested inside an array, three levels down", () => {
    const ev = {
      services: compositeEntry([{ envs: [{ config: { apiKey: SECRET } }] }]),
    };

    const result = maskCredentialsInEffectiveValues(ev, false);

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("non-sensitive fields inside the composite are preserved", () => {
    const ev = {
      knowledgeBases: compositeEntry([
        { name: "minsky-design", auth: { token: SECRET }, sync: { schedule: "on-demand" } },
      ]),
    };

    const result = maskCredentialsInEffectiveValues(ev, false);

    const kb = result.knowledgeBases?.value as Array<Record<string, unknown>>;
    expect(kb[0]?.name).toBe("minsky-design");
    expect((kb[0]?.sync as Record<string, unknown>).schedule).toBe("on-demand");
  });

  test("showSecrets=true still returns the composite unmasked", () => {
    const ev = { knowledgeBases: compositeEntry([{ auth: { token: SECRET } }]) };

    const result = maskCredentialsInEffectiveValues(ev, true);

    expect(JSON.stringify(result)).toContain(SECRET);
  });

  test("a non-sensitive scalar under a non-sensitive path is unchanged", () => {
    // Guards the regression risk of routing every value through the masker:
    // ordinary values must still come back as themselves, not "[MASKED]".
    const ev = {
      [PATH_AI_OPENAI_MODEL]: entry("gpt-4o"),
      "logger.maxFiles": { value: 5, source: "defaults", path: "" },
      "embeddings.normalize": { value: false, source: "defaults", path: "" },
    };

    const result = maskCredentialsInEffectiveValues(ev, false);

    expect(result[PATH_AI_OPENAI_MODEL]?.value).toBe("gpt-4o");
    expect(result["logger.maxFiles"]?.value).toBe(5);
    expect(result["embeddings.normalize"]?.value).toBe(false);
  });

  test("the input object is not mutated", () => {
    const original = { auth: { token: SECRET } };
    const ev = { knowledgeBases: compositeEntry([original]) };

    maskCredentialsInEffectiveValues(ev, false);

    expect(original.auth.token).toBe(SECRET);
  });
});

// ─── mt#3634: maskValueForPath — the shared rule behind config.get ───────────

describe("maskValueForPath — both masking rules, used by config.get", () => {
  // config.get returned `provider.get(key)` VERBATIM: no masking, no
  // showSecrets flag. `config get github.token` printed the raw credential.
  // This is the second, independent leak found while auditing the sibling
  // surfaces end-to-end rather than by reading the code.
  const SECRET = "ghs_liveAppTokenValue";

  test("a sensitive path masks a scalar value", () => {
    expect(maskValueForPath("github.token", SECRET)).toMatch(/\*{20} \(configured\)/);
  });

  test("a sensitive path masks a non-string value wholesale", () => {
    expect(maskValueForPath("github.token", { nested: SECRET })).toBe("[MASKED]");
  });

  test("case-insensitive and hyphenated sensitive segments still match", () => {
    expect(maskValueForPath("ai.providers.OpenAI.apiKEY", SECRET)).toMatch(/\*{20}/);
    expect(maskValueForPath(PATH_HEADERS_X_API_KEY, SECRET)).toMatch(/\*{20}/);
  });

  test("a NON-sensitive path still has its composite value traversed", () => {
    const value = [{ auth: { token: SECRET } }];

    const result = maskValueForPath("knowledgeBases", value);

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("a non-sensitive path with a non-sensitive scalar is returned unchanged", () => {
    expect(maskValueForPath(PATH_AI_OPENAI_MODEL, "gpt-4o")).toBe("gpt-4o");
    expect(maskValueForPath("logger.maxFiles", 5)).toBe(5);
  });

  test("null and undefined are preserved, not masked", () => {
    expect(maskValueForPath("github.token", null)).toBeNull();
    expect(maskValueForPath("github.token", undefined)).toBeUndefined();
  });

  test("an already-masked value is not double-masked", () => {
    const already = `${"*".repeat(20)} (configured)`;
    expect(maskValueForPath("github.token", already)).toBe(already);
  });
});

// ─── mt#1262 wiring ──────────────────────────────────────────────────────────

describe("config command registrations expose showSecrets (mt#1262 wiring)", () => {
  // Structural test — guards against a regression where someone removes
  // showSecrets from config.show or config.list and the masking silently
  // becomes unconditional.

  test("config.show and config.list both declare a showSecrets parameter", async () => {
    const { configShowRegistration, configListRegistration } = await import("./list-show-commands");
    expect(configShowRegistration.parameters).toHaveProperty("showSecrets");
    expect(configListRegistration.parameters).toHaveProperty("showSecrets");
  });

  test("showSecrets defaults to false on both commands", async () => {
    const { configShowRegistration, configListRegistration } = await import("./list-show-commands");
    type ParamWithDefault = { defaultValue?: unknown };
    const showParam = (configShowRegistration.parameters as Record<string, ParamWithDefault>)
      .showSecrets;
    const listParam = (configListRegistration.parameters as Record<string, ParamWithDefault>)
      .showSecrets;
    expect(showParam?.defaultValue).toBe(false);
    expect(listParam?.defaultValue).toBe(false);
  });
});
