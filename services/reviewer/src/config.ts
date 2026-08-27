/**
 * Environment configuration for the minsky-reviewer service.
 *
 * Separated from the rest of the code so the shape of required config is
 * documented in one place, and so the service can fail fast at boot if
 * required variables are missing.
 */

import { log } from "./logger";

/**
 * The model providers the reviewer can be configured to use.
 *
 * Array first, type derived — same reason as `REASONING_EFFORTS` in
 * `providers.ts`: `loadConfig` and the eval runner both VALIDATE a runtime
 * string against this set, and a hand-enumerated copy in either place drifts
 * silently the day a provider is added or removed.
 */
export const REVIEWER_PROVIDERS = ["openai", "google", "anthropic"] as const;

export type ReviewerProvider = (typeof REVIEWER_PROVIDERS)[number];

export interface ReviewerConfig {
  appId: number;
  privateKey: string;
  installationId: number;
  webhookSecret: string;

  // Reviewer model provider — MUST be different from the implementer's model
  // family for real architectural independence. See the Structural Review
  // position paper, section "Nine levers — lever 2: Model diversity."
  provider: ReviewerProvider;
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
 * call time. This is the single place their names are written down, and as of
 * mt#4619 that is enforced rather than promised: every reader indexes this
 * object instead of spelling the string, so an operator auditing reviewer
 * configuration can find the whole set here without grepping the source tree.
 *
 * Before mt#4619 the promise was kept by only one of the three entries.
 * `EXPERIMENT_MODEL` went through `config-arm.ts`; the two toolloop names were
 * ALSO spelled literally at each read — six sites for
 * `TOOLLOOP_RETRY_ON_TIMEOUT` across source and test fixtures — so a rename
 * here could update this object and leave every reader compiling against the
 * old name.
 *
 * Two drift directions, closed by two mechanisms, because only one is a type:
 *
 *  - **A reader naming an entry this object does not have** cannot compile.
 *    Readers index a property of an `as const` object, so `.TOOLOOP_RETRY` is
 *    a type error rather than an `undefined` that silently reads no env var.
 *  - **An entry here that nothing reads** is invisible to the compiler —
 *    nothing can require a call site to EXIST — and is covered by
 *    `calltime-env-var-wiring.test.ts`.
 *
 * Why call-time rather than ReviewerConfig: the production callers don't
 * thread a per-call retry config through, and reading at call time keeps the
 * surface narrow while still being operator-tunable. If operational
 * complexity grows (more retry knobs, hot-reload, etc.) the proper fix is
 * to plumb them through ReviewerConfig.
 *
 * This paragraph used to also claim `providers.ts` is "a sealed module without
 * imports from `./config`". That was not true when written — `providers.ts`
 * already imported `ReviewerConfig` as a type — and it is not a constraint:
 * `config.ts` imports only `./logger`, so nothing here can close a cycle back
 * on a module that imports it.
 *
 * Defaults live with their readers in `providers.ts`
 * (`DEFAULT_TOOLLOOP_RETRY_TIMEOUT_MS = 120000`; the enable flag defaults
 * `"true"` — see `parseToolloopRetryEnabled`).
 *
 * mt#1969; enforced by mt#4619.
 */
export const REVIEWER_CALLTIME_ENV_VAR_NAMES = {
  /** Enable single retry on toolloop `TimeoutError`. Default `"true"`. */
  TOOLLOOP_RETRY_ON_TIMEOUT: "REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT",
  /** Timeout ceiling for the retry attempt (matches primary). Default `120000` ms. */
  TOOLLOOP_RETRY_TIMEOUT_MS: "REVIEWER_TOOLLOOP_RETRY_TIMEOUT_MS",
  /**
   * Candidate model for a per-PR A/B arm (mt#4569). Unset — the default —
   * means no experiment is running and every PR uses `REVIEWER_MODEL`. When
   * set, even-numbered PRs are reviewed by this model and odd-numbered PRs by
   * `REVIEWER_MODEL`, so both arms occupy the same window and a cohort
   * comparison needs no time predicate. Read in `config-arm.ts`; unsetting it
   * ends the experiment with no deploy of new code.
   */
  EXPERIMENT_MODEL: "REVIEWER_EXPERIMENT_MODEL",
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
  if (!REVIEWER_PROVIDERS.includes(provider)) {
    throw new Error(
      `minsky-reviewer: REVIEWER_PROVIDER must be one of ${REVIEWER_PROVIDERS.join("|")}, got "${provider}"`
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

    // mt#1086 — timeout budgets sized to production traffic:
    //   model: 120s per tool-loop round. Production data (2026-05-24):
    //          successful reviews complete in 50-60s; transient timeouts
    //          recover via callToolloopWithRetry in 10-20s.
    //   toolloop retry: 120s (matches primary; see providers.ts).
    //   github: 30s — every GitHub REST call returns in <5s on the happy
    //          path; 30s buys headroom for transient slow paths.
    modelTimeoutMs: parsePositiveIntEnv("REVIEWER_MODEL_TIMEOUT_MS", 120_000),
    githubTimeoutMs: parsePositiveIntEnv("REVIEWER_GITHUB_TIMEOUT_MS", 30_000),
  };
}
