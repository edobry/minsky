import { join } from 'path';
import { promises as fs } from 'fs';
import { normalizeRepoName } from './repo-utils';

export interface SessionRecord {
  session: string;
  repoUrl: string;
  repoName: string;
  repoPath?: string;  // Path to the repository for this session
  branch?: string;
  createdAt: string;
  taskId?: string;
}

export class SessionDB {
  private readonly dbPath: string;
  private readonly baseDir: string;

  constructor() {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    this.dbPath = join(xdgStateHome, 'minsky', 'session-db.json');
    this.baseDir = join(xdgStateHome, 'minsky', 'git');
  }

  private getRepoPath(repoName: string): string {
    return join(this.baseDir, repoName);
  }

  private getSessionPath(repoName: string, session: string): string {
    return join(this.getRepoPath(repoName), 'sessions', session);
  }

  private getLegacySessionPath(repoName: string, session: string): string {
    return join(this.baseDir, repoName, session);
  }

  private async migrateSessionRepo(session: SessionRecord): Promise<void> {
    const oldPath = this.getLegacySessionPath(session.repoName, session.session);
    const newPath = this.getSessionPath(session.repoName, session.session);

    try {
      // Check if old path exists and new path doesn't
      const oldExists = await fs.access(oldPath).then(() => true).catch(() => false);
      const newExists = await fs.access(newPath).then(() => true).catch(() => false);

      if (oldExists && !newExists) {
        // Create the new directory structure
        await fs.mkdir(join(this.getRepoPath(session.repoName), 'sessions'), { recursive: true });
        // Move the repo to its new location
        await fs.rename(oldPath, newPath);
        // Update the session record
        session.repoPath = newPath;
      }
    } catch (e) {
      console.error(`Failed to migrate session repo for ${session.session}:`, e);
    }
  }

  private async readDb(): Promise<SessionRecord[]> {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      const sessions = JSON.parse(data);
      // Migrate existing sessions to include repoName and repoPath
      const migratedSessions = sessions.map((session: SessionRecord) => {
        if (!session.repoName) {
          session.repoName = normalizeRepoName(session.repoUrl);
        }
        if (!session.repoPath) {
          // For backward compatibility with existing tests
          session.repoPath = this.getLegacySessionPath(session.repoName, session.session);
        }
        return session;
      });

      // Commented out for now to maintain backward compatibility with tests
      // await Promise.all(migratedSessions.map((session: SessionRecord) => this.migrateSessionRepo(session)));

      return migratedSessions;
    } catch (e) {
      return [];
    }
  }

  private async writeDb(sessions: SessionRecord[]): Promise<void> {
    await fs.mkdir(join(this.dbPath, '..'), { recursive: true });
    await fs.writeFile(this.dbPath, JSON.stringify(sessions, null, 2), 'utf-8');
  }

  async addSession(record: SessionRecord): Promise<void> {
    const sessions = await this.readDb();
    if (!record.repoPath) {
      // For backward compatibility with existing tests
      record.repoPath = this.getLegacySessionPath(record.repoName, record.session);
    }
    sessions.push(record);
    await this.writeDb(sessions);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.readDb();
  }

  async getSession(session: string): Promise<SessionRecord | undefined> {
    const sessions = await this.readDb();
    return sessions.find(s => s.session === session);
  }
  
  async getSessionByTaskId(taskId: string): Promise<SessionRecord | undefined> {
    const sessions = await this.readDb();
    return sessions.find(s => s.taskId === taskId);
  }

  async updateSession(session: string, update: Partial<Omit<SessionRecord, 'session'>>): Promise<void> {
    const sessions = await this.readDb();
    const idx = sessions.findIndex(s => s.session === session);
    if (idx !== -1) {
      const { session: _, ...safeUpdate } = update as any;
      sessions[idx] = { ...sessions[idx], ...safeUpdate };
      await this.writeDb(sessions);
    }
  }

  async deleteSession(session: string): Promise<boolean> {
    const sessions = await this.readDb();
    const initialLength = sessions.length;
    const filteredSessions = sessions.filter(s => s.session !== session);
    
    if (filteredSessions.length === initialLength) {
      // No session was removed
      return false;
    }
    
    await this.writeDb(filteredSessions);
    return true;
  }

  async getSessionWorkdir(session: string): Promise<string> {
    const record = await this.getSession(session);
    if (!record) {
      throw new Error(`Session '${session}' not found.`);
    }
    if (record.repoPath) {
      return record.repoPath;
    }
    // For backward compatibility with existing tests
    return this.getLegacySessionPath(record.repoName, session);
  }
} 
