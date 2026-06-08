/**
 * Unit tests for reviewer.retrigger config resolution (mt#2269).
 *
 * Before mt#2269 the command read its auth secret and target URL from
 * `process.env` only (env-only secret, hardcoded-with-env URL), and the
 * "missing secret" error claimed a Minsky-config fallback that did not exist.
 * mt#2269 routes both values through the Minsky config system, with the
 * `MINSKY_REVIEWER_WEBHOOK_SECRET` / `MINSKY_REVIEWER_URL` env vars overriding
 * config-file values via the environment source's higher merge priority.
 *
 * These tests assert:
 *   - the resolution precedence (config value used; default URL fallback;
 *     missing secret → error) via the pure `resolveReviewerEndpoint` helper;
 *   - the corrected error message names ONLY resolution paths that exist;
 *   - the env-override registration that provides the precedence
 *     (environmentMappings routes both env vars to their `reviewer.*` paths,
 *     and the environment source out-prioritizes the config file).
 */

import { describe, it, expect } from "bun:test";
import { resolveReviewerEndpoint } from "./reviewer-retrigger";
import { environmentMappings } from "@minsky/domain/configuration/sources/environment";

const DEFAULT_REVIEWER_URL = "https://minsky-reviewer-webhook.up.railway.app";

describe("resolveReviewerEndpoint (mt#2269)", () => {
  it("resolves the secret from config and falls back to the default URL", () => {
    const { url, webhookSecret } = resolveReviewerEndpoint({ webhookSecret: "cfg-secret" });
    expect(webhookSecret).toBe("cfg-secret");
    expect(url).toBe(DEFAULT_REVIEWER_URL);
  });

  it("resolves the URL from config when present", () => {
    const { url, webhookSecret } = resolveReviewerEndpoint({
      webhookSecret: "cfg-secret",
      url: "https://reviewer.example.test",
    });
    expect(url).toBe("https://reviewer.example.test");
    expect(webhookSecret).toBe("cfg-secret");
  });

  it("throws when no secret is resolvable (neither config nor env override)", () => {
    expect(() => resolveReviewerEndpoint(undefined)).toThrow();
    expect(() => resolveReviewerEndpoint({})).toThrow();
    expect(() => resolveReviewerEndpoint({ url: "https://reviewer.example.test" })).toThrow();
  });

  it("error message names only resolution paths that actually exist", () => {
    let message = "";
    try {
      resolveReviewerEndpoint({});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Names the real config key and the real env override...
    expect(message).toContain("reviewer.webhookSecret");
    expect(message).toContain("MINSKY_REVIEWER_WEBHOOK_SECRET");
    // ...and does NOT repeat the old aspirational "or Minsky config" phrasing
    // that claimed a fallback the code never implemented.
    expect(message).not.toContain("Set it in your environment or Minsky config");
  });
});

describe("reviewer env-override registration (mt#2269)", () => {
  it("maps the webhook secret + URL env vars to their reviewer.* config paths", () => {
    // The environment source (priority 100) out-prioritizes user/project config
    // (50/25), so these mappings are what make the env vars OVERRIDE the config
    // file — the precedence relied on by resolveReviewerEndpoint's single read.
    expect(environmentMappings).toHaveProperty(
      "MINSKY_REVIEWER_WEBHOOK_SECRET",
      "reviewer.webhookSecret"
    );
    expect(environmentMappings).toHaveProperty("MINSKY_REVIEWER_URL", "reviewer.url");
  });
});
