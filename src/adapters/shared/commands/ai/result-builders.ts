/**
 * Pure result builders for the `ai.*` shared commands (mt#2727).
 *
 * Root cause of mt#2727: every `ai.*` command's `execute()` printed its
 * computed data via `log.cli(...)` and implicitly returned `undefined`. The
 * MCP adapter serializes the `execute()` RETURN VALUE as the tool result, so
 * every MCP caller of a read-only `ai_*` tool received the literal string
 * `"undefined"` even though the underlying data was computed correctly.
 *
 * These builders are the single place each command's `execute()` shapes its
 * structured return value. Keeping them as small, dependency-free pure
 * functions (no service-factory calls, no logging) means the "does execute()
 * actually return the data" invariant is unit-testable without needing
 * `mock.module()` — which `custom/no-global-module-mocks` forbids outside
 * `tests/setup.ts` — since a builder can be exercised directly with plain
 * fixture data standing in for whatever the domain services would have
 * returned.
 *
 * CLI human-readable rendering of these same shapes lives in
 * `src/adapters/cli/customizations/ai-customizations.ts`, mirroring the
 * `config.list` / `config.show` pattern (formatter over the returned value,
 * not inline `log.cli` calls inside `execute()`).
 */

import type {
  ProviderValidationResult,
  ProviderStatusInfo,
} from "@minsky/domain/ai/provider-operations";
import type {
  ValidationError as AiValidationError,
  ValidationWarning,
  AIModel,
  AIUsage,
} from "@minsky/domain/ai/types";
import type { CachedProviderModel, ModelCacheMetadata } from "@minsky/domain/ai/model-cache/types";

/**
 * Result shape for `ai.validate`.
 *
 * `json` is carried on the result (not just the input params) so the CLI
 * outputFormatter — which only receives the returned result, not the
 * original params — can branch on it, matching the `config.list` pattern.
 */
export interface AiValidateResult {
  success: boolean;
  json: boolean;
  valid: boolean;
  errors: AiValidationError[];
  warnings: ValidationWarning[];
  providers: ProviderValidationResult[];
}

export function buildValidateResult(params: {
  valid: boolean;
  json: boolean;
  errors: AiValidationError[];
  warnings: ValidationWarning[];
  providers: ProviderValidationResult[];
}): AiValidateResult {
  return {
    success: params.valid,
    json: params.json,
    valid: params.valid,
    errors: params.errors,
    warnings: params.warnings,
    providers: params.providers,
  };
}

/** Result shape for `ai.providers.list`. */
export interface AiProvidersListResult {
  success: true;
  json: boolean;
  format: string;
  providers: ProviderStatusInfo[];
}

export function buildProvidersListResult(
  providers: ProviderStatusInfo[],
  json: boolean,
  format: string
): AiProvidersListResult {
  return { success: true, json, format, providers };
}

/**
 * Guidance shown when `ai.models.available` finds zero models — mirrors the
 * CLI's prior inline `log.cliWarn(...)` text exactly. `header` lines print
 * without a bullet; `reasons` lines print with a `  - ` bullet prefix.
 */
export interface AiModelsAvailableEmptyGuidance {
  header: string[];
  reasons: string[];
  /** Only set when no `provider` filter was given (matches prior CLI text). */
  configHint?: string;
}

/** Result shape for `ai.models.available`. */
export interface AiModelsAvailableResult {
  success: true;
  json: boolean;
  format: string;
  provider: string | null;
  models: AIModel[];
  /** Populated only when `models` is empty. */
  emptyGuidance?: AiModelsAvailableEmptyGuidance;
}

export function buildModelsAvailableResult(params: {
  provider: string | undefined;
  models: AIModel[];
  json: boolean;
  format: string;
}): AiModelsAvailableResult {
  const { provider, models, json, format } = params;

  const emptyGuidance: AiModelsAvailableEmptyGuidance | undefined =
    models.length > 0
      ? undefined
      : provider
        ? {
            header: [`No models available for provider '${provider}'. This may be because:`],
            reasons: [
              "The provider doesn't support model listing",
              "The API key is not configured or invalid",
              "The provider name is incorrect",
            ],
          }
        : {
            header: ["No models available from any configured providers.", "This may be because:"],
            reasons: [
              "No API keys are configured",
              "Providers don't support model listing",
              "Network connectivity issues",
            ],
            configHint:
              "\nTo configure providers, see: https://github.com/edobry/minsky#ai-completion-backend",
          };

  return {
    success: true,
    json,
    format,
    provider: provider ?? null,
    models,
    ...(emptyGuidance ? { emptyGuidance } : {}),
  };
}

/** Result shape for `ai.models.list`. */
export interface AiModelsListResult {
  success: true;
  json: boolean;
  format: string;
  showCache: boolean;
  models: Record<string, CachedProviderModel[]>;
  cacheMetadata?: ModelCacheMetadata;
}

export function buildModelsListResult(params: {
  models: Record<string, CachedProviderModel[]>;
  json: boolean;
  format: string;
  showCache: boolean;
  cacheMetadata?: ModelCacheMetadata;
}): AiModelsListResult {
  return {
    success: true,
    json: params.json,
    format: params.format,
    showCache: params.showCache,
    models: params.models,
    ...(params.cacheMetadata ? { cacheMetadata: params.cacheMetadata } : {}),
  };
}

/** Result shape for `ai.complete`. */
export interface AiCompleteResult {
  success: true;
  content: string;
  model: string | null;
  provider: string | null;
  usage: AIUsage | null;
  streamed: boolean;
}

export function buildCompleteResult(params: {
  content: string;
  model?: string | null;
  provider?: string | null;
  usage?: AIUsage | null;
  streamed: boolean;
}): AiCompleteResult {
  return {
    success: true,
    content: params.content,
    model: params.model ?? null,
    provider: params.provider ?? null,
    usage: params.usage ?? null,
    streamed: params.streamed,
  };
}
