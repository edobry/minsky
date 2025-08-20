import { promises as fs } from "fs";
import { join } from "path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getConfiguration } from "../configuration";
import { log } from "../../utils/logger";
import { getTasksFilePath, getTaskSpecFilePath } from "./taskIO";
import { parseTasksFromMarkdown } from "./taskFunctions";

export interface ImportOptions {
  dryRun?: boolean;
  limit?: number;
  filterStatus?: string;
}

export interface ImportResultItem {
  id: string;
  backend: string | null;
  sourceTaskId: string;
  status: string;
  title: string;
  action: "insert" | "update" | "skip" | "error";
  reason?: string;
}

export interface ImportResult {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  items: ImportResultItem[];
}

function mapBackendPrefixToEnum(prefix: string): string | null {
  // Map task ID backend prefixes to DB enum values
  if (prefix === "md") return "markdown";
  if (prefix === "gh") return "github-issues";
  if (prefix === "json") return "json-file";
  return null;
}

function deriveBackendAndSource(id: string): { backend: string | null; sourceTaskId: string } {
  const [backendPrefix, local] = id.split("#");
  return { backend: mapBackendPrefixToEnum(backendPrefix), sourceTaskId: local || id };
}

export class TasksImporterService {
  constructor(private readonly workspacePath: string) {}

  async importMarkdownToDb(options: ImportOptions = {}): Promise<ImportResult> {
    const { dryRun = true, limit, filterStatus } = options;

    // 1) Read tasks markdown
    const tasksPath = getTasksFilePath(this.workspacePath);
    const tasksContent = await fs.readFile(tasksPath, "utf-8");
    const parsed = parseTasksFromMarkdown(tasksContent);

    // Optional status filter and limit
    let taskList = parsed;
    if (filterStatus) {
      taskList = taskList.filter(
        (t) => (t.status || "").toUpperCase() === filterStatus.toUpperCase()
      );
    }
    if (typeof limit === "number" && limit > 0) {
      taskList = taskList.slice(0, limit);
    }

    const cfg = await getConfiguration();
    const conn = (cfg as any)?.sessiondb?.postgres?.connectionString;
    if (!conn) throw new Error("PostgreSQL connection string not configured (sessiondb.postgres)");

    // Prepare DB connection
    const sql = postgres(conn, { prepare: false, onnotice: () => {} });
    const db = drizzle(sql);
    void db; // keep drizzle import for future typed work; using raw SQL below

    const result: ImportResult = {
      total: taskList.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      items: [],
    };

    for (const t of taskList) {
      const id = String(t.id);
      if (!id.includes("#")) {
        result.items.push({
          id,
          backend: null,
          sourceTaskId: "",
          status: String(t.status || ""),
          title: String(t.title || ""),
          action: "skip",
          reason: "unqualified-id",
        });
        result.skipped++;
        continue;
      }

      const { backend, sourceTaskId } = deriveBackendAndSource(id);

      // Read spec content if available
      const specPath = getTaskSpecFilePath(id, t.title || "", this.workspacePath);
      let specContent = "";
      try {
        specContent = await fs.readFile(specPath, "utf-8");
      } catch {
        // spec may not exist; proceed with empty content
      }

      const contentHash = await this.computeSha256(specContent || "");
      const status = String(t.status || "");
      const title = String(t.title || "");

      if (dryRun) {
        result.items.push({ id, backend, sourceTaskId, status, title, action: "insert" });
        continue;
      }

      // Try UPDATE first (avoids NOT NULL constraints on INSERT for legacy columns)
      const updateSql = `UPDATE tasks
        SET backend = $2::task_backend,
            source_task_id = $3,
            status = $4::task_status,
            title = $5,
            spec = $6,
            content_hash = $7,
            updated_at = NOW()
        WHERE id = $1`;

      const updateRes = await sql.unsafe(updateSql, [
        id,
        backend,
        sourceTaskId,
        status || null,
        title || null,
        specContent || null,
        contentHash || null,
      ]);

      const updatedCount = Array.isArray(updateRes) ? ((updateRes as any).count ?? 0) : 0;

      if (updatedCount && Number(updatedCount) > 0) {
        result.updated++;
        result.items.push({ id, backend, sourceTaskId, status, title, action: "update" });
        continue;
      }

      // Fallback: attempt INSERT (may fail if legacy NOT NULL columns remain)
      try {
        const insertSql = `INSERT INTO tasks (id, backend, source_task_id, status, title, spec, content_hash, created_at, updated_at)
          VALUES ($1, $2::task_backend, $3, $4::task_status, $5, $6, $7, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET
            backend = EXCLUDED.backend,
            source_task_id = EXCLUDED.source_task_id,
            status = EXCLUDED.status,
            title = EXCLUDED.title,
            spec = EXCLUDED.spec,
            content_hash = EXCLUDED.content_hash,
            updated_at = NOW()`;

        await sql.unsafe(insertSql, [
          id,
          backend,
          sourceTaskId,
          status || null,
          title || null,
          specContent || null,
          contentHash || null,
        ]);

        result.inserted++;
        result.items.push({ id, backend, sourceTaskId, status, title, action: "insert" });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        result.errors++;
        result.items.push({
          id,
          backend,
          sourceTaskId,
          status,
          title,
          action: "error",
          reason: message,
        });
      }
    }

    try {
      await sql.end({});
    } catch {
      // ignore
    }

    return result;
  }

  private async computeSha256(content: string): Promise<string> {
    const crypto = await import("crypto");
    return crypto.createHash("sha256").update(content).digest("hex");
  }
}
