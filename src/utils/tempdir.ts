import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { log } from "./logger";

/**
 * Robust temp directory creation utility.
 * Tries multiple locations, verifies existence, and provides diagnostics.
 *
 * @param prefix - Prefix for the temp directory name
 * @param opts.softFail - If true, returns null instead of throwing on failure
 * @returns The path to the created temp directory, or null if softFail and all attempts fail
 */
export function createRobustTempDir(
  prefix = "minsky-test-",
  opts?: { softFail?: boolean }
): string | null {
  const locations = [
    "/tmp/minsky-test-tmp",
    process.env.SESSION_WORKSPACE ? path.join(process.env.SESSION_WORKSPACE, "test-tmp") : null,
    path.join(os.tmpdir(), "minsky-test-tmp"),
  ].filter(Boolean) as string[];

  for (const base of locations) {
    try {
      if (!fs.existsSync(base)) {
        fs.mkdirSync(base, { recursive: true });
      }
      const tempDir = fs.mkdtempSync(path.join(base, _prefix));
      if (process.env.DEBUG_TEST_UTILS) {
        log.debug(`createRobustTempDir: ${tempDir}`);
      }
      if (!fs.existsSync(tempDir)) {
        throw new Error(`[UTIL FAILURE] Temp dir was not created: ${tempDir}`);
      }
      return tempDir;
    } catch {
      log.error(
        `Failed to create temp dir at ${base} with prefix ${prefix}:`,
        err instanceof Error ? err : new Error(String(err))
      );
      // Try next location
    }
  }
  if (opts?.softFail) {
    log.warn(`All temp dir creation attempts failed for prefix '${prefix}'. Returning null.`);
    return null;
  }
  throw new Error(`All temp dir creation attempts failed for prefix '${prefix}'.`);
}

/**
 * Example usage:
 *
 *   import { createRobustTempDir } from "./tempdir";
 *   const tempDir = createRobustTempDir("my-prefix-");
 *   if (!tempDir) {
 *     // Handle failure (skip test, log warning, etc.)
 *   }
 */
