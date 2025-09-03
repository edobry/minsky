/**
 * JSON Persistence Provider
 *
 * File-based storage provider for simple use cases.
 */

import { promises as fs } from "fs";
import path from "path";
import { 
  PersistenceProvider, 
  PersistenceCapabilities, 
  PersistenceConfig,
  DatabaseStorage,
  VectorStorage,
  CapabilityNotSupportedError
} from "../types";
import { log } from "../../../utils/logger";

/**
 * JSON persistence provider implementation
 */
export class JsonPersistenceProvider extends PersistenceProvider {
  private config: PersistenceConfig;
  private isInitialized = false;
  private data: Record<string, any> = {};

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
    if (config.backend !== 'json' || !config.json) {
      throw new Error('JsonPersistenceProvider requires json configuration');
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

    const filePath = this.config.json!.filePath;
    
    try {
      log.debug(`Initializing JSON persistence provider at ${filePath}`);
      
      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      
      // Load existing data or create empty file
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        this.data = JSON.parse(content);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // File doesn't exist, create it
          await this.saveData();
        } else {
          throw error;
        }
      }
      
      this.isInitialized = true;
      log.debug("JSON persistence provider initialized");
    } catch (error) {
      log.error("Failed to initialize JSON provider:", error);
      throw error;
    }
  }

  /**
   * Save data to file
   */
  private async saveData(): Promise<void> {
    const filePath = this.config.json!.filePath;
    await fs.writeFile(filePath, JSON.stringify(this.data, null, 2));
  }

  /**
   * Get storage instance for domain entities
   */
  getStorage<T, S>(): DatabaseStorage<T, S> {
    if (!this.isInitialized) {
      throw new Error('JsonPersistenceProvider not initialized');
    }

    return {
      get: async (id: string) => {
        return this.data[id] as T || null;
      },
      save: async (id: string, data: T) => {
        this.data[id] = data;
        await this.saveData();
      },
      update: async (id: string, updates: Partial<T>) => {
        if (this.data[id]) {
          this.data[id] = { ...this.data[id], ...updates };
          await this.saveData();
        }
      },
      delete: async (id: string) => {
        delete this.data[id];
        await this.saveData();
      },
      search: async (criteria: S) => {
        // Simple search - return all values
        // In practice, would implement filtering based on criteria
        return Object.values(this.data) as T[];
      },
    };
  }

  /**
   * Vector storage not supported by JSON provider
   */
  async getVectorStorage(dimension: number): Promise<VectorStorage | null> {
    throw new CapabilityNotSupportedError('vectorStorage', 'JSON');
  }

  /**
   * No database connection for JSON provider
   */
  async getDatabaseConnection(): Promise<null> {
    return null;
  }

  /**
   * Close (save) JSON file
   */
  async close(): Promise<void> {
    if (this.isInitialized) {
      await this.saveData();
      this.isInitialized = false;
      log.debug("JSON persistence provider closed");
    }
  }

  /**
   * Get connection information
   */
  getConnectionInfo(): string {
    if (!this.config.json) {
      return "JSON: Not configured";
    }

    return `JSON: ${this.config.json.filePath} (${this.isInitialized ? 'loaded' : 'not loaded'})`;
  }
}
