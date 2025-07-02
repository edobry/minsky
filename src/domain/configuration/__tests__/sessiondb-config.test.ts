/**
 * SessionDB Configuration Loading Tests
 *
 * Tests configuration loading and merging from all sources:
 * - CLI arguments
 * - Environment variables
 * - Global user config
 * - Repository config
 * - Default values
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";

import { ConfigurationLoader } from "../config-loader";
import { SessionDbConfig, RepositoryConfig, GlobalUserConfig } from "../types";

describe("SessionDB Configuration Loading", () => {
  let testDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `sessiondb-config-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(testDir, { recursive: true });

    // Save original environment
    originalEnv = {
      MINSKY_SESSIONDB_BACKEND: process.env.MINSKY_SESSIONDB_BACKEND,
      MINSKY_SESSIONDB_DBPATH: process.env.MINSKY_SESSIONDB_DBPATH,
      MINSKY_SESSIONDB_BASEDIR: process.env.MINSKY_SESSIONDB_BASEDIR,
      MINSKY_SESSIONDB_CONNECTION_STRING: process.env.MINSKY_SESSIONDB_CONNECTION_STRING,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
  });

  afterEach(() => {
    // Restore original environment
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Default Configuration", () => {
    test("should provide sensible defaults", async () => {
      // Set up minimal test environment
      process.env.HOME = testDir;
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.XDG_STATE_HOME;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toContain("minsky");
      expect(config.resolved.sessiondb.dbPath).toBeUndefined();
      expect(config.resolved.sessiondb.connectionString).toBeUndefined();
    });
  });

  describe("Environment Variable Configuration", () => {
    test("should load from environment variables", async () => {
      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_BACKEND = "sqlite";
      process.env.MINSKY_SESSIONDB_DBPATH = "/custom/path/sessions.db";
      process.env.MINSKY_SESSIONDB_BASEDIR = "/custom/base";
      process.env.MINSKY_SESSIONDB_CONNECTION_STRING = "postgresql://test:test@localhost/test";

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/custom/path/sessions.db");
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/base");
      expect(config.resolved.sessiondb.connectionString).toBe(
        "postgresql://test:test@localhost/test"
      );
    });

    test("should handle invalid environment backend gracefully", async () => {
      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_BACKEND = "invalid-backend";

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      // Should fall back to default
      expect(config.resolved.sessiondb.backend).toBe("json");
    });
  });

  describe("Global User Configuration", () => {
    test("should load from global user config file", async () => {
      const configDir = join(testDir, ".config", "minsky");
      mkdirSync(configDir, { recursive: true });

      const globalConfig = {
        sessiondb: {
          backend: "sqlite",
          dbPath: "~/.local/state/minsky/global-sessions.db",
          baseDir: "~/.local/state/minsky/global-sessions",
        },
      };

      writeFileSync(
        join(configDir, "config.toml"),
        `[sessiondb]
backend = "sqlite"
dbPath = "~/.local/state/minsky/global-sessions.db"
baseDir = "~/.local/state/minsky/global-sessions"`
      );

      process.env.HOME = testDir;
      delete process.env.XDG_CONFIG_HOME;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("~/.local/state/minsky/global-sessions.db");
      expect(config.resolved.sessiondb.baseDir).toBe("~/.local/state/minsky/global-sessions");
    });

    test("should use XDG_CONFIG_HOME when available", async () => {
      const xdgConfigDir = join(testDir, "xdg-config");
      mkdirSync(join(xdgConfigDir, "minsky"), { recursive: true });

      writeFileSync(
        join(xdgConfigDir, "minsky", "config.toml"),
        `[sessiondb]
backend = "postgres"
connectionString = "postgresql://xdg:test@localhost/xdg"`
      );

      process.env.HOME = testDir;
      process.env.XDG_CONFIG_HOME = xdgConfigDir;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("postgres");
      expect(config.resolved.sessiondb.connectionString).toBe(
        "postgresql://xdg:test@localhost/xdg"
      );
    });
  });

  describe("Repository Configuration", () => {
    test("should load from repository config file", async () => {
      const repoMinskypDir = join(testDir, ".minsky");
      mkdirSync(repoMinskypDir);

      writeFileSync(
        join(repoMinskypDir, "config.toml"),
        `[sessiondb]
backend = "postgres"
connectionString = "postgresql://repo:test@localhost/repo"
baseDir = "./sessions"`
      );

      process.env.HOME = testDir;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("postgres");
      expect(config.resolved.sessiondb.connectionString).toBe(
        "postgresql://repo:test@localhost/repo"
      );
      expect(config.resolved.sessiondb.baseDir).toBe("./sessions");
    });
  });

  describe("Configuration Precedence", () => {
    test("should respect configuration precedence: CLI > Env > Repository > Global > Defaults", async () => {
      // Set up global config
      const globalConfigDir = join(testDir, ".config", "minsky");
      mkdirSync(globalConfigDir, { recursive: true });
      writeFileSync(
        join(globalConfigDir, "config.toml"),
        `[sessiondb]
backend = "sqlite"
baseDir = "/global/base"`
      );

      // Set up repository config
      const repoConfigDir = join(testDir, ".minsky");
      mkdirSync(repoConfigDir);
      writeFileSync(
        join(repoConfigDir, "config.toml"),
        `[sessiondb]
backend = "postgres"
connectionString = "postgresql://repo:test@localhost/repo"
baseDir = "/repo/base"`
      );

      // Set up environment
      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_BACKEND = "json";
      process.env.MINSKY_SESSIONDB_BASEDIR = "/env/base";

      const loader = new ConfigurationLoader();

      // Test with CLI override
      const cliArgs = {
        sessiondbBackend: "sqlite",
        sessiondbDbPath: "/cli/sessions.db",
      };

      const config = await loader.loadConfiguration(testDir, cliArgs);

      // CLI should win for explicitly provided values
      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/cli/sessions.db");

      // Environment should win for values not in CLI
      expect(config.resolved.sessiondb.baseDir).toBe("/env/base");

      // Repository should provide connectionString (not overridden by higher levels)
      expect(config.resolved.sessiondb.connectionString).toBe(
        "postgresql://repo:test@localhost/repo"
      );
    });

    test("should handle missing config files gracefully", async () => {
      process.env.HOME = testDir;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      // Should fall back to defaults without error
      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toContain("minsky");
    });
  });

  describe("Configuration Validation", () => {
    test("should validate PostgreSQL backend requires connection string", async () => {
      process.env.HOME = testDir;

      const repoConfigDir = join(testDir, ".minsky");
      mkdirSync(repoConfigDir);
      writeFileSync(
        join(repoConfigDir, "config.toml"),
        `[sessiondb]
backend = "postgres"`
        // Missing connectionString
      );

      const loader = new ConfigurationLoader();

      expect(async () => {
        await loader.loadConfiguration(testDir);
      }).toThrow();
    });

    test("should validate SQLite backend paths", async () => {
      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_BACKEND = "sqlite";
      process.env.MINSKY_SESSIONDB_DBPATH = "/invalid/readonly/path/sessions.db";

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      // Should load config but may fail at runtime - this is expected
      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/invalid/readonly/path/sessions.db");
    });

    test("should handle malformed TOML files gracefully", async () => {
      const repoConfigDir = join(testDir, ".minsky");
      mkdirSync(repoConfigDir);
      writeFileSync(
        join(repoConfigDir, "config.toml"),
        `[sessiondb
backend = "sqlite"` // Invalid TOML - missing closing bracket
      );

      process.env.HOME = testDir;

      const loader = new ConfigurationLoader();

      expect(async () => {
        await loader.loadConfiguration(testDir);
      }).toThrow();
    });
  });

  describe("Path Resolution", () => {
    test("should resolve tilde paths in configuration", async () => {
      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_DBPATH = "~/custom/sessions.db";

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.dbPath).toBe(join(testDir, "custom", "sessions.db"));
    });

    test("should resolve relative paths in repository config", async () => {
      const repoConfigDir = join(testDir, ".minsky");
      mkdirSync(repoConfigDir);
      writeFileSync(
        join(repoConfigDir, "config.toml"),
        `[sessiondb]
baseDir = "./local-sessions"`
      );

      process.env.HOME = testDir;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.baseDir).toBe(join(testDir, "local-sessions"));
    });

    test("should handle environment variable expansion", async () => {
      process.env.HOME = testDir;
      process.env.PROJECT_NAME = "test-project";
      process.env.MINSKY_SESSIONDB_BASEDIR = "${HOME}/projects/${PROJECT_NAME}/sessions";

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.baseDir).toBe(
        join(testDir, "projects", "test-project", "sessions")
      );
    });
  });

  describe("Configuration Sources Tracking", () => {
    test("should track configuration sources for debugging", async () => {
      // Set up multiple config sources
      const globalConfigDir = join(testDir, ".config", "minsky");
      mkdirSync(globalConfigDir, { recursive: true });
      writeFileSync(
        join(globalConfigDir, "config.toml"),
        `[sessiondb]
backend = "sqlite"`
      );

      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_BASEDIR = "/env/base";

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      // Should track where each value came from
      expect(config.sources.sessiondb?.backend).toBe("global");
      expect(config.sources.sessiondb?.baseDir).toBe("environment");
    });
  });

  describe("Backend-Specific Configuration", () => {
    test("should load JSON backend configuration", async () => {
      const repoConfigDir = join(testDir, ".minsky");
      mkdirSync(repoConfigDir);
      writeFileSync(
        join(repoConfigDir, "config.toml"),
        `[sessiondb]
backend = "json"
baseDir = "./json-sessions"
backupCount = 5
autoBackup = true`
      );

      process.env.HOME = testDir;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBe(join(testDir, "json-sessions"));
      expect(config.resolved.sessiondb.backupCount).toBe(5);
      expect(config.resolved.sessiondb.autoBackup).toBe(true);
    });

    test("should load SQLite backend configuration", async () => {
      const repoConfigDir = join(testDir, ".minsky");
      mkdirSync(repoConfigDir);
      writeFileSync(
        join(repoConfigDir, "config.toml"),
        `[sessiondb]
backend = "sqlite"
dbPath = "./sqlite-sessions.db"
journalMode = "WAL"
synchronous = "NORMAL"
cacheSize = 10000`
      );

      process.env.HOME = testDir;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe(join(testDir, "sqlite-sessions.db"));
      expect(config.resolved.sessiondb.journalMode).toBe("WAL");
      expect(config.resolved.sessiondb.synchronous).toBe("NORMAL");
      expect(config.resolved.sessiondb.cacheSize).toBe(10000);
    });

    test("should load PostgreSQL backend configuration", async () => {
      const repoConfigDir = join(testDir, ".minsky");
      mkdirSync(repoConfigDir);
      writeFileSync(
        join(repoConfigDir, "config.toml"),
        `[sessiondb]
backend = "postgres"
connectionString = "postgresql://user:pass@localhost:5432/minsky"
maxConnections = 10
idleTimeout = 30000
ssl = true`
      );

      process.env.HOME = testDir;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("postgres");
      expect(config.resolved.sessiondb.connectionString).toBe(
        "postgresql://user:pass@localhost:5432/minsky"
      );
      expect(config.resolved.sessiondb.maxConnections).toBe(10);
      expect(config.resolved.sessiondb.idleTimeout).toBe(30000);
      expect(config.resolved.sessiondb.ssl).toBe(true);
    });
  });

  describe("Error Handling", () => {
    test("should handle permission errors on config files", async () => {
      const repoConfigDir = join(testDir, ".minsky");
      mkdirSync(repoConfigDir);
      const configFile = join(repoConfigDir, "config.toml");
      writeFileSync(configFile, "[sessiondb]\nbackend = \"sqlite\"");

      // Make file unreadable (this might not work on all systems)
      try {
        require("fs").chmodSync(configFile, 0o000);

        process.env.HOME = testDir;

        const loader = new ConfigurationLoader();

        expect(async () => {
          await loader.loadConfiguration(testDir);
        }).toThrow();
      } finally {
        // Restore permissions for cleanup
        require("fs").chmodSync(configFile, 0o644);
      }
    });

    test("should handle circular symlinks in config directories", async () => {
      const configDir = join(testDir, ".config", "minsky");
      mkdirSync(configDir, { recursive: true });

      // This test is complex to implement reliably across platforms
      // Skipping for now but documenting the requirement
      // TODO: Implement circular symlink handling test
    });
  });
});
