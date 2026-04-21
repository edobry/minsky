/**
 * DI Container Types
 *
 * Defines the service map (AppServices) and factory types for the typed
 * DI container. All imports are type-only — this module has zero runtime cost.
 *
 * Design decision: AppServices uses an interface with keyof for compile-time
 * type safety on container.get()/register(). Domain code never sees this
 * interface — it only sees the individual service interfaces via typed deps.
 *
 * @see mt#761 spec, "Container design" section
 */

import type { BasePersistenceProvider } from "../domain/persistence/types";
import type { SessionProviderInterface } from "../domain/session/types";
import type { SessionDeps } from "../domain/session/session-service";
import type { GitServiceInterface } from "../domain/git/types";
import type { TaskServiceInterface } from "../domain/tasks/taskService";
import type { WorkspaceUtilsInterface } from "../domain/workspace";
import type { RepositoryBackendType } from "../domain/repository";
import type { TaskGraphService } from "../domain/tasks/task-graph-service";
import type { TaskRoutingService } from "../domain/tasks/task-routing-service";

/**
 * The complete set of services managed by the DI container.
 *
 * Each key maps to a typed service interface. Composition roots register
 * factories for these services; domain code receives them via typed deps
 * interfaces (SessionDeps, StartSessionDependencies, etc.) — never via
 * the container directly.
 */
export interface AppServices {
  /** Persistence provider — async init (DB connection). Resolved first. */
  persistence: BasePersistenceProvider;

  /** Session provider — depends on persistence. */
  sessionProvider: SessionProviderInterface;

  /** Pre-wired session deps bundle — depends on sessionProvider + other services. */
  sessionDeps: SessionDeps;

  /** Git operations service. */
  gitService: GitServiceInterface;

  /** Task CRUD and query service. */
  taskService: TaskServiceInterface;

  /** Workspace detection and path utilities. */
  workspaceUtils: WorkspaceUtilsInterface;

  /** Repository backend configuration (from project config). */
  repositoryBackend: {
    repoUrl: string;
    backendType: RepositoryBackendType;
    github?: { owner: string; repo: string };
  };

  /** Task dependency graph operations (SQL-backed). */
  taskGraphService: TaskGraphService;

  /** Task routing and availability scoring. */
  taskRoutingService: TaskRoutingService;
}

/** A service key — one of the keys of AppServices. */
export type ServiceKey = keyof AppServices;

/**
 * Factory function that creates a service instance.
 * May be sync or async — the container handles both uniformly via Promise.resolve().
 * The factory receives the container so it can resolve dependencies.
 */
export type ServiceFactory<T> = (container: AppContainerInterface) => T | Promise<T>;

/**
 * Options for service registration.
 */
export interface RegisterOptions<T> {
  /** Called during container.close() to clean up resources (e.g., close DB connections). */
  dispose?: (instance: T) => Promise<void>;
}

/**
 * The public container interface.
 * Used in composition roots — domain code never sees this.
 */
export interface AppContainerInterface {
  /** Register a factory for a service key. Returns `this` for chaining. */
  register<K extends ServiceKey>(
    key: K,
    factory: ServiceFactory<AppServices[K]>,
    options?: RegisterOptions<AppServices[K]>
  ): this;

  /** Directly set a service instance (for tests or pre-resolved values). Returns `this` for chaining. */
  set<K extends ServiceKey>(key: K, instance: AppServices[K]): this;

  /** Get a resolved service instance. Throws if not available. */
  get<K extends ServiceKey>(key: K): AppServices[K];

  /** Check if a service has been resolved (set or initialized). */
  has<K extends ServiceKey>(key: K): boolean;

  /**
   * Initialize all registered factories in registration order.
   * Each factory may call container.get() to access previously resolved services.
   * Skips services already set via set().
   * Async factories are awaited.
   */
  initialize(): Promise<void>;

  /**
   * Dispose all services with registered disposers, then clear all instances.
   * Called during application shutdown (e.g., CLI exit, MCP server stop).
   */
  close(): Promise<void>;
}
