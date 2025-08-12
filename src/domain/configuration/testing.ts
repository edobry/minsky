/**
 * Configuration Testing Utilities
 *
 * Utilities for testing configuration scenarios, mocking sources,
 * and creating test configurations.
 */

import type { Configuration, PartialConfiguration } from "./schemas";
import type { ConfigurationLoadResult, ConfigurationSourceResult } from "./loader";
import { ConfigurationLoader } from "./loader";

/**
 * Test configuration builder
 */
export class TestConfigurationBuilder {
  private config: PartialConfiguration = {} as PartialConfiguration;

  /**
   * Set backend configuration
   */
  backend(type: "markdown" | "github-issues" | "json-file"): this {
    this.config.backend = type;
    return this;
  }

  /**
   * Set session database configuration
   */
  sessionDb(backend: "sqlite" | "postgres", options?: any): this {
    this.config.sessiondb = {
      backend,
      ...options,
    };
    return this;
  }

  /**
   * Set GitHub configuration
   */
  github(options: Partial<Configuration["github"]>): this {
    this.config.github = {
      ...this.config.github,
      ...options,
    };
    return this;
  }

  /**
   * Set AI configuration
   */
  ai(options: Partial<Configuration["ai"]>): this {
    this.config.ai = {
      ...this.config.ai,
      ...options,
    };
    return this;
  }

  /**
   * Set logger configuration
   */
  logger(options: Partial<Configuration["logger"]>): this {
    this.config.logger = {
      ...this.config.logger,
      ...options,
    };
    return this;
  }

  /**
   * Add custom configuration
   */
  custom(config: PartialConfiguration): this {
    this.config = this.deepMerge(this.config, config);
    return this;
  }

  /**
   * Build the configuration
   */
  build(): PartialConfiguration {
    return { ...this.config };
  }

  /**
   * Simple deep merge for testing
   */
  private deepMerge(target: any, source: any): any {
    const result = { ...target };

    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        if (
          typeof source[key] === "object" &&
          !Array.isArray(source[key]) &&
          source[key] !== null
        ) {
          result[key] = this.deepMerge(result[key] || {}, source[key]);
        } else {
          result[key] = source[key];
        }
      }
    }

    return result;
  }
}

/**
 * Mock configuration loader for testing
 */
export class MockConfigurationLoader {
  private mockSources: Map<string, ConfigurationSourceResult> = new Map();
  private loadError: Error | null = null;

  /**
   * Mock a configuration source
   */
  mockSource(
    name: string,
    config: PartialConfiguration,
    metadata: Record<string, any> = {},
    success: boolean = true,
    error?: Error
  ): this {
    this.mockSources.set(name, {
      source: {
        name,
        description: `Mock ${name} source`,
        priority: this.getDefaultPriority(name),
        required: name === "defaults",
      },
      config,
      metadata,
      loadedAt: new Date(),
      success,
      error,
    });
    return this;
  }

  /**
   * Mock a loading error
   */
  mockLoadError(error: Error): this {
    this.loadError = error;
    return this;
  }

  /**
   * Create a loader that uses mocked sources
   */
  createLoader(): ConfigurationLoader {
    const mockLoader = new ConfigurationLoader({
      enableCache: false,
      failOnValidationError: false,
    });

    // Override the loadAllSources method
    (mockLoader as any).loadAllSources = async () => {
      if (this.loadError) {
        throw this.loadError;
      }

      return Array.from(this.mockSources.values());
    };

    return mockLoader;
  }

  /**
   * Get default priority for source names
   */
  private getDefaultPriority(name: string): number {
    switch (name) {
      case "defaults":
        return 0;
      case "project":
        return 25;
      case "user":
        return 50;
      case "environment":
        return 100;
      default:
        return 10;
    }
  }
}

/**
 * Predefined test configurations
 */
export const testConfigurations = {
  /**
   * Minimal valid configuration
   */
  minimal(): PartialConfiguration {
    return new TestConfigurationBuilder().backend("markdown").sessionDb("sqlite").build();
  },

  /**
   * Development configuration
   */
  development(): PartialConfiguration {
    return new TestConfigurationBuilder()
      .backend("markdown")
      .sessionDb("sqlite", { path: ":memory:" })
      .logger({ level: "debug", mode: "HUMAN" })
      .build();
  },

  /**
   * Production configuration
   */
  production(): PartialConfiguration {
    return new TestConfigurationBuilder()
      .backend("github-issues")
      .sessionDb("postgres", {
        postgres: { connectionString: "postgresql://localhost/minsky_prod" },
      })
      .github({ token: "prod-token" })
      .logger({ level: "info", mode: "STRUCTURED" })
      .build();
  },

  /**
   * Testing configuration
   */
  testing(): PartialConfiguration {
    return new TestConfigurationBuilder()
      .backend("json-file")
      .sessionDb("sqlite", { sqlite: { path: "/tmp/test.db" } })
      .logger({ level: "warn", mode: "auto" })
      .build();
  },

  /**
   * AI-enabled configuration
   */
  withAI(): PartialConfiguration {
    return new TestConfigurationBuilder()
      .backend("markdown")
      .sessionDb("sqlite")
      .ai({
        defaultProvider: "openai",
        providers: {
          openai: {
            apiKey: "test-key",
            model: "gpt-4",
            models: ["gpt-4", "gpt-3.5-turbo"],
            enabled: true,
          },
        },
      })
      .build();
  },

  /**
   * GitHub integration configuration
   */
  withGitHub(): PartialConfiguration {
    return new TestConfigurationBuilder()
      .backend("github-issues")
      .sessionDb("sqlite")
      .github({
        token: "github-token",
        organization: "test-org",
        repository: "test-repo",
      })
      .custom({
        backendConfig: {
          "github-issues": {
            owner: "test-org",
            repo: "test-repo",
          },
        },
      } as PartialConfiguration)
      .build();
  },
};

/**
 * Test environment variables
 */
export const testEnvironmentVariables = {
  /**
   * Set test environment variables
   */
  set(vars: Record<string, string>): () => void {
    const originalValues: Record<string, string | undefined> = {};

    // Store original values and set new ones
    for (const [key, value] of Object.entries(vars)) {
      originalValues[key] = process.env[key];
      process.env[key] = value;
    }

    // Return cleanup function
    return () => {
      for (const [key, originalValue] of Object.entries(originalValues)) {
        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    };
  },

  /**
   * Common test environment setups
   */
  development(): () => void {
    return this.set({
      NODE_ENV: "development",
      MINSKY_LOG_LEVEL: "debug",
      MINSKY_LOG_MODE: "development",
    });
  },

  production(): () => void {
    return this.set({
      NODE_ENV: "production",
      MINSKY_LOG_LEVEL: "info",
      MINSKY_LOG_MODE: "production",
      GITHUB_TOKEN: "prod-github-token",
    });
  },

  testing(): () => void {
    return this.set({
      NODE_ENV: "test",
      MINSKY_LOG_LEVEL: "silent",
      MINSKY_LOG_MODE: "test",
      MINSKY_BACKEND: "json-file",
      MINSKY_SESSIONDB_BACKEND: "sqlite",
    });
  },
};

/**
 * Test assertion helpers
 */
export const testAssertions = {
  /**
   * Assert configuration has expected structure
   */
  hasValidStructure(config: any): config is Configuration {
    return (
      typeof config === "object" &&
      config !== null &&
      typeof config.backend === "string" &&
      typeof config.sessiondb === "object" &&
      typeof config.github === "object" &&
      typeof config.ai === "object" &&
      typeof config.logger === "object"
    );
  },

  /**
   * Assert load result is successful
   */
  isSuccessfulLoad(result: ConfigurationLoadResult): boolean {
    return (
      result.validationResult.success &&
      result.sources.some((s) => s.success) &&
      this.hasValidStructure(result.config)
    );
  },

  /**
   * Assert source loaded successfully
   */
  sourceLoadedSuccessfully(result: ConfigurationLoadResult, sourceName: string): boolean {
    const source = result.sources.find((s) => s.source.name === sourceName);
    return source ? source.success : false;
  },

  /**
   * Assert configuration value came from expected source
   */
  valueFromSource(result: ConfigurationLoadResult, path: string, expectedSource: string): boolean {
    const effectiveValue = result.effectiveValues[path];
    return effectiveValue ? effectiveValue.source === expectedSource : false;
  },
};

/**
 * Create a test configuration builder
 */
export function createTestConfig(): TestConfigurationBuilder {
  return new TestConfigurationBuilder();
}

/**
 * Create a mock configuration loader
 */
export function createMockLoader(): MockConfigurationLoader {
  return new MockConfigurationLoader();
}

/**
 * Quick test configuration loader with sensible defaults
 */
export async function loadTestConfiguration(
  overrides: PartialConfiguration = {} as PartialConfiguration
): Promise<ConfigurationLoadResult> {
  const mockLoader = createMockLoader()
    .mockSource("defaults", testConfigurations.minimal())
    .mockSource("project", {} as PartialConfiguration)
    .mockSource("user", {} as PartialConfiguration)
    .mockSource("environment", overrides);

  const loader = mockLoader.createLoader();
  return loader.load();
}
