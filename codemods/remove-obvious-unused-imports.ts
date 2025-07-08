import { UnusedImportCodemod } from './utils/specialized-codemods';

/**
 * Refactored remove-obvious-unused-imports.ts using UnusedImportCodemod
 * Migrated from manual implementation to utility-based approach
 * for consistency and maintainability.
 */
export class removeobviousunusedimportsts extends UnusedImportCodemod {
  constructor() {
    super();
    this.name = 'remove-obvious-unused-imports.ts';
    this.description = 'Refactored remove-obvious-unused-imports.ts using UnusedImportCodemod';
  }

  // Any specific configuration can be added here
  // Base class handles all standard functionality
}

export default removeobviousunusedimportsts;
