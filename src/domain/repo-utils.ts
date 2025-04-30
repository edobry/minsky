import { SessionDB } from './session';
import { exec } from 'child_process';
import { promisify } from 'util';
import { basename } from 'path';
const execAsync = promisify(exec);

export interface RepoResolutionOptions {
  session?: string;
  repo?: string;
}

/**
 * Normalizes a repository URL or path into a standardized format.
 * For remote URLs: org/project (e.g., github.com/org/project.git -> org/project)
 * For local paths: local/project (e.g., /Users/edobry/Projects/minsky -> local/minsky)
 */
export function normalizeRepoName(repoUrl: string): string {
  // Handle file:// URLs
  if (repoUrl.startsWith('file://')) {
    const path = repoUrl.replace(/^file:\/\//, '');
    return `local/${basename(path)}`;
  }

  // Check if it's a remote URL
  if (repoUrl.includes('://') || repoUrl.includes('@')) {
    // Extract org and project from remote URL
    const match = repoUrl.match(/[:/]([^/]+)\/([^/]+?)(\.git)?$/);
    if (match) {
      const [, org, project] = match;
      return `${org}/${project}`;
    }
  }
  
  // For local paths, use local/<basename>
  return `local/${basename(repoUrl)}`;
}

export async function resolveRepoPath(options: RepoResolutionOptions): Promise<string> {
  if (options.repo) {
    return options.repo;
  }
  if (options.session) {
    const db = new SessionDB();
    const record = await db.getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }
    return record.repoUrl;
  }
  // Fallback: use current git repo
  const { stdout } = await execAsync('git rev-parse --show-toplevel');
  return stdout.trim();
} 
