/**
 * DI Injection Tokens
 *
 * String-based tokens for the 7 core AppServices. Used with tsyringe's
 * container.register() and @inject() decorator.
 *
 * These tokens match the keys in AppServices for consistency with the
 * existing container.get("key") pattern.
 */

export const TOKENS = {
  persistence: "persistence",
  sessionProvider: "sessionProvider",
  sessionDeps: "sessionDeps",
  gitService: "gitService",
  taskService: "taskService",
  workspaceUtils: "workspaceUtils",
  repositoryBackend: "repositoryBackend",
  taskGraphService: "taskGraphService",
  taskRoutingService: "taskRoutingService",
} as const;

export type TokenKey = keyof typeof TOKENS;
