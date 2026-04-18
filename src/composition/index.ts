/**
 * Composition Root Module
 *
 * Exports the DI container and types. Composition roots (CLI, MCP, test)
 * import from here to build service graphs.
 *
 * Domain code should NEVER import from this module.
 */

export { AppContainer } from "./container";
export { createCliContainer } from "./cli";
export { createTestContainer } from "./test";
export type {
  AppServices,
  ServiceKey,
  ServiceFactory,
  RegisterOptions,
  AppContainerInterface,
} from "./types";
