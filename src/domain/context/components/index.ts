// Export main types and interfaces
export type {
  ContextComponent,
  ComponentInput,
  ComponentOutput,
  ComponentInputs,
  ContextComponentRegistry,
} from "./types";

// Export registry functionality
export {
  DefaultContextComponentRegistry,
  getContextComponentRegistry,
  setContextComponentRegistry,
  resetContextComponentRegistry,
} from "./registry";

// Export individual components
export { EnvironmentComponent, createEnvironmentComponent } from "./environment";
export { TaskContextComponent, createTaskContextComponent } from "./task-context";
export { WorkspaceRulesComponent, createWorkspaceRulesComponent } from "./workspace-rules";
export { ProjectContextComponent, createProjectContextComponent } from "./project-context";
export {
  SystemInstructionsComponent,
  createSystemInstructionsComponent,
} from "./system-instructions";
export { SessionContextComponent, createSessionContextComponent } from "./session-context";
export { ToolSchemasComponent, createToolSchemasComponent } from "./tool-schemas";

// Registry management functions
export function registerDefaultComponents(): void {
  const { getContextComponentRegistry } = require("./registry");
  const { EnvironmentComponent } = require("./environment");
  const { TaskContextComponent } = require("./task-context");
  const { WorkspaceRulesComponent } = require("./workspace-rules");
  const { ProjectContextComponent } = require("./project-context");
  const { SystemInstructionsComponent } = require("./system-instructions");
  const { SessionContextComponent } = require("./session-context");
  const { ToolSchemasComponent } = require("./tool-schemas");

  const registry = getContextComponentRegistry();
  registry.register(EnvironmentComponent);
  registry.register(TaskContextComponent);
  registry.register(WorkspaceRulesComponent);
  registry.register(ProjectContextComponent);
  registry.register(SystemInstructionsComponent);
  registry.register(SessionContextComponent);
  registry.register(ToolSchemasComponent);
}

export function getAvailableComponentIds(): string[] {
  const { getContextComponentRegistry } = require("./registry");
  const registry = getContextComponentRegistry();
  return registry.listComponents().map((c) => c.id);
}

export function getComponentHelp(): Array<{ id: string; description: string }> {
  const { getContextComponentRegistry } = require("./registry");
  const registry = getContextComponentRegistry();
  const components = registry.listComponents();

  return components.map((c) => ({ id: c.id, description: c.description }));
}
