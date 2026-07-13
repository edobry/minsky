import type { CredentialProvider, CredentialCheckResult } from "../types";

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

async function callModels(token: string): Promise<CredentialCheckResult> {
  let response: Response;
  try {
    response = await fetch(`${GEMINI_MODELS_URL}?key=${token}`, {
      method: "GET",
    });
  } catch (error) {
    return {
      ok: false,
      detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 400 || response.status === 403) {
    return {
      ok: false,
      detail: `${response.status} — API key invalid or lacks permissions`,
      unauthorized: true,
    };
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
  }

  let body: { models?: unknown[] };
  try {
    body = (await response.json()) as { models?: unknown[] };
  } catch {
    return { ok: false, detail: "response was not valid JSON" };
  }
  const count = Array.isArray(body.models) ? body.models.length : 0;
  return { ok: true, detail: `${count} model${count === 1 ? "" : "s"} accessible` };
}

export const googleProvider: CredentialProvider = {
  id: "google",
  displayName: "Google AI",
  configPath: "ai.providers.google.apiKey",
  acquireUrl: "https://aistudio.google.com/apikey",
  scopeGuidance:
    "Create an API key in Google AI Studio. Keys are prefixed with 'AIza'. No scope selection is required — the key provides access to all Gemini models including embeddings.",
  validate: callModels,
  test: callModels,
};
