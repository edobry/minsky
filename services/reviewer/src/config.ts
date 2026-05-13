/**
 * Environment configuration for the minsky-reviewer service.
 *
 * Separated from the rest of the code so the shape of required config is
 * documented in one place, and so the service can fail fast at boot if
 * required variables are missing.
 */

import { log } from "./logger";

export interface ReviewerConfig {
  appId: number;
  privateKey: string;
  installationId: number;
  webhookSecret: string;

  // Reviewer model provider — MUST be different from the implementer's model
  // family for real architectural independence. See the Structural Review
  // position paper, section "Nine levers — lever 2: Model diversity."
  provider: "openai" | "google" | "anthropic";
  providerApiKey: string;
  providerModel: string;

  tier2Enabled: boolean;

  // Optional Minsky MCP endpoint, used for both provenance-based tier
  // resolution (mt#1085) and task-spec fetch (mt#1187). When either field
  // is absent, both features fall back to their degraded paths — tier falls
  // back to the PR-body marker, task spec stays null. A startup warning is
  // logged in that case.
  mcpUrl: string | undefined;
  mcpToken: string | undefined;

  port: number;
  logLevel: "debug" | "info" | "warn" | "error";

  // mt#1086: per-operation network-call timeouts. Bun's fetch has no
  // default timeout; without these the webhook response stays open until
  // the platform kills the worker. Defaults are deliberately generous:
  // gpt-5 reviewer runs can take 60-90s; GitHub API calls should always
  // return within seconds even on cold paths.
  modelTimeoutMs: number;
  githubTimeoutMs: number;
}

/**
 * Parse a positive-integer env var with a default fallback. Throws at
 * config-load time on `=abc`, `=-5`, `=0`, `=NaN`, `=3.14`, `= ` — any
 * non-positive-integer value. This is mt#1086's stricter cousin of the
 * loose `parseInt` pattern used elsewhere in this file; only the new
 * timeout fields use it, to make misconfigured timeouts a fail-fast
 * boot error rather than a silent NaN that triggers infinite waits.
 *
 * Exported for tests.
 */
export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  // Strict integer parse: no leading whitespace, optional + sign, digits.
  if (!/^\+?\d+$/.test(raw)) {
    throw new Error(`minsky-reviewer: ${name} must be a positive integer (got "${raw}")`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`minsky-reviewer: ${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `minsky-reviewer: required env var ${name} is not set. See services/reviewer/README.md for setup.`
    );
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): ReviewerConfig {
  const provider = requireEnv("REVIEWER_PROVIDER") as ReviewerConfig["provider"];
  if (!["openai", "google", "anthropic"].includes(provider)) {
    throw new Error(
      `minsky-reviewer: REVIEWER_PROVIDER must be one of openai|google|anthropic, got "${provider}"`
    );
  }

  const providerApiKey = (() => {
    switch (provider) {
      case "openai":
        return requireEnv("OPENAI_API_KEY");
      case "google":
        return requireEnv("GOOGLE_AI_API_KEY");
      case "anthropic":
        return requireEnv("ANTHROPIC_API_KEY");
    }
  })();

  const providerModel = (() => {
    switch (provider) {
      case "openai":
        return optionalEnv("REVIEWER_MODEL", "gpt-5");
      case "google":
        return optionalEnv("REVIEWER_MODEL", "gemini-2.5-pro");
      case "anthropic":
        return optionalEnv("REVIEWER_MODEL", "claude-sonnet-4-6");
    }
  })();

  const mcpUrl = process.env["MINSKY_MCP_URL"] ?? undefined;
  // mt#1825: prefer canonical name (matches server-side); fall back to legacy
  // name during the rename migration window. Remove the fallback in a follow-up
  // after the Railway env-var rename has propagated.
  const mcpToken =
    process.env["MINSKY_MCP_AUTH_TOKEN"] ?? process.env["MINSKY_MCP_TOKEN"] ?? undefined;

  if (!mcpUrl || !mcpToken) {
    log.warn(
      "minsky-reviewer: MINSKY_MCP_URL or MINSKY_MCP_AUTH_TOKEN is not set. " +
        "Provenance-based tier resolution (mt#1085) falls back to the PR-body marker, " +
        "and task-spec fetch (mt#1187) is disabled for every review."
    );
  }

  return {
    appId: parseInt(requireEnv("MINSKY_REVIEWER_APP_ID"), 10),
    privateKey: requireEnv("MINSKY_REVIEWER_PRIVATE_KEY"),
    installationId: parseInt(requireEnv("MINSKY_REVIEWER_INSTALLATION_ID"), 10),
    webhookSecret: requireEnv("MINSKY_REVIEWER_WEBHOOK_SECRET"),

    provider,
    providerApiKey,
    providerModel,

    tier2Enabled: optionalEnv("MINSKY_REVIEWER_TIER2_ENABLED", "false") === "true",

    mcpUrl,
    mcpToken,

    port: parseInt(optionalEnv("PORT", "3000"), 10),
    logLevel: optionalEnv("LOG_LEVEL", "info") as ReviewerConfig["logLevel"],

    // mt#1086 — defaults sized to actual production traffic patterns:
    //   model: 120s — gpt-5 with reasoning_effort=high on a Tier-3 PR
    //          regularly takes 60-90s end-to-end including tool-use rounds.
    //   github: 30s — every GitHub REST call we make returns in <5s on the
    //          happy path; 30s buys headroom for transient slow paths
    //          without holding webhooks open through GitHub's own timeout.
    modelTimeoutMs: parsePositiveIntEnv("REVIEWER_MODEL_TIMEOUT_MS", 120_000),
    githubTimeoutMs: parsePositiveIntEnv("REVIEWER_GITHUB_TIMEOUT_MS", 30_000),
  };
}
