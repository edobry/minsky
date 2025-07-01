/**
 * Backend Detection for Task Systems
 * 
 * Provides automatic detection of appropriate task backends based on
 * what files exist in the workspace.
 */

import { existsSync } from "fs";
import { join } from "path";
import config from "config";
import { log } from "../../utils/logger";

/**
 * Detect the appropriate backend for a workspace based on existing files
 * @param workspacePath Path to the workspace to analyze
 * @returns Promise resolving to the detected backend name
 */
export async function detectBackend(workspacePath: string): Promise<string> {
  try {
    log.debug(`Starting backend detection for ${workspacePath}`);

    // Check for tasks.md first (markdown backend)
    if (existsSync(join(workspacePath, "tasks.md"))) {
      log.debug("Backend detected: markdown (tasks.md found)");
      return "markdown";
    }
    
    // Check for JSON task files (json-file backend)
    const jsonPaths = [
      join(workspacePath, "tasks.json"),
      join(workspacePath, ".minsky", "tasks.json"),
      join(workspacePath, "process", "tasks.json"),
    ];
    
    if (jsonPaths.some(path => existsSync(path))) {
      log.debug("Backend detected: json-file (JSON task files found)");
      return "json-file";
    }
    
    // Fallback to configured default
    const defaultBackend = (config.get("backend") as string) || "markdown";
    log.debug(`No task files found, using default backend: ${defaultBackend}`);
    return defaultBackend;
  } catch (error) {
    const fallback = "markdown";
    log.warn(`Backend detection failed for ${workspacePath}, using fallback: ${fallback}`);
    return fallback;
  }
}

/**
 * Check if a GitHub remote exists (for potential GitHub Issues backend)
 * @param workspacePath Path to the workspace
 * @returns Promise resolving to true if GitHub remote exists
 */
export async function githubRemoteExists(workspacePath: string): Promise<boolean> {
  try {
    const { execSync } = await import("child_process");
    const result = execSync("git remote get-url origin", {
      cwd: workspacePath,
      encoding: "utf8",
    });
    return result.includes("github.com");
  } catch {
    return false;
  }
}
