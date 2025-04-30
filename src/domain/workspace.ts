/**
 * Resolve the main workspace path for task operations
 * This ensures task operations are performed in the main workspace
 * even when executed from a session repository
 * 
 * Resolution strategy:
 * 1. Use explicitly provided workspace path if available
 * 2. If in a session repo, use the main workspace path
 * 3. Use current directory as workspace
 */
export async function resolveWorkspacePath(options?: WorkspaceResolutionOptions): Promise<string> {
  // If workspace path is explicitly provided, use it
  if (options?.workspace) {
    // Validate if it's a valid workspace
    try {
      const processDir = join(options.workspace, 'process');
      await fs.access(processDir);
      return options.workspace;
    } catch (error) {
      throw new Error(`Invalid workspace path: ${options.workspace}. Path must be a valid Minsky workspace.`);
    }
  }
  
  // Check if current or provided path is a session repository
  const checkPath = options?.sessionRepo || process.cwd();
  const sessionInfo = await getSessionFromRepo(checkPath);
  
  if (sessionInfo) {
    // Strip file:// protocol if present
    let mainWorkspace = sessionInfo.mainWorkspace;
    if (mainWorkspace.startsWith('file://')) {
      mainWorkspace = mainWorkspace.replace(/^file:\/\//, '');
    }
    return mainWorkspace;
  }
  
  // If not in a session repo, use current directory
  return checkPath;
} 
