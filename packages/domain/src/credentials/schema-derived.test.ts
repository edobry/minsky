/**
 * Schema-derived credential listing (mt#3569).
 *
 * The bug these cover: `config credentials list` enumerated a hand-registered
 * provider set, omitted `openai` and `morph`, and presented as an exhaustive
 * presence check. Two agents read a provider's absence as proof no such credential
 * was configured; one escalated a request to move a production credential on that
 * false premise.
 *
 * Every function under test takes its input as a PARAMETER, so these need no
 * filesystem, no temp HOME, and no module patching — the observable is the return
 * value. That is why `mergeCredentialListings` is a separate export from
 * `listCredentials`: the merge carries the rule worth testing, and reading
 * `config.yaml` does not.
 */

import { describe, expect, it } from "bun:test";

import {
  AI_PROVIDER_IDS,
  aiProviderCredentialPaths,
  type AIProviderId,
} from "../configuration/schemas/ai";
import {
  listSchemaDerivedCredentials,
  displayNameFor,
  mergeCredentialListings,
} from "./schema-derived";
import type { CredentialListing } from "./lifecycle";

const entry = (
  provider: string,
  source: "provider" | "schema",
  extra: Partial<CredentialListing> = {}
): CredentialListing => ({
  provider,
  displayName: provider,
  configPath: `${provider}.token`,
  configured: true,
  source,
  ...extra,
});

describe("listSchemaDerivedCredentials", () => {
  it("reports openai as configured when ai.providers.openai.apiKey is set", () => {
    // The exact shape that was invisible to the listing.
    const entries = listSchemaDerivedCredentials({
      ai: { providers: { openai: { apiKey: "sk-not-a-real-key" } } },
    });

    const openai = entries.find((e) => e.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai?.configured).toBe(true);
    expect(openai?.source).toBe("schema");
    expect(openai?.configPath).toBe("ai.providers.openai.apiKey");
  });

  it("reports morph too — the other provider the old listing omitted", () => {
    const entries = listSchemaDerivedCredentials({
      ai: { providers: { morph: { apiKey: "morph-key" } } },
    });
    expect(entries.find((e) => e.provider === "morph")?.configured).toBe(true);
  });

  it("counts apiKeyFile as configured, matching aiValidation.hasApiKey", () => {
    const entries = listSchemaDerivedCredentials({
      ai: { providers: { openai: { apiKeyFile: "/run/secrets/openai" } } },
    });
    expect(entries.find((e) => e.provider === "openai")?.configured).toBe(true);
  });

  it("reports an absent provider as not-configured rather than omitting it", () => {
    // The whole point: a provider with no key must still APPEAR, as configured:false.
    // Omission is what let absence be misread as non-existence.
    const entries = listSchemaDerivedCredentials({});
    const openai = entries.find((e) => e.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai?.configured).toBe(false);
  });

  it("treats an empty-string key as not configured", () => {
    const entries = listSchemaDerivedCredentials({
      ai: { providers: { openai: { apiKey: "" } } },
    });
    expect(entries.find((e) => e.provider === "openai")?.configured).toBe(false);
  });

  it("does not throw on a malformed ai section", () => {
    // Config files are user-editable; a scalar where an object belongs must not crash
    // the listing.
    expect(() => listSchemaDerivedCredentials({ ai: "nonsense" })).not.toThrow();
    expect(() => listSchemaDerivedCredentials({ ai: { providers: null } })).not.toThrow();
  });

  it("never emits a key value in the listing", () => {
    const secret = "sk-super-secret-value";
    const entries = listSchemaDerivedCredentials({
      ai: { providers: { openai: { apiKey: secret } } },
    });
    expect(JSON.stringify(entries)).not.toContain(secret);
  });
});

describe("displayNameFor", () => {
  it("uses the override for names capitalization gets wrong", () => {
    expect(displayNameFor("openai")).toBe("OpenAI");
  });

  it("falls back to capitalization so a new schema provider still lists", () => {
    // A provider added to the schema with no entry in the override map must not
    // break — the fallback is what keeps the derivation edit-free.
    expect(displayNameFor("perplexity")).toBe("Perplexity");
  });
});

describe("mergeCredentialListings", () => {
  it("keeps the provider entry when an id is in BOTH sets", () => {
    // anthropic is a registered provider AND a schema key. It must appear once, as
    // the manageable entry — a collision must never downgrade it to presence-only.
    const merged = mergeCredentialListings(
      [entry("anthropic", "provider", { lastValidatedAt: "2026-08-01T00:00:00Z" })],
      [entry("anthropic", "schema"), entry("openai", "schema")]
    );

    const anthropic = merged.filter((l) => l.provider === "anthropic");
    expect(anthropic).toHaveLength(1);
    expect(anthropic[0]?.source).toBe("provider");
    expect(anthropic[0]?.lastValidatedAt).toBe("2026-08-01T00:00:00Z");
  });

  it("appends schema entries that no provider claims", () => {
    const merged = mergeCredentialListings(
      [entry("github", "provider")],
      [entry("openai", "schema")]
    );
    expect(merged.map((l) => l.provider)).toEqual(["github", "openai"]);
  });

  it("marks every entry with a source so no consumer infers manageability", () => {
    const merged = mergeCredentialListings(
      [entry("github", "provider")],
      [entry("openai", "schema")]
    );
    expect(merged.every((l) => l.source === "provider" || l.source === "schema")).toBe(true);
  });

  it("returns provider entries unchanged when there is nothing to merge", () => {
    const providers = [entry("github", "provider")];
    expect(mergeCredentialListings(providers, [])).toEqual(providers);
  });
});

describe("drift guard: the derivation covers every schema-defined AI provider", () => {
  it("emits an entry for every id in AI_PROVIDER_IDS", () => {
    // SC3: fails if a provider is added to the config schema and the derivation does
    // not pick it up — drift becomes a red test, not a wrong answer to an agent.
    const ids = new Set(listSchemaDerivedCredentials({}).map((e) => e.provider));
    const missing = AI_PROVIDER_IDS.filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
  });

  it("includes the two providers whose omission caused the incidents", () => {
    const ids = listSchemaDerivedCredentials({}).map((e) => e.provider);
    expect(ids).toContain("openai");
    expect(ids).toContain("morph");
  });

  it("exposes only real schema keys at runtime", () => {
    // PR #2654 R1: the first version typed AI_PROVIDER_IDS as `readonly string[]`
    // because `Object.keys` returns `string[]`, erasing the union the export exists
    // to preserve.
    //
    // The TYPE-level half of that guard is NOT here. A `@ts-expect-error` in this
    // file would be inert: `packages/**` test files are in no tsconfig `include`, so
    // this file is never compiled — verified by widening `AIProviderId` to `string`
    // and watching a guard written here stay green. The compile-time assertion lives
    // in `schemas/ai.ts` as `AI_PROVIDER_ID_UNION_IS_CLOSED`, which IS compiled.
    //
    // What remains testable at runtime is the VALUES, which is what this asserts.
    const valid: AIProviderId = "openai";
    expect(AI_PROVIDER_IDS).toContain(valid);
    expect(AI_PROVIDER_IDS).not.toContain("definitely-not-a-provider");
    expect(AI_PROVIDER_IDS.length).toBeGreaterThan(0);
  });

  it("covers each schema provider's credential paths", () => {
    // Guards the path builder against the shape drifting away from the schema.
    for (const id of AI_PROVIDER_IDS) {
      expect(aiProviderCredentialPaths(id)).toEqual([
        `ai.providers.${id}.apiKey`,
        `ai.providers.${id}.apiKeyFile`,
      ]);
    }
  });
});
