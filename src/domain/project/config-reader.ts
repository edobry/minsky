/**
 * Project Configuration Reader - Simplified
 *
 * Loads project-specific workflow configurations using the new simplified format.
 * Directly loads minsky.json without detection or fallback complexity.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

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
  configSource: "minsky.json";
}

/**
 * Project configuration reader using simplified format directly
 */
export class ProjectConfigReader {
  constructor(private projectRoot: string = process.cwd()) {}

  /**
   * Get the complete project configuration from minsky.json
   */
  async getConfiguration(): Promise<ProjectConfiguration> {
    const configPath = join(this.projectRoot, "minsky.json");
    
    if (!existsSync(configPath)) {
      throw new Error(`minsky.json not found at ${configPath}`);
    }

    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsedConfig = JSON.parse(content);
      
      return {
        workflows: parsedConfig.workflows || {},
        runtime: parsedConfig.runtime || {},
        configSource: "minsky.json",
      };
    } catch (error) {
      throw new Error(`Invalid minsky.json format: ${error}`);
    }
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
   * Get the test command
   */
  async getTestCommand(): Promise<string> {
    const config = await this.getConfiguration();
    return config.workflows.test?.jsonCommand || "bun test";
  }

  /**
   * Get the build command
   */
  async getBuildCommand(): Promise<string | undefined> {
    const config = await this.getConfiguration();
    return config.workflows.build?.jsonCommand;
  }

  /**
   * Get the dev command  
   */
  async getDevCommand(): Promise<string | undefined> {
    const config = await this.getConfiguration();
    return config.workflows.dev?.jsonCommand;
  }

  /**
   * Get the start command
   */
  async getStartCommand(): Promise<string | undefined> {
    const config = await this.getConfiguration();
    return config.workflows.start?.jsonCommand;
  }
}