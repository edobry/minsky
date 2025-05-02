import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { normalizeRepoName } from "./repo-utils";

export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
}

export class SessionDB {
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    if (dbPath) {
      this.dbPath = dbPath;
    } else {
      const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
      this.dbPath = join(xdgStateHome, "minsky", "session-db.json");
    }
  }

  private async ensureDbDir(): Promise<void> {
    const dbDir = join(this.dbPath, "..");
    await mkdir(dbDir, { recursive: true });
  }

  private async readDb(): Promise<SessionRecord[]> {
    if (!existsSync(this.dbPath)) {
      return [];
    }
    const data = await readFile(this.dbPath, "utf8");
    const sessions = JSON.parse(data);
    // Migrate existing sessions to include repoName
    return sessions.map((session: SessionRecord) => {
      if (!session.repoName) {
        session.repoName = normalizeRepoName(session.repoUrl);
      }
      return session;
    });
  }

  private async writeDb(sessions: SessionRecord[]): Promise<void> {
    await this.ensureDbDir();
    await writeFile(this.dbPath, JSON.stringify(sessions, null, 2));
  }

  async addSession(record: SessionRecord): Promise<void> {
    const sessions = await this.readDb();
    sessions.push(record);
    await this.writeDb(sessions);
  }

  async getSession(session: string): Promise<SessionRecord | null> {
    const sessions = await this.readDb();
    return sessions.find(s => s.session === session) || null;
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    const sessions = await this.readDb();
    return sessions.find(s => s.taskId === taskId) || null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.readDb();
  }

  async updateSession(session: string, updates: Partial<Omit<SessionRecord, "session">>): Promise<void> {
    const sessions = await this.readDb();
    const index = sessions.findIndex(s => s.session === session);
    if (index !== -1) {
      const { session: _, ...safeUpdates } = updates as any;
      sessions[index] = { ...sessions[index], ...safeUpdates };
      await this.writeDb(sessions);
    }
  }

  async deleteSession(session: string): Promise<boolean> {
    const sessions = await this.readDb();
    const index = sessions.findIndex(s => s.session === session);
    if (index === -1) {
      return false;
    }
    sessions.splice(index, 1);
    await this.writeDb(sessions);
    return true;
  }
}
