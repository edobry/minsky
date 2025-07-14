/**
 * Test Configuration Manager for Node-Config Integration
 *
 * Handles configuration overrides for testing while integrating with node-config.
 * Provides a way to override configuration values during testing without 
 * affecting the main configuration system.
 */

import config from "config";

export interface TestConfigOverrides {
  backend?: string;
  backendConfig?: any;
  detectionRules?: any[];
  sessiondb?: any;
  ai?: any;
  github?: any;
  logger?: any;
}

export interface TestConfigManager {
  withOverrides<T>(overrides: TestConfigOverrides, testFn: () => T): T;
  withOverridesAsync<T>(overrides: TestConfigOverrides, testFn: () => Promise<T>): Promise<T>;
  getConfigValue(path: string): any;
  setConfigValue(path: string, value: any): void;
  resetConfig(): void;
}

export class DefaultTestConfigManager implements TestConfigManager {
  private originalValues: Map<string, any> = new Map();
  private overrideActive: boolean = false;

  /**
   * Execute a test function with configuration overrides
   */
  withOverrides<T>(overrides: TestConfigOverrides, testFn: () => T): T {
    this.applyOverrides(overrides);
    try {
      return testFn();
    } finally {
      this.resetConfig();
    }
  }

  /**
   * Execute an async test function with configuration overrides
   */
  async withOverridesAsync<T>(overrides: TestConfigOverrides, testFn: () => Promise<T>): Promise<T> {
    this.applyOverrides(overrides);
    try {
      return await testFn();
    } finally {
      this.resetConfig();
    }
  }

  /**
   * Get a configuration value (with override support)
   */
  getConfigValue(path: string): any {
    try {
      return config.get(path);
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Set a configuration value for testing
   */
  setConfigValue(path: string, value: any): void {
    // Store original value if not already stored
    if (!this.originalValues.has(path)) {
      try {
        this.originalValues.set(path, config.get(path));
      } catch (error) {
        // Path doesn't exist, store undefined
        this.originalValues.set(path, undefined);
      }
    }

    // Set the override value
    this.setNestedValue(config as any, path, value);
  }

  /**
   * Reset all configuration overrides
   */
  resetConfig(): void {
    if (!this.overrideActive) {
      return;
    }

    // Restore original values
    for (const [path, originalValue] of this.originalValues) {
      if (originalValue === undefined) {
        this.deleteNestedValue(config as any, path);
      } else {
        this.setNestedValue(config as any, path, originalValue);
      }
    }

    this.originalValues.clear();
    this.overrideActive = false;
  }

  /**
   * Apply configuration overrides
   */
  private applyOverrides(overrides: TestConfigOverrides): void {
    this.overrideActive = true;

    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        this.setConfigValue(key, value);
      }
    }
  }

  /**
   * Set a nested value in an object using dot notation
   */
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split(".");
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (key && (!(key in current) || typeof current[key] !== "object")) {
        current[key] = {};
      }
      if (key) {
        current = current[key];
      }
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey) {
      current[lastKey] = value;
    }
  }

  /**
   * Delete a nested value in an object using dot notation
   */
  private deleteNestedValue(obj: any, path: string): void {
    const keys = path.split(".");
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!key || !(key in current) || typeof current[key] !== "object") {
        return; // Path doesn't exist
      }
      current = current[key];
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey) {
      delete current[lastKey];
    }
  }
}

// Export singleton instance
export const testConfigManager = new DefaultTestConfigManager();

/**
 * Utility function for testing with configuration overrides
 */
export function withTestConfig<T>(overrides: TestConfigOverrides, testFn: () => T): T {
  return testConfigManager.withOverrides(overrides, testFn);
}

/**
 * Utility function for async testing with configuration overrides
 */
export async function withTestConfigAsync<T>(overrides: TestConfigOverrides, testFn: () => Promise<T>): Promise<T> {
  return testConfigManager.withOverridesAsync(overrides, testFn);
} 
