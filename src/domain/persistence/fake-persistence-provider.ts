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

import type {
  DatabaseStorage,
  DatabaseReadResult,
  DatabaseWriteResult,
  DatabaseQueryOptions,
} from "../storage/database-storage";
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
  private readonly storage = new InMemoryDatabaseStorage<unknown, unknown>();
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

  getStorage<T, S>(): DatabaseStorage<T, S> {
    return this.storage as DatabaseStorage<T, S>;
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

class InMemoryDatabaseStorage<T, S> implements DatabaseStorage<T, S> {
  private readonly entities = new Map<string, T>();
  private state: S | null = null;
  private nextId = 1;

  async readState(): Promise<DatabaseReadResult<S>> {
    return this.state !== null ? { success: true, data: this.state } : { success: true };
  }

  async writeState(state: S): Promise<DatabaseWriteResult> {
    this.state = state;
    return { success: true, bytesWritten: 0 };
  }

  async getEntity(id: string, _options?: DatabaseQueryOptions): Promise<T | null> {
    return this.entities.get(id) ?? null;
  }

  async getEntities(_options?: DatabaseQueryOptions): Promise<T[]> {
    return Array.from(this.entities.values());
  }

  async createEntity(entity: T): Promise<T> {
    const id = `fake-${this.nextId++}`;
    this.entities.set(id, entity);
    return entity;
  }

  async updateEntity(id: string, updates: Partial<T>): Promise<T | null> {
    const existing = this.entities.get(id);
    if (existing === undefined) return null;
    const updated = { ...(existing as object), ...(updates as object) } as T;
    this.entities.set(id, updated);
    return updated;
  }

  async deleteEntity(id: string): Promise<boolean> {
    return this.entities.delete(id);
  }

  async entityExists(id: string): Promise<boolean> {
    return this.entities.has(id);
  }

  getStorageLocation(): string {
    return "fake://in-memory";
  }

  async initialize(): Promise<boolean> {
    return true;
  }
}
