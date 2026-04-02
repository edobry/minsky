/**
 * Delete operation helpers for the Markdown Task Backend.
 */

import { join } from "path";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { fileExists } from "./taskIO";

/**
 * Delete a task record from the PostgreSQL database (if available).
 * Failures are logged but never thrown.
 */
export async function deleteTaskFromDatabase(id: string): Promise<void> {
  try {
    const { PersistenceService } = await import("../persistence/service");
    const provider = PersistenceService.getProvider();
    if (provider.capabilities.sql) {
      const db = await provider.getDatabaseConnection?.();
      if (db) {
        const { tasksTable } = await import("../storage/schemas/task-embeddings");
        const { eq } = await import("drizzle-orm");
        const result = await db.delete(tasksTable).where(eq(tasksTable.id, id));
        log.debug(`Deleted task ${id} from database`, {
          rowCount: (result as any).rowCount,
        });
      }
    }
  } catch (dbError) {
    log.debug(`Could not delete task ${id} from database: ${getErrorMessage(dbError as any)}`);
  }
}

/**
 * Delete a task specification file if it exists.
 * Failures are logged but never thrown.
 */
export async function deleteSpecFile(specPath: string, workspacePath: string): Promise<void> {
  try {
    const fullSpecPath = specPath.startsWith("/") ? specPath : join(workspacePath, specPath);
    if (await fileExists(fullSpecPath)) {
      const { unlink } = await import("fs/promises");
      await unlink(fullSpecPath);
      log.debug(`Deleted spec file: ${fullSpecPath}`);
    }
  } catch (error) {
    log.debug(`Could not delete spec file: ${getErrorMessage(error)}`);
  }
}
