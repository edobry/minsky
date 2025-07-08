/**
 * Tests for the configuration service
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { DefaultConfigurationService } from "./configuration-service";
import { RepositoryConfig, GlobalUserConfig } from "./types";

describe("DefaultConfigurationService", () => {
  let service: DefaultConfigurationService;

  beforeEach(() => {
    service = new DefaultConfigurationService();
  });

  describe("validateRepositoryConfig", () => {
    it("should validate a valid repository config", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "test-repo",
          },
        },
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should validate empty config", () => {
      const config = {} as RepositoryConfig;

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should validate missing GitHub repo", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "", // Missing repo
          },
        },
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "MISSING_GITHUB_REPO")).toBe(true);
    });

    it("should validate invalid backend", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "invalid-backend" as any,
        } as any,
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "INVALID_BACKEND")).toBe(true);
    });

    it("should validate SessionDB configuration", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "test-repo",
          },
        },
        sessiondb: {
          backend: "sqlite",
          sqlite: {
            path: "/tmp/test.db",
          },
        } as any,
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should validate invalid SessionDB backend", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "test-repo",
          },
        },
        sessiondb: {
          backend: "invalid-backend" as any,
        },
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "INVALID_SESSIONDB_BACKEND")).toBe(true);
    });

    it("should validate empty paths", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "test-repo",
          },
        },
        sessiondb: {
          backend: "sqlite",
          sqlite: {
            path: "",
          },
        },
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "EMPTY_FILE_PATH")).toBe(true);
    });

    it("should validate PostgreSQL connection string", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "test-repo",
          },
        },
        sessiondb: {
          backend: "postgres",
          postgres: {
            connection_string: "postgresql://user:pass@localhost:5432/testdb",
          },
        },
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should validate invalid PostgreSQL connection string", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "test-repo",
          },
        },
        sessiondb: {
          backend: "postgres",
          postgres: {
            connection_string: "invalid-connection-string",
          },
        },
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "INVALID_CONNECTION_STRING_FORMAT")).toBe(true);
    });

    it("should validate AI configuration", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "test-repo",
          },
        },
        ai: {
          default_provider: "openai",
          providers: {
            openai: {
              credentials: {
                source: "environment",
              },
              max_tokens: 1000,
              temperature: 0.7,
            },
          },
        },
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should validate invalid AI provider", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "test-repo",
          },
        },
        ai: {
          default_provider: "invalid-provider" as any,
        },
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "INVALID_AI_PROVIDER")).toBe(true);
    });

    it("should validate invalid AI temperature", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "test-repo",
          },
        },
        ai: {
          default_provider: "openai",
          providers: {
            openai: {
              temperature: 5.0, // Invalid temperature > 2
            },
          },
        },
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "INVALID_TEMPERATURE")).toBe(true);
    });
  });

  describe("validateGlobalUserConfig", () => {
    it("should validate a valid global user config", () => {
      const config: GlobalUserConfig = {
        version: 1,
        github: {
          credentials: {
            source: "environment",
          },
        },
      };

      const result = service.validateGlobalUserConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should validate empty config", () => {
      const config = {} as GlobalUserConfig;

      const result = service.validateGlobalUserConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should validate SessionDB configuration in global config", () => {
      const config: GlobalUserConfig = {
        version: 1,
        sessiondb: {
          backend: "sqlite",
          sqlite: {
            path: "/tmp/global-test.db",
          },
        },
      };

      const result = service.validateGlobalUserConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should validate AI configuration in global config", () => {
      const config: GlobalUserConfig = {
        version: 1,
        ai: {
          default_provider: "anthropic",
          providers: {
            anthropic: {
              credentials: {
                source: "file",
                api_key_file: "/path/to/key",
              },
            },
          },
        },
      };

      const result = service.validateGlobalUserConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should validate PostgreSQL configuration in global config", () => {
      const config: GlobalUserConfig = {
        version: 1,
        postgres: {
          connection_string: "postgresql://user:pass@localhost:5432/globaldb",
        },
      };

      const result = service.validateGlobalUserConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.code === "PLAIN_TEXT_CREDENTIALS")).toBe(true);
    });

    it("should validate invalid credential source", () => {
      const config: GlobalUserConfig = {
        version: 1,
        github: {
          credentials: {
            source: "invalid-source" as any,
          },
        },
      };

      const result = service.validateGlobalUserConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "INVALID_CREDENTIAL_SOURCE")).toBe(true);
    });
  });
}); 
