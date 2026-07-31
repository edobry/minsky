/**
 * Anthropic Model Fetcher
 *
 * Fetches Claude model definitions from Anthropic's `GET /v1/models` endpoint.
 * Token limits and capability data come from that same response rather than a
 * hand-maintained table — see `convertToAnthropicCachedModel` for the mapping.
 */

import { ModelFetcher, CachedProviderModel, ModelFetchConfig, ModelFetchError } from "../types";
import { AICapability } from "../../types";
import { log } from "@minsky/shared/logger";

/**
 * One entry of Anthropic's `GET /v1/models` response.
 *
 * `max_input_tokens` is the context window and `max_tokens` the output cap.
 * There is no `context_window` field.
 *
 * The limit fields are declared optional only so that a missing value is
 * representable: every model in the live listing carries both (all 11 entries,
 * measured 2026-07-30 — see mt#3379). `convertToAnthropicCachedModel` drops a
 * model that lacks them rather than substituting a number.
 */
interface AnthropicApiModel {
  id: string;
  display_name?: string;
  created_at?: string;
  type?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: Record<string, unknown>;
}

/**
 * Anthropic model fetcher implementation
 */
export class AnthropicModelFetcher implements ModelFetcher {
  readonly provider = "anthropic";

  private readonly defaultBaseURL = "https://api.anthropic.com/v1";

  /**
   * Fetch models from Anthropic's /v1/models API endpoint
   */
  async fetchModels(config: ModelFetchConfig): Promise<CachedProviderModel[]> {
    try {
      log.debug("Fetching Anthropic models from /v1/models API");

      const baseURL = config.baseURL || this.defaultBaseURL;
      const url = `${baseURL}/models`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = (await response.json()) as { data?: AnthropicApiModel[] };
        const models = data.data || [];

        const cachedModels = models
          .filter((model) => this.isSupportedModel(model.id))
          .map((model) => this.convertToAnthropicCachedModel(model))
          .filter((model): model is CachedProviderModel => model !== null);

        log.info(`Fetched ${cachedModels.length} Anthropic models from API`);
        return cachedModels;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      if (error instanceof ModelFetchError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new ModelFetchError(
        `Failed to fetch Anthropic models: ${errorMessage}`,
        this.provider,
        "FETCH_FAILED",
        undefined,
        { error: errorMessage }
      );
    }
  }

  /**
   * Get capabilities for a specific Anthropic model.
   *
   * Interface method: it receives an id and nothing else, so it can only return
   * what the id alone supports. The richer, listing-derived form is used on the
   * fetch path — see `deriveCapabilities`.
   */
  async getModelCapabilities(modelId: string): Promise<AICapability[]> {
    return this.getCapabilitiesFromModelId(modelId);
  }

  /**
   * Validate API connectivity by listing models.
   *
   * Probes the SAME endpoint `fetchModels` is about to call (`GET /v1/models`,
   * GA — no beta header). This is deliberate: the previous implementation POSTed
   * a real completion to `/v1/messages` with a hardcoded `claude-3-haiku-20240307`
   * and accepted only HTTP 200 or 400. That model was retired, so the probe got a
   * 404 (`not_found_error`), returned false, and the caller surfaced the generic
   * "Failed to connect to provider: anthropic" — while the API was fully reachable
   * and completions kept working. The whole model registry sat empty and stale
   * from 2026-07-10 on account of a dead string constant (mt#3337).
   *
   * Probing the listing endpoint has no model-id coupling, so it cannot rot the
   * same way when a model is retired, and it costs no tokens.
   */
  async validateConnection(config: ModelFetchConfig): Promise<boolean> {
    try {
      const baseURL = config.baseURL || this.defaultBaseURL;
      const url = `${baseURL}/models`;

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        Math.min(config.timeout || 30000, 10000)
      );

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          log.debug("Anthropic connection validation got a non-OK response", {
            status: response.status,
            statusText: response.statusText,
          });
        }
        return response.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      log.debug(`Anthropic connection validation failed`, { error });
      return false;
    }
  }

  /**
   * Capabilities derivable from a model id alone.
   *
   * Used by `getModelCapabilities`, and as the base the listing-derived form
   * refines. `maxTokens` is deliberately omitted: the context window is not
   * knowable from an id, and stating a plausible-looking number for it is the
   * defect mt#3379 removed. The one distinction an id does carry is generation
   * — the claude-2 family predates tool use, vision, and prompt caching.
   */
  private getCapabilitiesFromModelId(modelId: string): AICapability[] {
    const predatesModernCapabilities =
      modelId.startsWith("claude-2") || modelId.startsWith("claude-instant");

    if (predatesModernCapabilities) {
      return [
        { name: "reasoning", supported: true },
        { name: "tool-calling", supported: false },
        { name: "structured-output", supported: false },
        { name: "image-input", supported: false },
        { name: "prompt-caching", supported: false },
      ];
    }

    return [
      { name: "reasoning", supported: true },
      { name: "tool-calling", supported: true },
      { name: "structured-output", supported: true },
      { name: "image-input", supported: true },
      { name: "prompt-caching", supported: true },
    ];
  }

  /**
   * Capabilities for a model we have the full listing entry for.
   *
   * The API's capability tree is NOT renamed wholesale onto `AICapability`:
   * its keys (`batch`, `citations`, `code_execution`, `context_management`,
   * `effort`, `image_input`, `pdf_input`, `structured_outputs`, `thinking`)
   * overlap `AICapability["name"]`'s closed union on exactly two entries. Those
   * two are read from the response; the rest of the union has no API equivalent
   * and stays id-derived. The untruncated tree is kept in
   * `providerMetadata.api_capabilities` so nothing is lost to the projection.
   */
  private deriveCapabilities(apiModel: AnthropicApiModel): AICapability[] {
    const supportedInApi = (key: string): boolean | undefined => {
      const entry = apiModel.capabilities?.[key];
      if (entry !== null && typeof entry === "object" && "supported" in entry) {
        return Boolean((entry as { supported?: unknown }).supported);
      }
      return undefined;
    };

    return this.getCapabilitiesFromModelId(apiModel.id).map((capability) => {
      if (capability.name === "reasoning") {
        // The one place a real number belongs: the model's actual context window.
        return { ...capability, maxTokens: apiModel.max_input_tokens };
      }
      if (capability.name === "image-input") {
        return { ...capability, supported: supportedInApi("image_input") ?? capability.supported };
      }
      if (capability.name === "structured-output") {
        return {
          ...capability,
          supported: supportedInApi("structured_outputs") ?? capability.supported,
        };
      }
      return capability;
    });
  }

  /**
   * Test if a specific model is currently available by making a minimal API call.
   *
   * Unlike `validateConnection`, this legitimately POSTs to `/messages`: it is
   * probing ONE named model's availability, and the id comes from the caller
   * rather than a hardcoded constant, so it cannot rot when a model is retired.
   */
  private async testModelAvailability(
    model: CachedProviderModel,
    config: ModelFetchConfig
  ): Promise<boolean> {
    try {
      const baseURL = config.baseURL || this.defaultBaseURL;
      const url = `${baseURL}/messages`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "x-api-key": config.apiKey,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: model.id,
            max_tokens: 1,
            messages: [
              {
                role: "user",
                content: "test",
              },
            ],
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // 200 = success, 400 = bad request (but model exists)
        // 404 or other errors likely mean model doesn't exist
        return response.status === 200 || response.status === 400;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      log.debug(`Model availability test failed for ${model.id}`, { error });
      return false;
    }
  }

  /**
   * Check if a model ID is supported by our service
   */
  private isSupportedModel(modelId: string): boolean {
    // Filter to Claude models only
    return modelId.toLowerCase().includes("claude");
  }

  /**
   * Convert an Anthropic listing entry into our `CachedProviderModel` format.
   *
   * Returns `null` for an entry the API described without token limits, which
   * excludes it from the cache. That is deliberate: `contextWindow` and
   * `maxOutputTokens` are exactly the fields a caller consults to decide whether
   * a payload fits or which model to route to, so a fabricated value is worse
   * than an absent model — and an absence is visible in `modelCount` where a
   * plausible-looking default is not. This is the failure mt#3379 fixed, in
   * which every current model silently reported 200000/8192.
   */
  private convertToAnthropicCachedModel(apiModel: AnthropicApiModel): CachedProviderModel | null {
    const contextWindow = apiModel.max_input_tokens;
    const maxOutputTokens = apiModel.max_tokens;

    if (contextWindow === undefined || maxOutputTokens === undefined) {
      log.warn("Anthropic model excluded from cache: listing carried no token limits", {
        modelId: apiModel.id,
        hasMaxInputTokens: contextWindow !== undefined,
        hasMaxTokens: maxOutputTokens !== undefined,
      });
      return null;
    }

    const name = apiModel.display_name || apiModel.id;

    return {
      id: apiModel.id,
      provider: this.provider,
      name,
      description: `Anthropic's ${name}`,
      capabilities: this.deriveCapabilities(apiModel),
      contextWindow,
      maxOutputTokens,
      // `costPer1kTokens` is deliberately unset. `GET /v1/models` returns no
      // pricing field of any kind — verified against the live listing, not
      // assumed (mt#3379) — and the hand-maintained price table this fetcher
      // used to carry had gone entirely stale: all six of its entries were
      // retired models, so no model the API returns had ever matched one.
      // Sourcing pricing has its own maintenance story and is tracked
      // separately rather than guessed at here.
      fetchedAt: new Date(),
      status: "available",
      providerMetadata: {
        created_at: apiModel.created_at,
        type: apiModel.type,
        api_capabilities: apiModel.capabilities,
      },
    };
  }
}
