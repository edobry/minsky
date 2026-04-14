/**
 * AI Commands for Shared Command System
 *
 * Thin aggregator — delegates to sub-modules by command group.
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
