import { UnusedVariableCodemod } from './utils/specialized-codemods';

/**
 * Refactored remove-unused-catch-params.ts using UnusedVariableCodemod
 * Migrated from manual implementation to utility-based approach
 * for consistency and maintainability.
 */
export class removeunusedcatchparamsts extends UnusedVariableCodemod {
  constructor() {
    super();
    this.name = 'remove-unused-catch-params.ts';
    this.description = 'Refactored remove-unused-catch-params.ts using UnusedVariableCodemod';
  }

  // Any specific configuration can be added here
  // Base class handles all standard functionality
}

export default removeunusedcatchparamsts;
