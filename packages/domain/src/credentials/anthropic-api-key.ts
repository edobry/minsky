/**
 * Read the configured Anthropic API key (mt#4935).
 *
 * Single source of truth for "is `ai.providers.anthropic.apiKey` configured,
 * and what is it" — shared by two callers that must never disagree about the
 * answer: the driven-session launch route's `auth_mode: "api-key"` refusal
 * check (`src/cockpit/routes/driven-sessions.ts`, returns 4xx with no
 * credential configured) and the Claude transport's `api-key` spawn
 * (`src/cockpit/claude-transport.ts`, sets `ANTHROPIC_API_KEY` in the
 * child's env). One read, one place.
 *
 * `ai.providers.anthropic.apiKey` is an EXISTING, already-provisioned config
 * key (`packages/domain/src/configuration/schemas/ai.ts`), read here by a new
 * consumer — not a new integration (mt#4935 Planning Audit, gate (n)).
 */
import { getConfiguration } from "../configuration/index";

/**
 * The configured Anthropic API key, or `null` when unset OR when the global
 * configuration provider has not been initialized (mirrors the
 * `initializeConfiguration()` singleton's documented throw — see
 * `getConfiguration`'s own doc comment — which fires under `bun test` by
 * design, mt#3254). Never throws.
 */
export function readConfiguredAnthropicApiKey(): string | null {
  try {
    const cfg = getConfiguration();
    return cfg.ai?.providers?.anthropic?.apiKey ?? null;
  } catch {
    return null;
  }
}
