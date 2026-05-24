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
 * Additional reviewer env vars NOT bound through ReviewerConfig but read at
 * call time. Names declared here so operators auditing reviewer
 * configuration can find them in this file without grepping the full source
 * tree. The actual reads live in `services/reviewer/src/providers.ts`
 * (`resolveToolloopRetryConfig`).
 *
 * Why call-time rather than ReviewerConfig: `providers.ts` is a sealed
 * module without imports from `./config`, and the production callers don't
 * thread a per-call retry config through. Reading at call time keeps the
 * surface narrow while still being operator-tunable. If operational
 * complexity grows (more retry knobs, hot-reload, etc.) the proper fix is
 * to plumb them through ReviewerConfig.
 *
 * Defaults are in `providers.ts` (`DEFAULT_TOOLLOOP_RETRY_TIMEOUT_MS = 120000`;
 * `REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT` defaults `"true"`).
 *
 * mt#1969.
 */
export const REVIEWER_CALLTIME_ENV_VAR_NAMES = {
  /** Enable single retry on toolloop `TimeoutError`. Default `"true"`. */
  TOOLLOOP_RETRY_ON_TIMEOUT: "REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT",
  /** Timeout ceiling for the retry attempt (matches primary). Default `120000` ms. */
  TOOLLOOP_RETRY_TIMEOUT_MS: "REVIEWER_TOOLLOOP_RETRY_TIMEOUT_MS",
} as const;

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
  const mcpToken = process.env["MINSKY_MCP_AUTH_TOKEN"] ?? undefined;

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

    // mt#1086/mt#2083 — timeout budgets sized to production traffic:
    //   model: 120s per tool-loop round. gpt-5 with reasoning_effort=low
    //          takes ~80-100s on normal PRs. Trivial/docs-only PRs skip
    //          the tool loop entirely (mt#2083 scope-aware fast path).
    //   toolloop retry: 120s (matches primary; see providers.ts). Was 90s
    //          pre-mt#2083 but that was shorter than healthy-case latency.
    //   github: 30s — every GitHub REST call returns in <5s on the happy
    //          path; 30s buys headroom for transient slow paths.
    modelTimeoutMs: parsePositiveIntEnv("REVIEWER_MODEL_TIMEOUT_MS", 120_000),
    githubTimeoutMs: parsePositiveIntEnv("REVIEWER_GITHUB_TIMEOUT_MS", 30_000),
  };
}
