/**
 * Auto-Configuring JSON Task Backend
 * 
 * Factory functions that automatically configure workspace and storage
 * for JSON task backends, providing simple one-step setup.
 */

import { join } from "path";
import { existsSync } from "fs";
import { JsonFileTaskBackend } from "./jsonFileTaskBackend";
import { createSpecialWorkspaceManager } from "../workspace/special-workspace-manager";
import type { TaskBackend } from "./taskBackend";
import type { WorkspaceResolvingJsonConfig } from "./workspace-resolving-backend-config";
import type { JsonFileTaskBackendOptions } from "./jsonFileTaskBackend";
import { log } from "../../utils/logger";

/**
 * Configure workspace and database file path automatically
 */
async function configureJsonBackend(config: WorkspaceResolvingJsonConfig): Promise<JsonFileTaskBackendOptions> {
  // 1. Explicit workspace path override
  if (config.workspacePath) {
    const dbFilePath = config.dbFilePath || join(config.workspacePath, "process", "tasks.json");
    return {
      ...config,
      workspacePath: config.workspacePath,
      dbFilePath
    };
  }

  // 2. Repository URL provided - use special workspace
  if (config.repoUrl) {
    const specialWorkspaceManager = createSpecialWorkspaceManager({ 
      repoUrl: config.repoUrl 
    });
    
    // Initialize the workspace if it doesn't exist
    await specialWorkspaceManager.initialize();
    
    const workspacePath = specialWorkspaceManager.getWorkspacePath();
    const dbFilePath = config.dbFilePath || join(workspacePath, "process", "tasks.json");
    
    return {
      ...config,
      workspacePath,
      dbFilePath
    };
  }

  // 3. Check for local tasks.json file in process directory
  const currentDir = (process as any).cwd();
  const localTasksPath = join(currentDir, "process", "tasks.json");
  
  if (existsSync(localTasksPath)) {
    return {
      ...config,
      workspacePath: currentDir,
      dbFilePath: config.dbFilePath || localTasksPath
    };
  }

  // 4. Default to current directory
  const dbFilePath = config.dbFilePath || join(currentDir, "process", "tasks.json");
  return {
    ...config,
    workspacePath: currentDir,
    dbFilePath
  };
}

/**
 * Create a JSON backend with automatic workspace and storage configuration
 */
export async function createJsonBackendWithAutoConfig(config: WorkspaceResolvingJsonConfig): Promise<TaskBackend> {
  const backendConfig = await configureJsonBackend(config);
  
  log.debug("JSON backend auto-configured", {
    workspacePath: backendConfig.workspacePath,
    dbFilePath: backendConfig.dbFilePath
  });

  return new JsonFileTaskBackend(backendConfig);
}

/**
 * Convenience factory for common use cases
 */
export async function createAutoConfigJsonBackend(config: {
  name: string;
  repoUrl?: string;
  workspacePath?: string;
  dbFilePath?: string;
}): Promise<TaskBackend> {
  return createJsonBackendWithAutoConfig(config);
} 
