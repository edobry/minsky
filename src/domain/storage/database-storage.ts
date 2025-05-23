/**
 * DatabaseStorage Interface
 *
 * This module defines the generic interface for database storage operations.
 * It's designed to be implementation-agnostic, supporting various backends
 * such as JSON files, SQLite, PostgreSQL, etc.
 *
 * T = The data entity type (e.g., TaskData, SessionRecord)
 * S = The state container type (e.g., TaskState, SessionDbState)
 */

/**
 * Result of a database read operation
 */
export interface DatabaseReadResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
}

/**
 * Result of a database write operation
 */
export interface DatabaseWriteResult {
  success: boolean;
  bytesWritten?: number;
  error?: Error;
}

/**
 * Options for querying database entities
 */
export interface DatabaseQueryOptions {
  [key: string]: any;
}

/**
 * Generic database storage interface
 *
 * T = Entity type (e.g., TaskData)
 * S = State type (e.g., TaskState containing entities array)
 */
export interface DatabaseStorage<T, S> {
  /**
   * Read the entire database state
   * @returns Promise resolving to the database state
   */
  readState(): Promise<DatabaseReadResult<S>>;

  /**
   * Write the entire database state
   * @param state The state to write
   * @returns Promise resolving to the result of the write operation
   */
  writeState(state: S): Promise<DatabaseWriteResult>;

  /**
   * Get a single entity by ID
   * @param id Entity identifier
   * @param options Query options
   * @returns Promise resolving to the entity or null if not found
   */
  getEntity(id: string, options?: DatabaseQueryOptions): Promise<T | null>;

  /**
   * Get all entities that match the query options
   * @param options Query options
   * @returns Promise resolving to array of entities
   */
  getEntities(options?: DatabaseQueryOptions): Promise<T[]>;

  /**
   * Create a new entity in the database
   * @param entity The entity to create
   * @returns Promise resolving to the created entity
   */
  createEntity(entity: T): Promise<T>;

  /**
   * Update an existing entity
   * @param id Entity identifier
   * @param updates Partial entity with updates
   * @returns Promise resolving to the updated entity or null if not found
   */
  updateEntity(id: string, updates: Partial<T>): Promise<T | null>;

  /**
   * Delete an entity by ID
   * @param id Entity identifier
   * @returns Promise resolving to true if deleted, false if not found
   */
  deleteEntity(id: string): Promise<boolean>;

  /**
   * Check if an entity exists
   * @param id Entity identifier
   * @returns Promise resolving to true if exists, false otherwise
   */
  entityExists(id: string): Promise<boolean>;

  /**
   * Get the storage location or connection info
   * @returns Storage location string
   */
  getStorageLocation(): string;

  /**
   * Initialize the storage (create if doesn't exist)
   * @returns Promise resolving to true if successful
   */
  initialize(): Promise<boolean>;
}
