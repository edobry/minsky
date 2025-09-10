/**
 * JSON File Persistence Provider
 *
 * Provides full file-based JSON storage through the persistence provider interface.
 */

import {
  PersistenceProvider,
  PersistenceCapabilities,
  PersistenceConfig,
  DatabaseStorage,
  CapabilityNotSupportedError,
} from "../types";
import type { VectorStorage } from "../../storage/vector/types";
import { JsonFileStorage } from "../../storage/json-file-storage";
import type { JsonFileStorageOptions } from "../../storage/json-file-storage";
import { log } from "../../../utils/logger";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

/**
 * JSON persistence provider implementation
 */
export class JsonPersistenceProvider extends PersistenceProvider {
  private config: PersistenceConfig;
  private storage: JsonFileStorage<any, any> | null = null;
  private isInitialized = false;

  /**
   * Capabilities of JSON provider
   */
  readonly capabilities: PersistenceCapabilities = {
    sql: false,
    transactions: false,
    jsonb: false,
    vectorStorage: false,
    migrations: false,
  };

  constructor(config: PersistenceConfig) {
    super();
    if (config.backend !== "json" || !config.json) {
      throw new Error("JsonPersistenceProvider requires json configuration");
    }
    this.config = config;
  }

  /**
   * Initialize JSON file storage
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      if (!this.config.json) {
        throw new Error("JSON configuration required for json backend");
      }

      const filePath = this.config.json.filePath;
      log.debug(`Initializing JSON persistence provider at ${filePath}`);

      // Ensure directory exists
      const fileDir = dirname(filePath);
      if (!existsSync(fileDir)) {
        mkdirSync(fileDir, { recursive: true });
      }

      // Create storage instance with session-compatible configuration
      const storageOptions: JsonFileStorageOptions<any> = {
        filePath,
        initializeState: () => ({ sessions: [] }),
        entitiesField: "sessions",
        idField: "session",
        prettyPrint: true,
      };

      this.storage = new JsonFileStorage(storageOptions);
      await this.storage.initialize();

      this.isInitialized = true;
      log.info(`JSON file storage initialized: ${filePath}`);
    } catch (error) {
      log.error("Failed to initialize JSON provider:", error);
      throw error;
    }
  }

  /**
   * Get provider capabilities
   */
  getCapabilities(): PersistenceCapabilities {
    return this.capabilities;
  }

  /**
   * Get storage instance for domain entities
   */
  getStorage<T, S>(): DatabaseStorage<T, S> {
    if (!this.storage) {
      throw new Error("JsonPersistenceProvider not initialized");
    }
    return this.storage as DatabaseStorage<T, S>;
  }

  /**
   * Vector storage not supported by JSON provider
   */
  getVectorStorage(dimension: number): VectorStorage | null {
    throw new CapabilityNotSupportedError("vectorStorage", "JSON");
  }

  /**
   * No database connection for JSON provider
   */
  async getDatabaseConnection(): Promise<null> {
    return null;
  }

  /**
   * No raw SQL connection for JSON provider
   */
  async getRawSqlConnection(): Promise<null> {
    return null;
  }

  /**
   * Close (save) JSON file
   */
  async close(): Promise<void> {
    if (this.storage) {
      await this.storage.close();
      this.storage = null;
    }
    this.isInitialized = false;
    log.debug("JSON persistence provider closed");
  }

  /**
   * Get connection information
   */
  getConnectionInfo(): string {
    if (!this.config.json) {
      return "JSON: Not configured";
    }

    return `JSON: ${this.config.json.filePath} (${this.isInitialized ? "loaded" : "not loaded"})`;
  }
}
