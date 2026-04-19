/**
 * AI Commands for Shared Command System
 *
 * Barrel re-export — sub-modules contain the actual implementations:
 *   - ai/completion-commands.ts  — ai.complete, ai.fast-apply, ai.chat
 *   - ai/model-cache-commands.ts — ai.models.available, ai.models.refresh,
 *                                  ai.models.list, ai.cache.clear
 *   - ai/provider-commands.ts    — ai.validate, ai.providers.list
 *   - ai/shared-helpers.ts       — getResolvedConfig()
 */

import { registerCompletionCommands } from "./ai/completion-commands";
import { registerModelCacheCommands } from "./ai/model-cache-commands";
import { registerProviderCommands } from "./ai/provider-commands";

/**
 * Register all AI-related shared commands
 */
export function registerAiCommands(): void {
  registerCompletionCommands();
  registerModelCacheCommands();
  registerProviderCommands();
}
