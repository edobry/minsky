/**
 * Configuration System Tests
 *
 * Tests for the custom type-safe configuration system.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type {
  ConfigurationProvider,
  ConfigurationFactory,
  ConfigurationOverrides,
} from "./index";
import {
  CustomConfigFactory,
  createTestProvider,
  initializeConfiguration,
  getConfiguration,
  get,
  has,
} from "./index";

describe("Custom Configuration System", () => {
  let provider: ConfigurationProvider;

  beforeEach(async () => {
    provider = await createTestProvider({});
  });

  afterEach(() => {
    // Reset global configuration state if needed
  });

  describe("CustomConfigurationProvider", () => {
    test("should implement getConfig() method", () => {
      const config = provider.getConfig();
      expect(config).toBeDefined();
      expect(config.backend).toBeDefined();
      expect(config.sessiondb).toBeDefined();
    });

    test("should implement get() method with path access", () => {
      expect(provider.get("backend")).toBeDefined();
      expect(provider.get("sessiondb.backend")).toBeDefined();
    });

    test("should implement has() method for path checking", () => {
      expect(provider.has("backend")).toBe(true);
      expect(provider.has("sessiondb.backend")).toBe(true);
      expect(provider.has("nonexistent.path")).toBe(false);
    });

    test("should implement reload() method", async () => {
      await expect(provider.reload()).resolves.toBeUndefined();
    });

    test("should implement getMetadata() method", () => {
      const metadata = provider.getMetadata();
      expect(metadata).toBeDefined();
      expect(metadata.sources).toBeDefined();
      expect(metadata.version).toBe("custom");
    });

    test("should implement validate() method", () => {
      const result = provider.validate();
      expect(result).toBeDefined();
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test("should provide consistent configuration structure", () => {
      const config = provider.getConfig();

      // Check required fields exist
      expect(config.backend).toBeDefined();
      expect(config.sessiondb).toBeDefined();
      expect(config.github).toBeDefined();
      expect(config.ai).toBeDefined();
    });

    test("should handle configuration overrides consistently", () => {
      const config = provider.getConfig();
      expect(config.backend).toBe("json-file"); // From overrides
      expect(config.sessiondb.backend).toBe("sqlite"); // From overrides
      expect(config.sessiondb.dbPath).toBe("/tmp/test.db"); // From overrides
    });
  });

  describe("Configuration Initialization", () => {
    test("should initialize with custom factory", async () => {
      const factory = new CustomConfigFactory();
      await expect(initializeConfiguration(factory)).resolves.toBeUndefined();

      // Test global access
      const config = getConfiguration();
      expect(config).toBeDefined();
      expect(get("backend")).toBeDefined();
      expect(has("backend")).toBe(true);
    });

    test("should support configuration overrides", async () => {
      const factory = new CustomConfigFactory();
      await initializeConfiguration(factory, {
        overrides: { backend: "custom-override" }
      });

      const config = getConfiguration();
      expect(config.backend).toBe("custom-override");
    });
  });

  describe("Performance", () => {
    test("should load configuration within acceptable time limits", async () => {
      const startTime = Date.now();
      const provider = await createTestProvider({});
      const endTime = Date.now();

      const loadTime = endTime - startTime;
      console.log(`Custom config load time: ${loadTime}ms`);

      // Should load quickly (less than 1 second)
      expect(loadTime).toBeLessThan(1000);
    });

    test("should access configuration values efficiently", () => {
      const iterations = 1000;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        provider.get("backend");
        provider.get("sessiondb.backend");
        provider.has("github.token");
      }

      const endTime = Date.now();
      const totalTime = endTime - startTime;
      const avgTime = totalTime / iterations;

      console.log(`Average access time: ${avgTime.toFixed(3)}ms per operation`);

      // Should be very fast (less than 1ms per operation on average)
      expect(avgTime).toBeLessThan(1);
    });
  });

  describe("Error Handling", () => {
    test("should handle missing configuration paths gracefully", () => {
      expect(() => provider.get("nonexistent.path")).toThrow(/not found/);
    });

    test("should validate configuration structure", () => {
      const result = provider.validate();
      expect(result.valid).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  describe("Configuration Factory", () => {
    test("should create provider with default options", async () => {
      const factory = new CustomConfigFactory();
      const provider = await factory.createProvider();

      expect(provider).toBeDefined();
      expect(provider.getConfig).toBeDefined();
      expect(provider.get).toBeDefined();
      expect(provider.has).toBeDefined();
    });

    test("should create provider with custom options", async () => {
      const factory = new CustomConfigFactory();
      const provider = await factory.createProvider({
        overrides: { backend: "test-backend" },
        enableCache: false
      });

      const config = provider.getConfig();
      expect(config.backend).toBe("test-backend");
    });
  });
});
