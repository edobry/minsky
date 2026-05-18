/**
 * Braintrust event emission — shared substrate for hook + service instrumentation.
 *
 * Originally lived inline in `.claude/hooks/memory-search.ts` (mt#1813, Phase 1a of the
 * Notion Braintrust trace-shape RFC `35e937f0-3cb4-81ba-a6dd-f1f571d1020a`). Extracted
 * by mt#1778 so subsequent metric instrumentations (MCP server tool dispatch, disconnect
 * tracker, reviewer-bot worker, etc.) can re-use the config reader and emit machinery
 * without duplicating ~80 LOC per call site.
 *
 * Design principles:
 * - **Lazy import** of the `braintrust` SDK so callers that never emit don't pay
 *   the import cost. Critical for hooks on the prompt-submit critical path.
 * - **Graceful degradation:** missing config, malformed YAML, SDK failure, network
 *   failure all result in silent skip. Instrumentation never blocks the caller.
 * - **Env-var precedence** over config-file values for portable, overrideable
 *   credentials (matches `environmentMappings` in `src/domain/configuration/sources/environment.ts`).
 * - **YAML kill-switch:** `observability.providers.braintrust.enabled: false` disables
 *   emission even when an env-var apiKey is present.
 *
 * @see mt#1813 — original inline implementation (memory-search hook Phase 1a)
 * @see mt#1778 — this extraction
 * @see mt#1791 — observability config schema (`src/domain/configuration/schemas/observability.ts`)
 */

/**
 * Resolved Braintrust configuration; null when the provider is disabled, missing an
 * apiKey, or the config file can't be read.
 */
export interface BraintrustConfig {
  apiKey: string;
  projectName: string;
  appUrl: string;
}

/**
 * Generic Braintrust event shape. Each field maps directly to the Braintrust SDK's
 * `logger.log()` call. Callers (memory-search hook, disconnect tracker, MCP server,
 * etc.) build the per-source shape; this module performs the SDK interaction.
 */
export interface BraintrustEvent {
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Read Braintrust config from env vars (highest precedence) then
 * `~/.config/minsky/config.yaml` under `observability.providers.braintrust.*`.
 *
 * Returns null when the provider is disabled, missing an apiKey, or the config
 * file can't be read.
 *
 * The one exception to env-var precedence: the `enabled` flag is YAML-only —
 * there's no env-var mapping for it, so we always consult YAML to determine
 * enabled-ness, regardless of whether apiKey came from env or YAML.
 */
export async function readBraintrustConfig(): Promise<BraintrustConfig | null> {
  // Env vars take precedence over YAML values for the same fields (matches the
  // `environmentMappings` table in src/domain/configuration/sources/environment.ts).
  let apiKey: string | undefined = process.env.BRAINTRUST_API_KEY;
  let projectName: string | undefined = process.env.BRAINTRUST_PROJECT_NAME;
  let appUrl: string | undefined = process.env.BRAINTRUST_API_URL;
  let enabled = true;

  try {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home) {
      const configPath = `${home}/.config/minsky/config.yaml`;
      const yaml = await import("yaml");
      const content = await Bun.file(configPath).text();
      const parsed = yaml.parse(content) as Record<string, unknown> | undefined;
      const obs = (parsed?.["observability"] as Record<string, unknown> | undefined)?.[
        "providers"
      ] as Record<string, unknown> | undefined;
      const bt = obs?.["braintrust"] as
        | { apiKey?: string; projectName?: string; apiUrl?: string; enabled?: boolean }
        | undefined;
      if (bt) {
        // YAML values fill in only where env vars haven't already set them.
        apiKey = apiKey ?? bt.apiKey;
        projectName = projectName ?? bt.projectName;
        appUrl = appUrl ?? bt.apiUrl;
        // `enabled` is always YAML-driven (no env-var mapping); explicit
        // `enabled: false` disables emission even when an apiKey is set via env.
        enabled = bt.enabled !== false;
      }
    }
  } catch {
    // YAML read/parse failure: fall through with whatever env vars provided.
    // If apiKey is still unset after env+YAML, the next check returns null.
  }

  if (!apiKey || !enabled) return null;
  return {
    apiKey,
    projectName: projectName ?? "minsky",
    appUrl: appUrl ?? "https://api.braintrust.dev",
  };
}

/**
 * Emit a single event to Braintrust. Lazy-imports the SDK only when config is
 * present. Synchronous flush (`asyncFlush: false`) so the event lands before
 * the caller's process exits — important for short-lived hook invocations.
 *
 * Always awaitable; never throws on any condition the caller should handle —
 * internal failures (config missing, SDK import failure, network error) are
 * swallowed. Callers should always `await emitBraintrustEvent(...)` before
 * exiting, but never need to wrap in try/catch.
 */
export async function emitBraintrustEvent(event: BraintrustEvent): Promise<void> {
  try {
    const cfg = await readBraintrustConfig();
    if (!cfg) return;

    const { initLogger } = await import("braintrust");
    const logger = initLogger({
      apiKey: cfg.apiKey,
      projectName: cfg.projectName,
      appUrl: cfg.appUrl,
      asyncFlush: false,
    });

    await logger.log(event);
  } catch {
    // Instrumentation failures never block the caller.
  }
}
