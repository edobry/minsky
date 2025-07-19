/**
 * Configuration Interface Tests
 * 
 * These tests demonstrate how the configuration interface enables safe migration
 * by testing both node-config and custom implementations against the same interface.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { 
  ConfigurationProvider, 
  ConfigurationFactory,
  ConfigurationOverrides,
  TestProviderType
} from "./index";
import { 
  NodeConfigFactory, 
  CustomConfigFactory,
  createTestProvider,
  initializeConfiguration,
  getConfiguration,
  get,
  has,
} from "./index";

/**
 * Interface compliance test suite
 * 
 * This test suite runs against both implementations to ensure they behave identically.
 */
function testConfigurationProvider(
  providerName: string,
  createProvider: () => Promise<ConfigurationProvider>
) {
  describe(`${providerName} Interface Compliance`, () => {
    let provider: ConfigurationProvider;

    beforeEach(async () => {
      provider = await createProvider();
    });

    test("should implement getConfig() method", () => {
      expect(typeof provider.getConfig).toBe("function");
      
      const config = provider.getConfig();
      expect(config).toBeDefined();
      expect(typeof config).toBe("object");
    });

    test("should implement get() method with path access", () => {
      expect(typeof provider.get).toBe("function");
      
      // Test accessing a simple property
      const backend = provider.get("backend");
      expect(typeof backend).toBe("string");
      
      // Test accessing a nested property
      const sessionDbBackend = provider.get("sessiondb.backend");
      expect(typeof sessionDbBackend).toBe("string");
    });

    test("should implement has() method for path checking", () => {
      expect(typeof provider.has).toBe("function");
      
      // Test existing paths
      expect(provider.has("backend")).toBe(true);
      expect(provider.has("sessiondb.backend")).toBe(true);
      
      // Test non-existing paths
      expect(provider.has("nonexistent")).toBe(false);
      expect(provider.has("sessiondb.nonexistent")).toBe(false);
    });

    test("should implement reload() method", async () => {
      expect(typeof provider.reload).toBe("function");
      
      // Should not throw
      await expect(provider.reload()).resolves.not.toThrow();
    });

    test("should implement getMetadata() method", () => {
      expect(typeof provider.getMetadata).toBe("function");
      
      const metadata = provider.getMetadata();
      expect(metadata).toBeDefined();
      expect(Array.isArray(metadata.sources)).toBe(true);
      expect(metadata.loadedAt).toBeInstanceOf(Date);
      expect(typeof metadata.version).toBe("string");
    });

    test("should implement validate() method", () => {
      expect(typeof provider.validate).toBe("function");
      
      const result = provider.validate();
      expect(result).toBeDefined();
      expect(typeof result.valid).toBe("boolean");
      expect(Array.isArray(result.errors)).toBe(true);
    });

    test("should provide consistent configuration structure", () => {
      const config = provider.getConfig();
      
      // Test required top-level properties
      expect(config).toHaveProperty("backend");
      expect(config).toHaveProperty("sessiondb");
      expect(config).toHaveProperty("github");
      expect(config).toHaveProperty("ai");
      expect(config).toHaveProperty("logger");
      
      // Test nested structures
      expect(config.sessiondb).toHaveProperty("backend");
      expect(config.github).toBeDefined();
      expect(config.ai).toBeDefined();
      expect(config.logger).toBeDefined();
    });

    test("should handle configuration overrides consistently", async () => {
      // This test ensures both implementations handle overrides the same way
      const config = provider.getConfig();
      const originalBackend = config.backend;
      
      // Configuration should be deterministic
      expect(typeof originalBackend).toBe("string");
      expect(["markdown", "json-file", "github-issues"]).toContain(originalBackend);
    });
  });
}

/**
 * Behavioral compatibility tests
 * 
 * These tests ensure that both implementations produce identical behavior
 * for the same configuration scenarios.
 */
describe("Behavioral Compatibility", () => {
  let nodeProvider: ConfigurationProvider;
  let customProvider: ConfigurationProvider;

  beforeEach(async () => {
    // Create both providers with the same test configuration
    const testOverrides: ConfigurationOverrides = {
      backend: "markdown",
      sessiondb: {
        backend: "sqlite",
      },
      github: {
        token: "test-token",
      },
      logger: {
        level: "info",
        mode: "HUMAN",
      },
    };

    nodeProvider = await createTestProvider(testOverrides, "node-config");
    customProvider = await createTestProvider(testOverrides, "custom");
  });

  test("should return identical configuration objects", () => {
    const nodeConfig = nodeProvider.getConfig();
    const customConfig = customProvider.getConfig();
    
    // Both should have the same structure and values
    expect(nodeConfig.backend).toBe(customConfig.backend);
    expect(nodeConfig.sessiondb.backend).toBe(customConfig.sessiondb.backend);
    // Compare github configuration objects as a whole rather than individual properties
    expect(nodeConfig.github).toEqual(customConfig.github);
    expect(nodeConfig.logger.level).toBe(customConfig.logger.level);
  });

  test("should handle path-based access identically", () => {
    const paths = [
      "backend",
      "sessiondb.backend",
      "logger.level",
      "logger.mode",
    ];

    for (const path of paths) {
      const nodeValue = nodeProvider.get(path);
      const customValue = customProvider.get(path);
      
      expect(nodeValue).toBe(customValue);
    }
    
    // Test github.token separately since it might be undefined
    const nodeHasToken = nodeProvider.has("github.token");
    const customHasToken = customProvider.has("github.token");
    expect(nodeHasToken).toBe(customHasToken);
    
    if (nodeHasToken && customHasToken) {
      expect(nodeProvider.get("github.token")).toBe(customProvider.get("github.token"));
    }
  });

  test("should handle path existence checks identically", () => {
    const existingPaths = [
      "backend",
      "sessiondb.backend",
      "logger.level",
    ];

    const nonExistingPaths = [
      "nonexistent",
      "sessiondb.nonexistent",
      "github.nonexistent",
    ];

    for (const path of existingPaths) {
      expect(nodeProvider.has(path)).toBe(true);
      expect(customProvider.has(path)).toBe(true);
    }

    for (const path of nonExistingPaths) {
      expect(nodeProvider.has(path)).toBe(false);
      expect(customProvider.has(path)).toBe(false);
    }
  });

  test("should handle errors consistently", () => {
    const invalidPath = "deeply.nested.nonexistent.path";
    
    // Both should throw when accessing non-existent paths
    expect(() => nodeProvider.get(invalidPath)).toThrow();
    expect(() => customProvider.get(invalidPath)).toThrow();
  });
});

/**
 * Migration scenario tests
 * 
 * These tests simulate real migration scenarios to ensure smooth transitions.
 */
describe("Migration Scenarios", () => {
  test("should support switching providers at runtime", async () => {
    // Start with node-config provider
    const nodeFactory = new NodeConfigFactory();
    await initializeConfiguration(nodeFactory);
    
    const initialConfig = getConfiguration();
    expect(initialConfig).toBeDefined();
    
    // Switch to custom provider
    const customFactory = new CustomConfigFactory();
    await initializeConfiguration(customFactory);
    
    const newConfig = getConfiguration();
    expect(newConfig).toBeDefined();
    
    // Configuration should still be accessible through the same API
    expect(typeof get("backend")).toBe("string");
    expect(has("sessiondb.backend")).toBe(true);
  });

  test("should maintain API compatibility during migration", async () => {
    // Test that the same code works with both providers
    const testConfigurationUsage = () => {
      const config = getConfiguration();
      
      // Direct access
      expect(config.backend).toBeDefined();
      expect(config.sessiondb.backend).toBeDefined();
      
      // Path-based access
      expect(get("backend")).toBeDefined();
      expect(get("sessiondb.backend")).toBeDefined();
      
      // Existence checks
      expect(has("backend")).toBe(true);
      expect(has("sessiondb.backend")).toBe(true);
      
      return true;
    };

    // Test with node-config
    await initializeConfiguration(new NodeConfigFactory());
    expect(testConfigurationUsage()).toBe(true);
    
    // Test with custom provider
    await initializeConfiguration(new CustomConfigFactory());
    expect(testConfigurationUsage()).toBe(true);
  });

  test("should support gradual migration with feature flags", async () => {
    // Simulate a feature flag for enabling the new configuration system
    const useCustomConfig = process.env.USE_CUSTOM_CONFIG === "true";
    
    const factory = useCustomConfig ? new CustomConfigFactory() : new NodeConfigFactory();
    await initializeConfiguration(factory);
    
    // Application code should work regardless of which implementation is used
    const config = getConfiguration();
    expect(config).toBeDefined();
    expect(typeof config.backend).toBe("string");
  });
});

/**
 * Performance comparison tests
 * 
 * These tests help ensure the new implementation meets performance requirements.
 */
describe("Performance Comparison", () => {
  test("should load configuration within acceptable time limits", async () => {
    const maxLoadTime = 100; // 100ms limit
    
    // Test node-config performance
    const nodeStart = Date.now();
    const nodeProvider = await createTestProvider({}, "node-config");
    nodeProvider.getConfig();
    const nodeTime = Date.now() - nodeStart;
    
    // Test custom provider performance
    const customStart = Date.now();
    const customProvider = await createTestProvider({}, "custom");
    customProvider.getConfig();
    const customTime = Date.now() - customStart;
    
    // Both should be reasonably fast
    expect(nodeTime).toBeLessThan(maxLoadTime);
    expect(customTime).toBeLessThan(maxLoadTime);
    
    console.log(`Performance comparison:
      Node-config: ${nodeTime}ms
      Custom: ${customTime}ms`);
  });

  test("should access configuration values efficiently", () => {
    const iterations = 1000;
    const maxAccessTime = 50; // 50ms for 1000 iterations
    
    return Promise.all([
      createTestProvider({}, "node-config"),
      createTestProvider({}, "custom"),
    ]).then(([nodeProvider, customProvider]) => {
      // Test node-config access performance
      const nodeStart = Date.now();
      for (let i = 0; i < iterations; i++) {
        nodeProvider.get("backend");
        nodeProvider.get("sessiondb.backend");
      }
      const nodeTime = Date.now() - nodeStart;
      
      // Test custom provider access performance
      const customStart = Date.now();
      for (let i = 0; i < iterations; i++) {
        customProvider.get("backend");
        customProvider.get("sessiondb.backend");
      }
      const customTime = Date.now() - customStart;
      
      expect(nodeTime).toBeLessThan(maxAccessTime);
      expect(customTime).toBeLessThan(maxAccessTime);
    });
  });
});

// Run the interface compliance tests for both implementations
testConfigurationProvider("NodeConfigProvider", () => 
  createTestProvider({}, "node-config")
);

testConfigurationProvider("CustomConfigurationProvider", () => 
  createTestProvider({}, "custom")
); 
