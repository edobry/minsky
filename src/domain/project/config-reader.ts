/**
 * Project Configuration Reader - Simplified
 *
 * Loads project-specific workflow configurations using the new simplified format.
 * Eliminates legacy conversion complexity by using simplified format directly.
 */

import { readFileSync, existsSync } from "fs";
import { log } from "../../utils/logger";
import { resolve, join } from "path";

// Simplified workflow command definition
export interface WorkflowCommand {
  jsonCommand: string;
  fixCommand?: string;
}

// Simplified workflow configuration
export interface SimplifiedWorkflowConfig {
  lint?: WorkflowCommand;
  test?: WorkflowCommand;
  build?: WorkflowCommand;
  dev?: WorkflowCommand;
  start?: WorkflowCommand;
  format?: WorkflowCommand;
}

export interface ProjectRuntimeConfig {
  packageManager?: "npm" | "yarn" | "pnpm" | "bun";
  language?: "typescript" | "javascript" | "rust" | "go" | "python" | "other";
}

export interface ProjectConfiguration {
  workflows: SimplifiedWorkflowConfig;
  runtime: ProjectRuntimeConfig;
  configSource: "minsky.json" | "package.json" | "auto-detected" | "defaults";
}

/**
 * Project configuration reader using simplified format directly
 */
export class ProjectConfigReader {
  constructor(private projectRoot: string = process.cwd()) {}

  /**
   * Get the complete project configuration
   */
  async getConfiguration(): Promise<ProjectConfiguration> {
    // 1. Try explicit minsky.json configuration
    const minskyConfig = this.loadMinskyConfig();
    if (minskyConfig) {
      return {
        ...minskyConfig,
        configSource: "minsky.json",
      };
    }

    // 2. Try package.json detection and convert to simplified format
    const packageConfig = this.detectFromPackageJson();
    if (packageConfig) {
      return {
        ...packageConfig,
        configSource: "package.json",
      };
    }

    // 3. Language-specific auto-detection
    const autoConfig = this.autoDetectFromLanguage();
    if (autoConfig) {
      return {
        ...autoConfig,
        configSource: "auto-detected",
      };
    }

    // 4. Fallback to defaults
    return this.getDefaultConfiguration();
  }

  /**
   * Get the lint JSON command (for ESLint output parsing)
   */
  async getLintJsonCommand(): Promise<string> {
    const config = await this.getConfiguration();
    return config.workflows.lint?.jsonCommand || "eslint . --format json";
  }

  /**
   * Get the lint fix command
   */
  async getLintFixCommand(): Promise<string | undefined> {
    const config = await this.getConfiguration();
    return config.workflows.lint?.fixCommand;
  }

  /**
   * Get the test JSON command
   */
  async getTestJsonCommand(): Promise<string> {
    const config = await this.getConfiguration();
    return config.workflows.test?.jsonCommand || "bun test --reporter json";
  }

  /**
   * Load explicit minsky.json configuration
   */
  private loadMinskyConfig(): {
    workflows: SimplifiedWorkflowConfig;
    runtime: ProjectRuntimeConfig;
  } | null {
    const possiblePaths = [
      join(this.projectRoot, "minsky.json"),
      join(this.projectRoot, ".minsky", "config.json"),
      join(this.projectRoot, "config", "minsky.json"),
    ];

    for (const configPath of possiblePaths) {
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(readFileSync(configPath, "utf8"));
          if (config.workflows) {
            return {
              workflows: config.workflows,
              runtime: config.runtime || {},
            };
          }
        } catch (error) {
          log.warn(`Warning: Failed to parse ${configPath}: ${(error as Error).message}`);
        }
      }
    }

    return null;
  }

  /**
   * Detect configuration from package.json and convert to simplified format
   */
  private detectFromPackageJson(): {
    workflows: SimplifiedWorkflowConfig;
    runtime: ProjectRuntimeConfig;
  } | null {
    const packageJsonPath = join(this.projectRoot, "package.json");

    if (!existsSync(packageJsonPath)) {
      return null;
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const scripts = packageJson.scripts || {};

      const packageManager = this.detectPackageManager();
      const language = this.detectLanguageFromPackageJson(packageJson);

      const workflows: SimplifiedWorkflowConfig = {};

      // Convert package.json scripts to simplified format
      if (scripts.lint) {
        workflows.lint = {
          jsonCommand: `${packageManager} run lint --format json`,
          fixCommand: scripts["lint:fix"] ? `${packageManager} run lint:fix` : undefined,
        };
      }

      if (scripts.test) {
        workflows.test = {
          jsonCommand: `${packageManager} run test --reporter json`,
        };
      }

      if (scripts.build) {
        workflows.build = {
          jsonCommand: `${packageManager} run build`,
        };
      }

      if (scripts.dev) {
        workflows.dev = {
          jsonCommand: `${packageManager} run dev`,
        };
      }

      if (scripts.start) {
        workflows.start = {
          jsonCommand: `${packageManager} run start`,
        };
      }

      // Only return if we found at least a lint command
      if (workflows.lint) {
        return {
          workflows,
          runtime: { packageManager, language },
        };
      }
    } catch (error) {
      log.warn(`Warning: Failed to parse package.json: ${(error as Error).message}`);
    }

    return null;
  }

  /**
   * Auto-detect configuration based on project language/structure
   */
  private autoDetectFromLanguage(): {
    workflows: SimplifiedWorkflowConfig;
    runtime: ProjectRuntimeConfig;
  } | null {
    const workflows: SimplifiedWorkflowConfig = {};
    const runtime: ProjectRuntimeConfig = {};

    // Rust detection
    if (existsSync(join(this.projectRoot, "Cargo.toml"))) {
      runtime.language = "rust";
      workflows.lint = {
        jsonCommand: "cargo clippy --message-format=json",
      };
      workflows.test = {
        jsonCommand: "cargo test --format json",
      };
      workflows.build = {
        jsonCommand: "cargo build",
      };
      return { workflows, runtime };
    }

    // Go detection
    if (existsSync(join(this.projectRoot, "go.mod"))) {
      runtime.language = "go";
      workflows.lint = {
        jsonCommand: "golangci-lint run --out-format=json",
      };
      workflows.test = {
        jsonCommand: "go test -json ./...",
      };
      workflows.build = {
        jsonCommand: "go build",
      };
      return { workflows, runtime };
    }

    // Python detection
    if (
      existsSync(join(this.projectRoot, "pyproject.toml")) ||
      existsSync(join(this.projectRoot, "requirements.txt")) ||
      existsSync(join(this.projectRoot, "setup.py"))
    ) {
      runtime.language = "python";
      workflows.lint = {
        jsonCommand: "flake8 --format=json",
      };
      workflows.test = {
        jsonCommand: "pytest --json-report",
      };
      return { workflows, runtime };
    }

    return null;
  }

  /**
   * Get default configuration in simplified format
   */
  private getDefaultConfiguration(): ProjectConfiguration {
    return {
      workflows: {
        lint: {
          jsonCommand: "eslint . --format json",
          fixCommand: "eslint . --fix",
        },
        test: {
          jsonCommand: "bun test --reporter json",
        },
      },
      runtime: {
        packageManager: "npm",
        language: "javascript",
      },
      configSource: "defaults",
    };
  }

  /**
   * Detect package manager from lockfiles
   */
  private detectPackageManager(): "npm" | "yarn" | "pnpm" | "bun" {
    if (
      existsSync(join(this.projectRoot, "bun.lockb")) ||
      existsSync(join(this.projectRoot, "bun.lock"))
    )
      return "bun";
    if (existsSync(join(this.projectRoot, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(this.projectRoot, "yarn.lock"))) return "yarn";
    return "npm"; // default
  }

  /**
   * Detect language from package.json
   */
  private detectLanguageFromPackageJson(packageJson: any): "typescript" | "javascript" | "other" {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    if (
      deps.typescript ||
      deps["@types/node"] ||
      existsSync(join(this.projectRoot, "tsconfig.json"))
    ) {
      return "typescript";
    }

    return "javascript";
  }

  /**
   * Find project root by looking for common indicators
   */
  static findProjectRoot(startDir: string = process.cwd()): string | null {
    let currentDir = resolve(startDir);
    const root = resolve("/");

    while (currentDir !== root) {
      const indicators = [
        "package.json",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        ".git",
        "minsky.json",
        ".minsky",
      ];

      if (indicators.some((indicator) => existsSync(join(currentDir, indicator)))) {
        return currentDir;
      }

      currentDir = resolve(currentDir, "..");
    }

    return null;
  }
}
