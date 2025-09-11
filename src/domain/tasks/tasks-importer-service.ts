import { promises as fs } from "fs";
import { join } from "path";
import { drizzle } from "drizzle-orm/postgres-js";
import { log } from "../../utils/logger";
import { getTasksFilePath, getTaskSpecFilePath } from "./taskIO";
import { parseTasksFromMarkdown } from "./taskFunctions";
import type { PersistenceProvider } from "../persistence/types";

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

function deriveBackendAndSource(id: string): { backend: string; sourceTaskId: string } {
  const parts = id.split("#");
  if (parts.length !== 2) {
    throw new Error(`Invalid qualified task ID: ${id}`);
  }
  const prefix = parts[0];
  const sourceTaskId = parts[1];

  const backendMap: Record<string, string> = {
    md: "markdown",
    gi: "github-issues",
    db: "db",
    jf: "json-file",
  };

  const backend = backendMap[prefix];
  if (!backend) {
    throw new Error(`Unknown task ID prefix: ${prefix}`);
  }

  return { backend, sourceTaskId };
}

export class TasksImporterService {
  constructor(
    private readonly workspacePath: string,
    private readonly persistenceProvider?: PersistenceProvider
  ) {}

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

    // Use injected provider or fall back to singleton access (legacy compatibility)
    let provider = this.persistenceProvider;
    if (!provider) {
      const { PersistenceService } = await import("../persistence/service");
      provider = PersistenceService.getProvider();
    }

    if (!provider.capabilities.sql) {
      throw new Error("Current persistence provider does not support SQL operations");
    }

    const sql = await provider.getRawSqlConnection?.();
    const db = await provider.getDatabaseConnection?.();

    if (!sql) {
      throw new Error("Failed to get raw SQL connection from persistence provider");
    }
    if (!db) {
      throw new Error("Failed to get database connection from persistence provider");
    }

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

      const status = String(t.status || "");
      const title = String(t.title || "");

      if (dryRun) {
        result.items.push({ id, backend, sourceTaskId, status, title, action: "insert" });
        continue;
      }

      try {
        // Use the new 3-table schema approach
        await sql.begin(async (sql) => {
          // 1. Insert/update task metadata in tasks table (NO spec column)
          const upsertTaskSql = `
            INSERT INTO tasks (id, backend, source_task_id, status, title, created_at, updated_at)
            VALUES ($1, $2::task_backend, $3, $4::task_status, $5, NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET
              backend = EXCLUDED.backend,
              source_task_id = EXCLUDED.source_task_id,
              status = EXCLUDED.status,
              title = EXCLUDED.title,
              updated_at = NOW()`;

          await sql.unsafe(upsertTaskSql, [
            id,
            backend,
            sourceTaskId,
            status || null,
            title || null,
          ]);

          // 2. Insert/update spec content in task_specs table
          if (specContent) {
            const upsertSpecSql = `
              INSERT INTO task_specs (task_id, content, version, created_at, updated_at)
              VALUES ($1, $2, 1, NOW(), NOW())
              ON CONFLICT (task_id) DO UPDATE SET
                content = EXCLUDED.content,
                version = task_specs.version + 1,
                updated_at = NOW()`;

            await sql.unsafe(upsertSpecSql, [id, specContent]);
          }
        });

        // Determine if this was an insert or update by checking if task existed
        const checkExistsSql = `SELECT 1 FROM tasks WHERE id = $1 AND created_at = updated_at`;
        const isNewTask = await sql.unsafe(checkExistsSql, [id]);

        if (Array.isArray(isNewTask) && isNewTask.length > 0) {
          result.inserted++;
          result.items.push({ id, backend, sourceTaskId, status, title, action: "insert" });
        } else {
          result.updated++;
          result.items.push({ id, backend, sourceTaskId, status, title, action: "update" });
        }
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

    // Connection is managed by PersistenceProvider, don't close it directly

    return result;
  }
}
