/**
 * Unit tests for reviewer.retrigger config resolution (mt#2269 URL, mt#2346 auth).
 *
 * mt#2269 routed the target URL through the Minsky config system
 * (`reviewer.url` ← `MINSKY_REVIEWER_URL`). mt#2346 changed the auth credential
 * from the reviewer webhook HMAC secret to the Minsky MCP auth token
 * (`mcp.auth.token` ← `MINSKY_MCP_AUTH_TOKEN`) — the operator->service credential
 * the operator already holds and the reviewer service already has — so on-demand
 * triggering never needs the GitHub-signing secret. The webhook HMAC secret is no
 * longer read by the retrigger client.
 *
 * These tests assert:
 *   - resolution precedence via the pure `resolveReviewerEndpoint` helper (auth
 *     token required; default URL fallback; missing token → error);
 *   - the error message names ONLY resolution paths that exist (mt#2346);
 *   - the env-override registration that provides the precedence
 *     (environmentMappings routes the auth + URL env vars to their config paths);
 *   - an end-to-end check that the real environment source populates the config
 *     slices consumed by the resolver.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { resolveReviewerEndpoint } from "./reviewer-retrigger";
import {
  environmentMappings,
  loadEnvironmentConfiguration,
} from "@minsky/domain/configuration/sources/environment";

const DEFAULT_REVIEWER_URL = "https://minsky-reviewer-webhook.up.railway.app";

const TOKEN_ENV = "MINSKY_MCP_AUTH_TOKEN";
const URL_ENV = "MINSKY_REVIEWER_URL";
const TOKEN_PATH = "mcp.auth.token";
const URL_PATH = "reviewer.url";

const CFG_TOKEN = "cfg-token";
const ENV_TOKEN = "env-token";
const CFG_URL = "https://reviewer.example.test";
const ENV_URL = "https://env-reviewer.example.test";

describe("resolveReviewerEndpoint (mt#2269 URL, mt#2346 auth)", () => {
  it("resolves the auth token from the MCP config and falls back to the default URL", () => {
    const { url, authToken } = resolveReviewerEndpoint(undefined, CFG_TOKEN);
    expect(authToken).toBe(CFG_TOKEN);
    expect(url).toBe(DEFAULT_REVIEWER_URL);
  });

  it("resolves the URL from reviewer config when present", () => {
    const { url, authToken } = resolveReviewerEndpoint({ url: CFG_URL }, CFG_TOKEN);
    expect(url).toBe(CFG_URL);
    expect(authToken).toBe(CFG_TOKEN);
  });

  it("throws when no auth token is resolvable (neither config nor env override)", () => {
    expect(() => resolveReviewerEndpoint(undefined, undefined)).toThrow();
    expect(() => resolveReviewerEndpoint({}, undefined)).toThrow();
    expect(() => resolveReviewerEndpoint({ url: CFG_URL }, undefined)).toThrow();
  });

  it("error message names the MCP auth resolution paths, not the webhook secret", () => {
    let message = "";
    try {
      resolveReviewerEndpoint({}, undefined);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Names the real config key and the real env override for the MCP auth token...
    expect(message).toContain(TOKEN_PATH);
    expect(message).toContain(TOKEN_ENV);
    // ...and does NOT instruct the operator to obtain the webhook secret (mt#2346:
    // the retrigger client no longer uses it).
    expect(message).not.toContain("MINSKY_REVIEWER_WEBHOOK_SECRET");
    expect(message).not.toContain("reviewer.webhookSecret");
  });
});

describe("reviewer retrigger env-override registration (mt#2269 URL, mt#2346 auth)", () => {
  it("maps the MCP auth token + reviewer URL env vars to their config paths", () => {
    // The environment source (priority 100) out-prioritizes user/project config
    // (50/25), so these mappings are what make the env vars OVERRIDE the config
    // file — the precedence relied on by resolveReviewerEndpoint's reads.
    expect(environmentMappings).toHaveProperty(TOKEN_ENV, TOKEN_PATH);
    expect(environmentMappings).toHaveProperty(URL_ENV, URL_PATH);
  });
});

describe("reviewer retrigger env-override end-to-end (mt#2346)", () => {
  // Subset of the env-loaded shape this test asserts on. The runtime shape is
  // `z.input<...>` of nested-optional schemas, which TypeScript can't navigate
  // deeply enough — mirror the pattern in environment.test.ts.
  type ExpectedShape = {
    reviewer?: { url?: string };
    mcp?: { auth?: { token?: string } };
  };

  const RETRIGGER_ENV_KEYS = [TOKEN_ENV, URL_ENV];
  let original: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of RETRIGGER_ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    original = {};
  });

  function withRetriggerEnv(values: Record<string, string>): ExpectedShape {
    for (const key of RETRIGGER_ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return loadEnvironmentConfiguration() as ExpectedShape;
  }

  it("env vars populate config through the real environment source, and resolve through to the endpoint", () => {
    const loaded = withRetriggerEnv({ [TOKEN_ENV]: ENV_TOKEN, [URL_ENV]: ENV_URL });

    // End-to-end: the env source (priority 100, highest) produces the config
    // slices that resolveReviewerEndpoint consumes.
    expect(loaded.mcp?.auth?.token).toBe(ENV_TOKEN);
    expect(loaded.reviewer?.url).toBe(ENV_URL);

    const resolved = resolveReviewerEndpoint(loaded.reviewer, loaded.mcp?.auth?.token);
    expect(resolved.authToken).toBe(ENV_TOKEN);
    expect(resolved.url).toBe(ENV_URL);
  });
});
