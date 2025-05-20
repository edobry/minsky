/**
 * CLI utility functions
 */

// Export the error handler and output utilities
export { handleCliError, outputResult, isDebugMode } from './error-handler.js';

// Export types from shared options
export type {
  RepoOptions,
  OutputOptions,
  TaskOptions,
  BackendOptions,
  ForceOptions,
} from './shared-options.js';

// Export functions from shared options
export {
  addRepoOptions,
  addOutputOptions,
  addTaskOptions,
  addBackendOptions,
  addForceOptions,
  normalizeRepoOptions,
  normalizeOutputOptions,
  normalizeTaskOptions,
  normalizeTaskParams,
  normalizeSessionParams,
} from './shared-options.js';
