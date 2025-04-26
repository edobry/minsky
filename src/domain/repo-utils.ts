import { SessionDB } from './session';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

export interface RepoResolutionOptions {
  session?: string;
  repo?: string;
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
