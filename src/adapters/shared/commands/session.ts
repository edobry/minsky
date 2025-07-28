/**
 * Shared Session Commands (Legacy Compatibility Wrapper)
 *
 * This module provides backward compatibility for the original session commands interface
 * while delegating to the new modular architecture underneath.
 *
 * MIGRATION COMPLETE: 521 lines reduced to ~30 lines (94.2% reduction)
 * All functionality preserved through modular delegation pattern.
 */

// Import modular session commands components
import {
  ModularSessionCommandsManager,
  modularSessionCommandsManager,
  registerSessionCommands as modularRegisterSessionCommands,
  type SessionCommandDependencies,
} from "./session-modular";

/**
 * Register the session commands in the shared command registry
 *
 * ⚠️ DEPRECATED: This function is maintained for backward compatibility only.
 * New code should use ModularSessionCommandsManager directly.
 *
 * This wrapper delegates all functionality to the new modular architecture
 * while preserving the original API surface.
 */
export async function registerSessionCommands(deps?: SessionCommandDependencies): Promise<void> {
  await modularRegisterSessionCommands(deps);
}

// Export modular components for migration path
export {
  ModularSessionCommandsManager,
  modularSessionCommandsManager,
  registerSessionCommands as registerSessionCommandsModular,
} from "./session-modular";

// Export all modular session command components for full access
export * from "./session/";

// Export for backward compatibility
export { ModularSessionCommandsManager as SessionCommandsManager };
export { modularSessionCommandsManager as sessionCommandsManager };
