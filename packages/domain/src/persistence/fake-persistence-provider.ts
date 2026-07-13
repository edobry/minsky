/**
 * FakePersistenceProvider — canonical test double for PersistenceProvider.
 *
 * This is the canonical example of Minsky's test-double pattern: a real
 * implementation of the typed DI interface, holding state in memory, with
 * zero external I/O. CI runs it identically to a developer laptop.
 *
 * New test doubles should follow this shape — a `FakeX` class colocated
 * with the interface `X` in the domain that owns it. Do NOT add new mock
 * factories to `src/utils/test-utils/dependencies.ts`; that file is being
 * migrated away.
 *
 * Hermetic by construction: no filesystem, no SQLite, no network access.
 *
 * @see src/utils/test-utils/dependencies.ts (deprecated)
 */

import { PersistenceProvider, type PersistenceCapabilities } from "./types";

/**
 * In-memory FakePersistenceProvider for hermetic tests.
 *
 * Extends the abstract PersistenceProvider with fully in-memory state.
 * Default capabilities have all flags set to `true`; pass a partial
 * override to the constructor to test capability-gated code paths.
 */
export class FakePersistenceProvider extends PersistenceProvider {
  readonly capabilities: PersistenceCapabilities;
  private initialized = false;

  constructor(capabilities: Partial<PersistenceCapabilities> = {}) {
    super();
    this.capabilities = {
      sql: true,
      transactions: true,
      jsonb: true,
      vectorStorage: true,
      migrations: true,
      ...capabilities,
    };
  }

  getCapabilities(): PersistenceCapabilities {
    return this.capabilities;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  getConnectionInfo(): string {
    return "fake://in-memory";
  }
}
