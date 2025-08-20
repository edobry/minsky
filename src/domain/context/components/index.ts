export { EnvironmentComponent } from "./environment";
export { TaskContextComponent } from "./task-context";
export { WorkspaceRulesComponent } from "./workspace-rules";
export { ProjectContextComponent } from "./project-context";
export { SystemInstructionsComponent } from "./system-instructions";
export { SessionContextComponent } from "./session-context";
export { ToolSchemasComponent } from "./tool-schemas";
export { ErrorContextComponent } from "./error-context";
export { FileContentComponent } from "./file-content";
export { DependencyContextComponent } from "./dependency-context";
export { TestContextComponent } from "./test-context";
export { ConversationHistoryComponent } from "./conversation-history";

export { DefaultContextComponentRegistry } from "./registry";

// Re-export the registry function
export function getContextComponentRegistry() {
  const { getContextComponentRegistry: getRegistry } = require("./registry");
  return getRegistry();
}

export function registerDefaultComponents() {
  const { getContextComponentRegistry } = require("./registry"); // Dynamic import
  const registry = getContextComponentRegistry();

  // Register all components using dynamic imports to avoid circular dependencies
  const { EnvironmentComponent } = require("./environment");
  registry.register(EnvironmentComponent);

  const { TaskContextComponent } = require("./task-context");
  registry.register(TaskContextComponent);

  const { WorkspaceRulesComponent } = require("./workspace-rules");
  registry.register(WorkspaceRulesComponent);

  const { ProjectContextComponent } = require("./project-context");
  registry.register(ProjectContextComponent);

  const { SystemInstructionsComponent } = require("./system-instructions");
  registry.register(SystemInstructionsComponent);

  const { SessionContextComponent } = require("./session-context");
  registry.register(SessionContextComponent);

  const { ToolSchemasComponent } = require("./tool-schemas");
  registry.register(ToolSchemasComponent);

  const { ErrorContextComponent } = require("./error-context");
  registry.register(ErrorContextComponent);

  const { FileContentComponent } = require("./file-content");
  registry.register(FileContentComponent);

  const { DependencyContextComponent } = require("./dependency-context");
  registry.register(DependencyContextComponent);

  const { TestContextComponent } = require("./test-context");
  registry.register(TestContextComponent);

  const { ConversationHistoryComponent } = require("./conversation-history");
  registry.register(ConversationHistoryComponent);

  // Register new Cursor-specific components
  const { CommunicationComponent } = require("./communication");
  registry.register(CommunicationComponent);

  const { ToolCallingRulesComponent } = require("./tool-calling-rules");
  registry.register(ToolCallingRulesComponent);

  const { MaximizeParallelToolCallsComponent } = require("./maximize-parallel-tool-calls");
  registry.register(MaximizeParallelToolCallsComponent);

  const { MaximizeContextUnderstandingComponent } = require("./maximize-context-understanding");
  registry.register(MaximizeContextUnderstandingComponent);

  const { MakingCodeChangesComponent } = require("./making-code-changes");
  registry.register(MakingCodeChangesComponent);

  const { TaskManagementComponent } = require("./task-management");
  registry.register(TaskManagementComponent);

  const { CodeCitationFormatComponent } = require("./code-citation-format");
  registry.register(CodeCitationFormatComponent);

  return registry;
}

export function getAvailableComponentIds(): string[] {
  const { EnvironmentComponent } = require("./environment");
  const { TaskContextComponent } = require("./task-context");
  const { WorkspaceRulesComponent } = require("./workspace-rules");
  const { ProjectContextComponent } = require("./project-context");
  const { SystemInstructionsComponent } = require("./system-instructions");
  const { SessionContextComponent } = require("./session-context");
  const { ToolSchemasComponent } = require("./tool-schemas");
  const { ErrorContextComponent } = require("./error-context");
  const { FileContentComponent } = require("./file-content");
  const { DependencyContextComponent } = require("./dependency-context");
  const { TestContextComponent } = require("./test-context");
  const { ConversationHistoryComponent } = require("./conversation-history");

  // New Cursor-specific components
  const { CommunicationComponent } = require("./communication");
  const { ToolCallingRulesComponent } = require("./tool-calling-rules");
  const { MaximizeParallelToolCallsComponent } = require("./maximize-parallel-tool-calls");
  const { MaximizeContextUnderstandingComponent } = require("./maximize-context-understanding");
  const { MakingCodeChangesComponent } = require("./making-code-changes");
  const { TaskManagementComponent } = require("./task-management");
  const { CodeCitationFormatComponent } = require("./code-citation-format");

  return [
    EnvironmentComponent.id,
    TaskContextComponent.id,
    WorkspaceRulesComponent.id,
    ProjectContextComponent.id,
    SystemInstructionsComponent.id,
    SessionContextComponent.id,
    ToolSchemasComponent.id,
    ErrorContextComponent.id,
    FileContentComponent.id,
    DependencyContextComponent.id,
    TestContextComponent.id,
    ConversationHistoryComponent.id,
    // New Cursor-specific components
    CommunicationComponent.id,
    ToolCallingRulesComponent.id,
    MaximizeParallelToolCallsComponent.id,
    MaximizeContextUnderstandingComponent.id,
    MakingCodeChangesComponent.id,
    TaskManagementComponent.id,
    CodeCitationFormatComponent.id,
  ];
}

export function getComponentHelp() {
  const registry = registerDefaultComponents();
  return registry.listComponents();
}
