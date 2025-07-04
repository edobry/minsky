/**
 * JsonFileStorage Implementation
 *
 * This module implements the DatabaseStorage interface for JSON files.
 * It provides a generic storage mechanism for any data type that can be
 * serialized to JSON.
 */
import { dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { log } from "../../utils/logger";
import type {
  DatabaseReadResult,
  DatabaseWriteResult,
  DatabaseQueryOptions,
} from "./database-storage";
import type { DatabaseStorage } from "./database-storage";
import { getErrorMessage } from "../../errors/index";
/**
 * Configuration options for JsonFileStorage
 */
export interface JsonFileStorageOptions<S> {
  /**
   * Path to the JSON file
   */
  filePath: string;

  /**
   * Function to initialize empty state
   */
  initializeState: () => S;

  /**
   * Entity ID field name (default: "id")
   */
  idField?: string;

  /**
   * Name of the array property in the state that contains entities
   */
  entitiesField: string;

  /**
   * Pretty print JSON (default: true)
   */
  prettyPrint?: boolean;
}

// Simple file lock implementation to prevent concurrent access
class FileOperationLock {
  private static locks = new Map<string, Promise<any>>();

  static async withLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    // If there's already a lock for this file, wait for it
    while (this.locks.has(filePath)) {
      await this.locks.get(filePath);
    }

    // Set our operation as the current lock
    const operationPromise = operation();
    this.locks.set(filePath, operationPromise);

    try {
      const result = await operationPromise;
      return result;
    } finally {
      // Remove our lock only if it's still the current one
      if (this.locks.get(filePath) === operationPromise) {
        this.locks.delete(filePath);
      }
    }
  }
}

/**
 * JSON file storage implementation of DatabaseStorage
 */
export class JsonFileStorage<T, S> implements DatabaseStorage<T, S> {
  private readonly filePath: string;
  private readonly initializeState: () => S;
  private readonly idField: string;
  private readonly entitiesField: string;
  private readonly prettyPrint: boolean;

  /**
   * Create a new JsonFileStorage instance
   * @param options Configuration options
   */
  constructor(options: JsonFileStorageOptions<S>) {
    this.filePath = options.filePath;
    this.initializeState = options.initializeState;
    this.idField = options.idField || "id";
    this.entitiesField = options.entitiesField;
    this.prettyPrint = options.prettyPrint !== false;
  }

  /**
   * Read the entire database state
   * @returns Promise resolving to the database state
   */
  async readState(): Promise<DatabaseReadResult<S>> {
    try {
      if (!existsSync(this.filePath)) {
        // Return initialized state if file doesn't exist
        const state = this.initializeState();
        return { success: true, data: state };
      }

      const data = readFileSync(this.filePath, "utf8");
      const dataStr = typeof data === "string" ? data : String(data);

      // Validate JSON before parsing to prevent stack overflow
      if (!(dataStr).toString().trim()) {
        // Handle empty file
        const state = this.initializeState();
        return { success: true, data: state };
      }

      // Add safeguards against circular references
      try {
        const state = JSON.parse(dataStr) as S;

        // Validate the parsed state structure
        if (typeof state !== "object" || state === null) {
          log.warn("Invalid state structure, reinitializing");
          const newState = this.initializeState();
          return { success: true, data: newState };
        }

        return { success: true, data: state };
      } catch (error) {
        log.error("JSON parse error, reinitializing state:", { error });
        const state = this.initializeState();
        return { success: true, data: state };
      }
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.error(`Error reading database file ${this.filePath}: ${typedError.message}`);
      return {
        success: false,
        error: typedError,
      };
    }
  }

  /**
   * Write the entire database state
   * @param state The state to write
   * @returns Promise resolving to the result of the write operation
   */
  async writeState(state: S): Promise<DatabaseWriteResult> {
    try {
      // Ensure directory exists
      this.ensureDirectory();

      // Validate state before serialization to prevent circular references
      if (state === null || state === undefined) {
        throw new Error("Cannot serialize null or undefined state");
      }

      // Serialize state to JSON with error handling for circular references
      let json: string;
      try {
        json = this.prettyPrint ? JSON.stringify(state, null, 2) : JSON.stringify(state);
      } catch (serializationError) {
        if (
          serializationError instanceof Error &&
          serializationError.message.includes("circular")
        ) {
          throw new Error("Cannot serialize state: circular reference detected");
        }
        throw serializationError;
      }

      // Write to file
      writeFileSync(this.filePath, json, "utf8");

      return {
        success: true,
        bytesWritten: json.length,
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.error(`Error writing database file ${this.filePath}: ${typedError.message}`);
      return {
        success: false,
        error: typedError,
      };
    }
  }

  /**
   * Get a single entity by ID
   * @param id Entity identifier
   * @param options Query options
   * @returns Promise resolving to the entity or null if not found
   */
  async getEntity(id: string, options?: DatabaseQueryOptions): Promise<T | null> {
    const result = await this.readState();
    if (!result.success || !result.data) {
      return null as any;
    }

    const state = result.data;
    const entities = this.getEntitiesFromState(state);
    const entity = entities.find((e) => (e as any)[this.idField] === id);

    return entity || null;
  }

  /**
   * Get all entities that match the query options
   * @param options Query options
   * @returns Promise resolving to array of entities
   */
  async getEntities(options?: DatabaseQueryOptions): Promise<T[]> {
    const result = await this.readState();
    if (!result.success || !result.data) {
      return [];
    }

    const state = result.data;
    const entities = this.getEntitiesFromState(state);

    if (!options) {
      return entities;
    }

    // Filter entities based on query options
    return entities.filter((entity) => {
      for (const [key, value] of Object.entries(options)) {
        if ((entity as any)[key] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Create a new entity in the database
   * @param entity The entity to create
   * @returns Promise resolving to the created entity
   */
  async createEntity(entity: T): Promise<T> {
    return FileOperationLock.withLock(this.filePath, async () => {
      const result = await this.readState();
      if (!result.success) {
        throw new Error(
          `Failed to read database state: ${result.error?.message || "Unknown error"}`
        );
      }

      const state = result.data || this.initializeState();
      const entities = this.getEntitiesFromState(state);

      // Check if entity with this ID already exists
      const id = (entity as any)[this.idField];
      if (id && entities.some((e) => (e as any)[this.idField] === id)) {
        throw new Error(`Entity with ID ${id} already exists`);
      }

      // Add entity to collection
      entities.push(entity);

      // Update state with new entities collection
      this.setEntitiesInState(state, entities);

      // Write updated state
      const writeResult = await this.writeState(state);
      if (!writeResult.success) {
        throw writeResult.error || new Error("Failed to write database state");
      }

      return entity;
    });
  }

  /**
   * Update an existing entity
   * @param id Entity identifier
   * @param updates Partial entity with updates
   * @returns Promise resolving to the updated entity or null if not found
   */
  async updateEntity(id: string, updates: Partial<T>): Promise<T | null> {
    return FileOperationLock.withLock(this.filePath, async () => {
      const result = await this.readState();
      if (!result.success) {
        throw new Error(
          `Failed to read database state: ${result.error?.message || "Unknown error"}`
        );
      }

      const state = result.data || this.initializeState();
      const entities = this.getEntitiesFromState(state);

      // Find entity index
      const index = entities.findIndex((e) => (e as any)[this.idField] === id);
      if (index === -1) {
        return null as any;
      }

      // Update entity
      const updatedEntity = { ...entities[index], ...updates } as T;
      entities[index] = updatedEntity;

      // Update state with modified entities collection
      this.setEntitiesInState(state, entities);

      // Write updated state
      const writeResult = await this.writeState(state);
      if (!writeResult.success) {
        throw writeResult.error || new Error("Failed to write database state");
      }

      return updatedEntity;
    });
  }

  /**
   * Delete an entity by ID
   * @param id Entity identifier
   * @returns Promise resolving to true if deleted, false if not found
   */
  async deleteEntity(id: string): Promise<boolean> {
    return FileOperationLock.withLock(this.filePath, async () => {
      const result = await this.readState();
      if (!result.success) {
        throw new Error(
          `Failed to read database state: ${result.error?.message || "Unknown error"}`
        );
      }

      const state = result.data || this.initializeState();
      const entities = this.getEntitiesFromState(state);

      // Find entity index
      const index = entities.findIndex((e) => (e as any)[this.idField] === id);
      if (index === -1) {
        return false;
      }

      // Remove entity
      entities.splice(index, 1);

      // Update state with modified entities collection
      this.setEntitiesInState(state, entities);

      // Write updated state
      const writeResult = await this.writeState(state);
      if (!writeResult.success) {
        throw writeResult.error || new Error("Failed to write database state");
      }

      return true;
    });
  }

  /**
   * Check if an entity exists
   * @param id Entity identifier
   * @returns Promise resolving to true if exists, false otherwise
   */
  async entityExists(id: string): Promise<boolean> {
    const entity = await this.getEntity(id);
    return entity !== null;
  }

  /**
   * Get the storage file path
   * @returns The file path
   */
  getStorageLocation(): string {
    return this.filePath;
  }

  /**
   * Initialize the storage (create file if it doesn't exist)
   * @returns Promise resolving to true if successful
   */
  async initialize(): Promise<boolean> {
    try {
      // Ensure directory exists
      this.ensureDirectory();

      // If file doesn't exist, create it with initial state
      if (!existsSync(this.filePath)) {
        const state = this.initializeState();
        const writeResult = await this.writeState(state);
        return writeResult.success;
      }

      return true;
    } catch (error) {
      log.error(
        `Error initializing storage: ${getErrorMessage(error)}`
      );
      return false;
    }
  }

  /**
   * Helper method to ensure directory exists
   * @private
   */
  private ensureDirectory(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Helper method to get entities array from state
   * @param state Database state
   * @returns Array of entities
   * @private
   */
  private getEntitiesFromState(state: S): T[] {
    return (state as any)[this.entitiesField] || [];
  }

  /**
   * Helper method to set entities array in state
   * @param state Database state
   * @param entities Array of entities
   * @private
   */
  private setEntitiesInState(state: S, entities: T[]): void {
    (state as any)[this.entitiesField] = entities;
  }
}

/**
 * Create a new JsonFileStorage instance
 * @param options Configuration options
 * @returns JsonFileStorage instance
 */
export function createJsonFileStorage<T, S>(
  options: JsonFileStorageOptions<S>
): DatabaseStorage<T, S> {
  return new JsonFileStorage<T, S>(options);
}
