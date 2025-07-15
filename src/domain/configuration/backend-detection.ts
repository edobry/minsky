/**
 * Backend Detection Service for Node-Config Integration
 *
 * Provides backend detection functionality using node-config for configuration
 * while preserving existing detection logic and capabilities.
 */

import config from "config";
import { existsSync } from "fs";
import { join } from "path";

export interface DetectionRule {
  condition: "json_file_exists" | "tasks_md_exists" | "always";
  backend: string;
}

export interface BackendDetectionService {
  detectBackend(workingDir: string): Promise<string>;
  tasksMdExists(workingDir: string): Promise<boolean>;
  jsonFileExists(workingDir: string): Promise<boolean>;
  githubRemoteExists(workingDir: string): Promise<boolean>;
}

export class DefaultBackendDetectionService implements BackendDetectionService {
  /**
   * Detect the most appropriate backend based on detection rules from node-config
   */
  async detectBackend(workingDir: string): Promise<string> {
    // Get detection rules from node-config
    const rules: DetectionRule[] = config.get("detectionRules");
    
    for (const rule of rules) {
      const matches = await this.checkCondition(workingDir, rule.condition);
      if (matches) {
        return rule.backend;
      }
    }

    // Default fallback (should not reach here with proper rules)
    return "json-file";
  }

  /**
   * Check if a detection condition is met
   */
  private async checkCondition(workingDir: string, condition: string): Promise<boolean> {
    switch (condition) {
    case "tasks_md_exists":
      return this.tasksMdExists(workingDir);
    case "json_file_exists":
      return this.jsonFileExists(workingDir);
    case "always":
      return true;
    default:
      return false;
    }
  }

  /**
   * Check if process/tasks.md exists
   */
  async tasksMdExists(workingDir: string): Promise<boolean> {
    const tasksPath = join(workingDir, "process", "tasks.md");
    return existsSync(tasksPath);
  }

  /**
   * Check if .minsky/tasks.json exists
   */
  async jsonFileExists(workingDir: string): Promise<boolean> {
    const jsonPath = join(workingDir, ".minsky", "tasks.json");
    return existsSync(jsonPath);
  }

  /**
   * Check if GitHub remote exists (disabled for auto-detection)
   */
  async githubRemoteExists(_workingDir: string): Promise<boolean> {
    // GitHub Issues detection is disabled for auto-detection
    // to prevent automatic selection of this backend
    return false;
  }
}

// Export singleton instance
export const _backendDetectionService = new DefaultBackendDetectionService(); 
