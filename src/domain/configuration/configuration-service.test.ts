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
      const _config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "test-repo"
          }
        }
      };

      const result = service.validateRepositoryConfig(_config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should require version", () => {
      const _config = {} as RepositoryConfig;

      const result = service.validateRepositoryConfig(_config);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("MISSING_VERSION");
    });

    it("should validate GitHub backend configuration", () => {
      const _config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "github-issues",
          "github-issues": {
            owner: "test-org",
            repo: "" // Missing repo
          }
        }
      };

      const result = service.validateRepositoryConfig(_config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === "MISSING_GITHUB_REPO")).toBe(true);
    });

    it("should reject invalid backend types", () => {
      const _config: RepositoryConfig = {
        version: 1,
        backends: {
          default: "invalid-backend" as any
        }
      };

      const result = service.validateRepositoryConfig(_config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === "INVALID_BACKEND")).toBe(true);
    });
  });

  describe("validateGlobalUserConfig", () => {
    it("should validate a valid global user config", () => {
      const _config: GlobalUserConfig = {
        version: 1,
        credentials: {
          github: {
            source: "environment"
          }
        }
      };

      const result = service.validateGlobalUserConfig(_config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should require version", () => {
      const _config = {} as GlobalUserConfig;

      const result = service.validateGlobalUserConfig(_config);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("MISSING_VERSION");
    });

    it("should validate credential sources", () => {
      const _config: GlobalUserConfig = {
        version: 1,
        credentials: {
          github: {
            source: "invalid-source" as any
          }
        }
      };

      const result = service.validateGlobalUserConfig(_config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === "INVALID_CREDENTIAL_SOURCE")).toBe(true);
    });

    it("should warn about incomplete file credentials", () => {
      const _config: GlobalUserConfig = {
        version: 1,
        credentials: {
          github: {
            source: "file"
            // Missing token and token_file
          }
        }
      };

      const result = service.validateGlobalUserConfig(_config);

      expect(result.valid).toBe(true); // Still valid, just a warning
      expect(result.warnings.some(w => w.code === "INCOMPLETE_FILE_CREDENTIALS")).toBe(true);
    });
  });
}); 
