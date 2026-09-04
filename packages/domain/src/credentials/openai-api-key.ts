/**
 * Read the configured OpenAI API key (mt#4936).
 *
 * Mirrors `./anthropic-api-key.ts` exactly — same "one read, one place"
 * rationale, new consumer: `AcpTransport` (`src/cockpit/acp-transport.ts`)
 * sets `OPENAI_API_KEY`/`CODEX_API_KEY` in the spawned `codex-acp` child's
 * env when a drive's `auth_mode` is `"api-key"`.
 *
 * `ai.providers.openai.apiKey` is an EXISTING, already-provisioned config key
 * (`packages/domain/src/configuration/schemas/ai.ts`), read here by a new
 * consumer — not a new integration (mt#4936 Planning Audit, gate (n)).
 */
import { getConfiguration } from "../configuration/index";

/**
 * The configured OpenAI API key, or `null` when unset OR when the global
 * configuration provider has not been initialized (mirrors
 * `readConfiguredAnthropicApiKey`'s documented behavior under `bun test`,
 * mt#3254). Never throws.
 */
export function readConfiguredOpenAiApiKey(): string | null {
  try {
    const cfg = getConfiguration();
    return cfg.ai?.providers?.openai?.apiKey ?? null;
  } catch {
    return null;
  }
}
