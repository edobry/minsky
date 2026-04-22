/**
 * Environment configuration for the minsky-reviewer service.
 *
 * Separated from the rest of the code so the shape of required config is
 * documented in one place, and so the service can fail fast at boot if
 * required variables are missing.
 */

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

  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
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

  return {
    appId: parseInt(requireEnv("MINSKY_REVIEWER_APP_ID"), 10),
    privateKey: requireEnv("MINSKY_REVIEWER_PRIVATE_KEY"),
    installationId: parseInt(requireEnv("MINSKY_REVIEWER_INSTALLATION_ID"), 10),
    webhookSecret: requireEnv("MINSKY_REVIEWER_WEBHOOK_SECRET"),

    provider,
    providerApiKey,
    providerModel,

    tier2Enabled: optionalEnv("MINSKY_REVIEWER_TIER2_ENABLED", "false") === "true",

    port: parseInt(optionalEnv("PORT", "3000"), 10),
    logLevel: optionalEnv("LOG_LEVEL", "info") as ReviewerConfig["logLevel"],
  };
}
