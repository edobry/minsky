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
 *     (environmentMappings routes both env vars to their `reviewer.*` paths);
 *   - an end-to-end check that the real environment source populates the
 *     `reviewer.*` slice consumed by the resolver.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { resolveReviewerEndpoint } from "./reviewer-retrigger";
import {
  environmentMappings,
  loadEnvironmentConfiguration,
} from "@minsky/domain/configuration/sources/environment";

const DEFAULT_REVIEWER_URL = "https://minsky-reviewer-webhook.up.railway.app";

const SECRET_ENV = "MINSKY_REVIEWER_WEBHOOK_SECRET";
const URL_ENV = "MINSKY_REVIEWER_URL";
const SECRET_PATH = "reviewer.webhookSecret";
const URL_PATH = "reviewer.url";

const CFG_SECRET = "cfg-secret";
const ENV_SECRET = "env-secret";
const CFG_URL = "https://reviewer.example.test";
const ENV_URL = "https://env-reviewer.example.test";

describe("resolveReviewerEndpoint (mt#2269)", () => {
  it("resolves the secret from config and falls back to the default URL", () => {
    const { url, webhookSecret } = resolveReviewerEndpoint({ webhookSecret: CFG_SECRET });
    expect(webhookSecret).toBe(CFG_SECRET);
    expect(url).toBe(DEFAULT_REVIEWER_URL);
  });

  it("resolves the URL from config when present", () => {
    const { url, webhookSecret } = resolveReviewerEndpoint({
      webhookSecret: CFG_SECRET,
      url: CFG_URL,
    });
    expect(url).toBe(CFG_URL);
    expect(webhookSecret).toBe(CFG_SECRET);
  });

  it("throws when no secret is resolvable (neither config nor env override)", () => {
    expect(() => resolveReviewerEndpoint(undefined)).toThrow();
    expect(() => resolveReviewerEndpoint({})).toThrow();
    expect(() => resolveReviewerEndpoint({ url: CFG_URL })).toThrow();
  });

  it("error message names only resolution paths that actually exist", () => {
    let message = "";
    try {
      resolveReviewerEndpoint({});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Names the real config key and the real env override...
    expect(message).toContain(SECRET_PATH);
    expect(message).toContain(SECRET_ENV);
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
    expect(environmentMappings).toHaveProperty(SECRET_ENV, SECRET_PATH);
    expect(environmentMappings).toHaveProperty(URL_ENV, URL_PATH);
  });
});

describe("reviewer env-override end-to-end (mt#2269)", () => {
  // Subset of the env-loaded shape this test asserts on. The runtime shape is
  // `z.input<...>` of nested-optional schemas, which TypeScript can't navigate
  // deeply enough — mirror the pattern in environment.test.ts.
  type ExpectedShape = { reviewer?: { webhookSecret?: string; url?: string } };

  const REVIEWER_ENV_KEYS = [SECRET_ENV, URL_ENV];
  let original: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of REVIEWER_ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    original = {};
  });

  function withReviewerEnv(values: Record<string, string>): ExpectedShape {
    for (const key of REVIEWER_ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return loadEnvironmentConfiguration() as ExpectedShape;
  }

  it("env vars populate reviewer.* through the real environment source, and resolve through to the endpoint", () => {
    const loaded = withReviewerEnv({ [SECRET_ENV]: ENV_SECRET, [URL_ENV]: ENV_URL });

    // End-to-end: the env source (priority 100, highest) produces the
    // `reviewer.*` config slice that resolveReviewerEndpoint consumes.
    expect(loaded.reviewer?.webhookSecret).toBe(ENV_SECRET);
    expect(loaded.reviewer?.url).toBe(ENV_URL);

    const resolved = resolveReviewerEndpoint(loaded.reviewer);
    expect(resolved.webhookSecret).toBe(ENV_SECRET);
    expect(resolved.url).toBe(ENV_URL);
  });
});
