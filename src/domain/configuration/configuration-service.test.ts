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

    it("should require version", () => {
      const config = {} as RepositoryConfig;

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("MISSING_VERSION");
    });

    it("should validate GitHub backend configuration", () => {
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

    it("should reject invalid backend types", () => {
      const config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "invalid-backend" as any,
        },
      };

      const result = service.validateRepositoryConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "INVALID_BACKEND")).toBe(true);
    });

    describe("SessionDB validation", () => {
      it("should validate valid SessionDB configurations", () => {
        const config: RepositoryConfig = {
          version: 1,
          sessiondb: {
            backend: "sqlite",
            sqlite: {
              path: "/path/to/sessions.db",
            },
          },
        };

        const result = service.validateRepositoryConfig(config);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("should reject invalid SessionDB backend types", () => {
        const config: RepositoryConfig = {
          version: 1,
          sessiondb: {
            backend: "invalid-backend" as any,
          },
        };

        const result = service.validateRepositoryConfig(config);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.code === "INVALID_SESSIONDB_BACKEND")).toBe(true);
      });

      it("should validate PostgreSQL connection strings", () => {
        const config: RepositoryConfig = {
          version: 1,
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

      it("should require PostgreSQL connection string for postgres backend", () => {
        const config: RepositoryConfig = {
          version: 1,
          sessiondb: {
            backend: "postgres",
          },
        };

        const result = service.validateRepositoryConfig(config);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.code === "MISSING_POSTGRES_CONNECTION_STRING")).toBe(
          true
        );
      });

      it("should warn about missing SQLite path", () => {
        const config: RepositoryConfig = {
          version: 1,
          sessiondb: {
            backend: "sqlite",
          },
        };

        const result = service.validateRepositoryConfig(config);

        expect(result.valid).toBe(true);
        expect(result.warnings.some((w) => w.code === "MISSING_SQLITE_PATH")).toBe(true);
      });

      it("should warn about relative paths", () => {
        const config: RepositoryConfig = {
          version: 1,
          sessiondb: {
            backend: "sqlite",
            sqlite: {
              path: "./relative/path.db",
            },
            base_dir: "../relative/base",
          },
        };

        const result = service.validateRepositoryConfig(config);

        expect(result.valid).toBe(true);
        expect(result.warnings.some((w) => w.code === "RELATIVE_FILE_PATH")).toBe(true);
        expect(result.warnings.some((w) => w.code === "RELATIVE_DIRECTORY_PATH")).toBe(true);
      });

      it("should validate empty paths", () => {
        const config: RepositoryConfig = {
          version: 1,
          sessiondb: {
            backend: "sqlite",
            sqlite: {
              path: "",
            },
            base_dir: "   ",
          },
        };

        const result = service.validateRepositoryConfig(config);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.code === "EMPTY_FILE_PATH")).toBe(true);
        expect(result.errors.some((e) => e.code === "EMPTY_DIRECTORY_PATH")).toBe(true);
      });
    });

    describe("AI configuration validation", () => {
      it("should validate valid AI configurations", () => {
        const config: RepositoryConfig = {
          version: 1,
          ai: {
            default_provider: "openai",
            providers: {
              openai: {
                enabled: true,
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

      it("should reject invalid AI providers", () => {
        const config: RepositoryConfig = {
          version: 1,
          ai: {
            default_provider: "invalid-provider" as any,
          },
        };

        const result = service.validateRepositoryConfig(config);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.code === "INVALID_AI_PROVIDER")).toBe(true);
      });

      it("should validate AI provider configurations", () => {
        const config: RepositoryConfig = {
          version: 1,
          ai: {
            providers: {
              openai: {
                max_tokens: -1,
                temperature: 3.0,
              },
            },
          },
        };

        const result = service.validateRepositoryConfig(config);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.code === "INVALID_MAX_TOKENS")).toBe(true);
        expect(result.errors.some((e) => e.code === "INVALID_TEMPERATURE")).toBe(true);
      });

      it("should warn about incomplete file credentials", () => {
        const config: RepositoryConfig = {
          version: 1,
          ai: {
            providers: {
              openai: {
                credentials: {
                  source: "file",
                  // Missing api_key and api_key_file
                },
              },
            },
          },
        };

        const result = service.validateRepositoryConfig(config);

        expect(result.valid).toBe(true);
        expect(result.warnings.some((w) => w.code === "INCOMPLETE_FILE_CREDENTIALS")).toBe(true);
      });
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

    it("should require version", () => {
      const config = {} as GlobalUserConfig;

      const result = service.validateGlobalUserConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("MISSING_VERSION");
    });

    it("should validate credential sources", () => {
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

    it("should warn about incomplete file credentials", () => {
      const config: GlobalUserConfig = {
        version: 1,
        github: {
          credentials: {
            source: "file",
            // Missing token and token_file
          },
        },
      };

      const result = service.validateGlobalUserConfig(config);

      expect(result.valid).toBe(true); // Still valid, just a warning
      expect(result.warnings.some((w) => w.code === "INCOMPLETE_FILE_CREDENTIALS")).toBe(true);
    });

    describe("SessionDB validation in global config", () => {
      it("should validate SessionDB configuration", () => {
        const config: GlobalUserConfig = {
          version: 1,
          sessiondb: {
            sqlite: {
              path: "/home/user/.local/state/minsky/sessions.db",
            },
            base_dir: "/home/user/.local/state/minsky",
          },
        };

        const result = service.validateGlobalUserConfig(config);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("should validate empty SessionDB paths", () => {
        const config: GlobalUserConfig = {
          version: 1,
          sessiondb: {
            sqlite: {
              path: "",
            },
            base_dir: "   ",
          },
        };

        const result = service.validateGlobalUserConfig(config);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.code === "EMPTY_FILE_PATH")).toBe(true);
        expect(result.errors.some((e) => e.code === "EMPTY_DIRECTORY_PATH")).toBe(true);
      });
    });

    describe("PostgreSQL configuration validation", () => {
      it("should validate PostgreSQL connection strings", () => {
        const config: GlobalUserConfig = {
          version: 1,
          postgres: {
            connection_string: "postgresql://user:pass@localhost:5432/minsky",
          },
        };

        const result = service.validateGlobalUserConfig(config);

        expect(result.valid).toBe(true);
        expect(result.warnings.some((w) => w.code === "PLAIN_TEXT_CREDENTIALS")).toBe(true);
      });

      it("should reject invalid PostgreSQL connection strings", () => {
        const config: GlobalUserConfig = {
          version: 1,
          postgres: {
            connection_string: "invalid-connection-string",
          },
        };

        const result = service.validateGlobalUserConfig(config);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.code === "INVALID_CONNECTION_STRING_FORMAT")).toBe(true);
      });
    });

    describe("AI configuration validation", () => {
      it("should validate AI configuration in global config", () => {
        const config: GlobalUserConfig = {
          version: 1,
          ai: {
            default_provider: "anthropic",
            providers: {
              anthropic: {
                enabled: true,
                credentials: {
                  source: "environment",
                },
              },
            },
          },
        };

        const result = service.validateGlobalUserConfig(config);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });
  });
});
