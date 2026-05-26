/**
 * Anthropic API key provider (mt#1426).
 *
 * Anthropic keys are coarse-grained (no per-scope structure); a key either
 * works for the Messages API or it doesn't. Both stages hit
 * `GET /v1/models`, which is the cheapest authenticated read.
 */
import type { CredentialProvider, CredentialCheckResult } from "../types";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION = "2023-06-01";

interface AnthropicModelsResponse {
  data?: unknown;
}

async function callModels(token: string): Promise<CredentialCheckResult> {
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MODELS_URL, {
      method: "GET",
      headers: {
        "x-api-key": token,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
    });
  } catch (error) {
    return {
      ok: false,
      detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      detail: "401 Unauthorized — API key invalid or revoked",
      unauthorized: true,
    };
  }
  if (response.status === 403) {
    return { ok: false, detail: "403 Forbidden — API key lacks required permissions" };
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
  }

  let body: AnthropicModelsResponse;
  try {
    body = (await response.json()) as AnthropicModelsResponse;
  } catch {
    return { ok: false, detail: "response was not valid JSON" };
  }
  const count = Array.isArray(body.data) ? body.data.length : 0;
  return { ok: true, detail: `${count} model${count === 1 ? "" : "s"} accessible` };
}

export const anthropicProvider: CredentialProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  configPath: "ai.providers.anthropic.apiKey",
  acquireUrl: "https://console.anthropic.com/settings/keys",
  scopeGuidance:
    "Create a new API key in the Anthropic Console. Keys are prefixed `sk-ant-`. Anthropic keys are coarse-grained — no scope selection is required.",
  validate: callModels,
  test: callModels,
};
