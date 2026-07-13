/**
 * Composition Root Module
 *
 * Exports the DI container and types. Composition roots (CLI, MCP, test)
 * import from here to build service graphs.
 *
 * Domain code should NEVER import from this module.
 */

export { TsyringeContainer } from "@minsky/domain/composition/container";
export { TOKENS } from "./tokens";
export { createCliContainer } from "./cli";
export { createDomainContainer } from "@minsky/domain/composition/domain";
export { createTestContainer } from "@minsky/domain/composition/test";
export type {
  AppServices,
  ServiceKey,
  ServiceFactory,
  RegisterOptions,
  AppContainerInterface,
} from "@minsky/domain/composition/types";
