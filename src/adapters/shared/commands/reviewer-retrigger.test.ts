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
// mt#2359: import the production constant rather than re-declaring a literal.
// The prior local copy held the wrong (no `-production`) URL and "passed" while
// validating the wrong value — the SoT-duplication-masks-the-bug failure. The
// fallback-URL assertion below is now anchored to the real default the command uses.
import {
  resolveReviewerEndpoint,
  postReviewCommentFallback,
  runReviewerRetrigger,
  DEFAULT_REVIEWER_URL,
} from "./reviewer-retrigger";
import { CustomConfigFactory, initializeConfiguration } from "@minsky/domain/configuration/index";
import {
  environmentMappings,
  loadEnvironmentConfiguration,
} from "@minsky/domain/configuration/sources/environment";

const TOKEN_ENV = "MINSKY_MCP_AUTH_TOKEN";
const URL_ENV = "MINSKY_REVIEWER_URL";
const TOKEN_PATH = "mcp.auth.token";
const URL_PATH = "reviewer.url";

const CFG_TOKEN = "cfg-token";
const ENV_TOKEN = "env-token";
const CFG_URL = "https://reviewer.example.test";
const ENV_URL = "https://env-reviewer.example.test";

describe("DEFAULT_REVIEWER_URL drift sentinel (mt#2359)", () => {
  // Offline regression guard: the prior value omitted `-production` and 404'd.
  // Railway publishes services at `<service>-<environment>.up.railway.app`; the
  // reviewer service (infra/index.ts) is `minsky-reviewer-webhook` in the
  // `production` environment. The live /health drift guard is
  // scripts/smoke-retrigger-default-url.ts; this is the network-free sentinel.
  it("points at the production Railway host (has the -production suffix)", () => {
    expect(DEFAULT_REVIEWER_URL).toBe("https://minsky-reviewer-webhook-production.up.railway.app");
    expect(DEFAULT_REVIEWER_URL).toContain("-production.up.railway.app");
  });
});

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

describe("postReviewCommentFallback (mt#2679 GitHub-auth fallback)", () => {
  it("posts a /review comment and reports the review-comment path", async () => {
    const calls: Array<{ owner: string; repo: string; issue_number: number; body: string }> = [];
    const client = {
      async createComment(args: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) {
        calls.push(args);
        return { data: { html_url: "https://github.com/o/r/pull/7#issuecomment-1" } };
      },
    };

    const result = await postReviewCommentFallback(client, { pr: 7, owner: "o", repo: "r" });

    expect(result.ok).toBe(true);
    expect(result.path).toBe("review-comment");
    expect(result.commentUrl).toBe("https://github.com/o/r/pull/7#issuecomment-1");
    // The reviewer's REVIEW_COMMAND_RE matches the FIRST LINE as exactly /review.
    expect(calls).toEqual([{ owner: "o", repo: "r", issue_number: 7, body: "/review" }]);
    // The note names the async semantics and the turnkey remediation.
    expect(result.note).toContain("asynchronously");
    expect(result.note).toContain("config doctor --fix");
  });

  it("surfaces a comment-post failure as a non-ok result on the fallback path", async () => {
    const client = {
      async createComment(): Promise<{ data: { html_url?: string } }> {
        throw new Error("403 Forbidden");
      },
    };

    const result = await postReviewCommentFallback(client, { pr: 9, owner: "o", repo: "r" });

    expect(result.ok).toBe(false);
    expect(result.path).toBe("review-comment");
    expect(result.error).toContain("403 Forbidden");
  });
});

describe("runReviewerRetrigger credential branching (mt#2679)", () => {
  it("prefers the direct endpoint when BOTH credentials are present", async () => {
    const savedToken = process.env[TOKEN_ENV];
    const savedXdg = process.env["XDG_CONFIG_HOME"];
    delete process.env[TOKEN_ENV];
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    process.env["XDG_CONFIG_HOME"] = join(
      tmpdir(),
      `minsky-retrigger-test-isolated-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    const savedFetch = globalThis.fetch;
    const fetched: string[] = [];
    try {
      await initializeConfiguration(new CustomConfigFactory(), {
        overrides: {
          github: { token: "gh-token-present" },
          mcp: { auth: { token: "mcp-token-present" } },
          reviewer: { url: "https://reviewer.example.test" },
        },
        skipValidation: true,
      });

      // Stub fetch: capture the direct-endpoint call, return a success body.
      globalThis.fetch = (async (url: unknown) => {
        fetched.push(String(url));
        return new Response(JSON.stringify({ ok: true, pr: 5, deliveryId: "d-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const result = await runReviewerRetrigger({ pr: 5, owner: "o", repo: "r" });

      expect(result.ok).toBe(true);
      expect(result.path).toBe("direct");
      expect(result.deliveryId).toBe("d-1");
      // The direct endpoint was hit; no comment fallback involved.
      expect(fetched).toEqual(["https://reviewer.example.test/retrigger"]);
    } finally {
      globalThis.fetch = savedFetch;
      if (savedToken !== undefined) {
        process.env[TOKEN_ENV] = savedToken;
      } else {
        delete process.env[TOKEN_ENV];
      }
      if (savedXdg !== undefined) {
        process.env["XDG_CONFIG_HOME"] = savedXdg;
      } else {
        delete process.env["XDG_CONFIG_HOME"];
      }
    }
  });

  it("errors naming BOTH remediation paths when mcp.auth.token AND github.token are absent", async () => {
    // Isolate from the operator's real user config (which post-mt#2679 is
    // EXPECTED to carry mcp.auth.token) and from env overrides — same
    // hermeticity approach as validate-doctor-commands.test.ts.
    const savedToken = process.env[TOKEN_ENV];
    const savedXdg = process.env["XDG_CONFIG_HOME"];
    delete process.env[TOKEN_ENV];
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    process.env["XDG_CONFIG_HOME"] = join(
      tmpdir(),
      `minsky-retrigger-test-isolated-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    try {
      await initializeConfiguration(new CustomConfigFactory(), {
        overrides: {
          github: {},
          mcp: { auth: {} },
        },
        skipValidation: true,
      });

      await expect(runReviewerRetrigger({ pr: 1, owner: "o", repo: "r" })).rejects.toThrow(
        /mcp\.auth\.token.*github\.token|no usable credential/
      );
      await expect(runReviewerRetrigger({ pr: 1, owner: "o", repo: "r" })).rejects.toThrow(
        "config doctor --fix"
      );
    } finally {
      if (savedToken !== undefined) {
        process.env[TOKEN_ENV] = savedToken;
      } else {
        delete process.env[TOKEN_ENV];
      }
      if (savedXdg !== undefined) {
        process.env["XDG_CONFIG_HOME"] = savedXdg;
      } else {
        delete process.env["XDG_CONFIG_HOME"];
      }
    }
  });
});
