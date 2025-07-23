/**
 * Project Configuration Reader
 *
 * Reads project configuration from various sources:
 * 1. minsky.json (if exists)
 * 2. package.json scripts section
 * 3. Default fallbacks
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { log } from "../../utils/logger";
import type { ProjectConfiguration, ProjectWorkflows, ProjectConfigSource } from "./types";

export class ProjectConfigReader {
  constructor(private projectRoot: string) {}

  /**
   * Load project configuration from available sources
   */
  async loadConfiguration(): Promise<ProjectConfigSource> {
    // Try to load from minsky.json first
    const minskyConfig = await this.tryLoadMinskyConfig();
    if (minskyConfig) {
      return minskyConfig;
    }

    // Fall back to package.json
    const packageConfig = await this.tryLoadPackageJsonConfig();
    if (packageConfig) {
      return packageConfig;
    }

    // Fall back to defaults
    return this.getDefaultConfig();
  }

  /**
   * Try to load configuration from minsky.json
   */
  private async tryLoadMinskyConfig(): Promise<ProjectConfigSource | null> {
    const configPath = join(this.projectRoot, "minsky.json");

    if (!existsSync(configPath)) {
      return null;
    }

    try {
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content) as ProjectConfiguration;

      log.debug("Loaded project config from minsky.json", { configPath });

      return {
        type: "minsky.json",
        path: configPath,
        workflows: config.workflows || {},
      };
    } catch (error) {
      log.warn("Failed to parse minsky.json", {
        configPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Try to load configuration from package.json scripts
   */
  private async tryLoadPackageJsonConfig(): Promise<ProjectConfigSource | null> {
    const packagePath = join(this.projectRoot, "package.json");

    if (!existsSync(packagePath)) {
      return null;
    }

    try {
      const content = await readFile(packagePath, "utf-8");
      const pkg = JSON.parse(content);

      if (!pkg.scripts) {
        return null;
      }

      // Map package.json scripts to our workflow structure
      const workflows: ProjectWorkflows = {};

      // Direct mappings
      if (pkg.scripts.install) workflows.install = pkg.scripts.install;
      if (pkg.scripts.build) workflows.build = pkg.scripts.build;
      if (pkg.scripts.start) workflows.start = pkg.scripts.start;
      if (pkg.scripts.dev) workflows.dev = pkg.scripts.dev;
      if (pkg.scripts.test) workflows.test = pkg.scripts.test;
      if (pkg.scripts.lint) workflows.lint = pkg.scripts.lint;
      if (pkg.scripts.format) workflows.format = pkg.scripts.format;
      if (pkg.scripts.clean) workflows.clean = pkg.scripts.clean;

      // Common variations
      if (!workflows.dev && pkg.scripts["dev:start"]) workflows.dev = pkg.scripts["dev:start"];
      if (!workflows.dev && pkg.scripts.develop) workflows.dev = pkg.scripts.develop;
      if (!workflows.lint && pkg.scripts["lint:check"]) workflows.lint = pkg.scripts["lint:check"];
      if (!workflows.format && pkg.scripts["format:check"])
        workflows.format = pkg.scripts["format:check"];

      log.debug("Loaded project config from package.json", {
        packagePath,
        workflows: Object.keys(workflows),
      });

      return {
        type: "package.json",
        path: packagePath,
        workflows,
      };
    } catch (error) {
      log.warn("Failed to parse package.json", {
        packagePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get default configuration when no other sources are available
   */
  private getDefaultConfig(): ProjectConfigSource {
    log.debug("Using default project configuration");

    return {
      type: "default",
      workflows: {
        lint: "eslint .", // Default lint command
        test: "npm test",
        build: "npm run build",
        start: "npm start",
      },
    };
  }

  /**
   * Get the lint command specifically, with smart fallbacks
   */
  async getLintCommand(): Promise<string> {
    const config = await this.loadConfiguration();

    // If we have a lint command configured, use it
    if (config.workflows.lint) {
      return config.workflows.lint;
    }

    // Smart fallbacks based on project type
    const packagePath = join(this.projectRoot, "package.json");
    if (existsSync(packagePath)) {
      try {
        const content = await readFile(packagePath, "utf-8");
        const pkg = JSON.parse(content);

        // Check if project uses common linters
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (deps.eslint) {
          return "eslint .";
        }
        if (deps.tslint) {
          return "tslint --project .";
        }
        if (deps.standard) {
          return "standard";
        }
      } catch (error) {
        log.debug("Failed to analyze package.json for lint fallback", { error });
      }
    }

    // Final fallback
    return "eslint .";
  }
}
