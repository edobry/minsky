import { join } from 'path';
import { promises as fs } from 'fs';

export interface SessionRecord {
  session: string;
  repoUrl: string;
  branch?: string;
  createdAt: string;
}

export class SessionDB {
  private readonly dbPath: string;

  constructor() {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    this.dbPath = join(xdgStateHome, 'minsky', 'session-db.json');
  }

  private async readDb(): Promise<SessionRecord[]> {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      return JSON.parse(data);
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

  async updateSession(session: string, update: Partial<Omit<SessionRecord, 'session'>>): Promise<void> {
    const sessions = await this.readDb();
    const idx = sessions.findIndex(s => s.session === session);
    if (idx !== -1) {
      const { session: _, ...safeUpdate } = update as any;
      sessions[idx] = { ...sessions[idx], ...safeUpdate };
      await this.writeDb(sessions);
    }
  }
} 
