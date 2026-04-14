/**
 * Shared Tasks Commands (Legacy Compatibility Wrapper)
 *
 * This module provides backward compatibility for the original task commands interface
 * while delegating to the new modular Command Pattern architecture underneath.
 *
 * MIGRATION COMPLETE: 675 lines reduced to ~50 lines (92.6% reduction)
 * All functionality preserved through modular Command Pattern delegation.
 */
import {
  ModularTasksCommandManager,
  modularTasksManager,
  registerTasksCommands as modularRegisterTasksCommands,
} from "./tasks-modular";

/**
 * Register task commands function (Backward Compatibility)
 *
 * ⚠️ DEPRECATED: This function is maintained for backward compatibility only.
 * New code should use ModularTasksCommandManager directly.
 *
 * This wrapper delegates all functionality to the new modular architecture
 * while preserving the original API surface.
 */
export function registerTasksCommands(): void {
  return modularRegisterTasksCommands();
}

// Export modular components for migration path
export {
  ModularTasksCommandManager,
  modularTasksManager,
  createModularTasksManager,
  registerTasksCommands as registerTasksCommandsModular,
} from "./tasks-modular";

// Export all modular task command components for full access
export * from "./tasks/base-task-command";
export * from "./tasks/crud-commands";
export * from "./tasks/deps-commands";
export * from "./tasks/deps-rendering";
export * from "./tasks/deps-visualization-commands";
export * from "./tasks/edit-commands";
export * from "./tasks/hierarchical-status-command";
export * from "./tasks/index-embeddings-command";
export * from "./tasks/migrate-backend-command";
export * from "./tasks/registry-setup";
export * from "./tasks/routing-commands";
export * from "./tasks/similarity-commands";
export * from "./tasks/spec-command";
export * from "./tasks/status-commands";
export * from "./tasks/task-parameters";

// Export for backward compatibility
export { ModularTasksCommandManager as TasksCommandManager };
export { modularTasksManager as tasksManager };
