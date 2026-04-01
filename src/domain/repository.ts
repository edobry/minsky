/**
 * Repository module barrel re-export.
 *
 * All types, interfaces, and functions that were previously defined inline
 * have been moved to sub-modules under ./repository/.
 */
export * from "./repository/legacy-types";
export * from "./repository/resolution";
export { createRepositoryBackend } from "./repository/legacy-backend-factory";
