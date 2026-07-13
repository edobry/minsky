/**
 * Domain container bootstrap for the reviewer service.
 *
 * Manages the lifecycle of the @minsky/domain container: creates it,
 * initializes it (which opens the DB connection), and exposes the resolved
 * services that background loops need (sessionProvider, taskService,
 * persistenceProvider).
 *
 * Called once at startup from server.ts (import.meta.main block), before
 * the background loops start. The container stays alive for the process
 * lifetime; there is no close() call on graceful shutdown (the DB connection
 * pool drains naturally when the process exits).
 *
 * ## Why a separate module
 *
 * Keeps the domain bootstrap concerns out of server.ts (which is already
 * large) and makes the domain service types importable by individual
 * scheduler modules without duplicating the import chain.
 *
 * @see mt#2121 — reviewer service migration from MCP-over-HTTP to domain imports
 * @see packages/domain/src/composition/domain.ts — createDomainContainer()
 */

import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SessionProviderInterface } from "@minsky/domain/session";
import type { TaskServiceInterface } from "@minsky/domain/tasks";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";

export interface DomainServices {
  container: AppContainerInterface;
  sessionProvider: SessionProviderInterface;
  taskService: TaskServiceInterface;
  persistenceProvider: BasePersistenceProvider;
}

/**
 * Boot the domain container and return resolved services.
 *
 * Calls createDomainContainer() which handles configuration initialization
 * idempotently (setupConfiguration() if not yet called). Calls
 * container.initialize() to resolve all factories and open the DB connection.
 *
 * Throws on misconfiguration (missing MINSKY_PERSISTENCE_POSTGRES_URL) or
 * DB connection failure — these are fatal at startup.
 */
export async function bootDomainContainer(): Promise<DomainServices> {
  const { createDomainContainer } = await import("@minsky/domain/composition/domain");

  const container = await createDomainContainer();
  await container.initialize();

  const sessionProvider = container.get("sessionProvider");
  const taskService = container.get("taskService");
  const persistenceProvider = container.get("persistence");

  return { container, sessionProvider, taskService, persistenceProvider };
}
