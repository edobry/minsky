import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFilePromise = promisify(execFile);

/**
 * Class for running tests to verify migrations
 */
export class TestRunner {
  /**
   * Run a test file with Bun
   *
   * @param filePath Path to test file
   * @param timeout Timeout in milliseconds
   * @returns Whether the test passed
   */
  async runTest(filePath: string, timeout = 30000): Promise<boolean> {
    try {
      // Check that the file exists
      if (!fs.existsSync(filePath)) {
        console.error(`Test file not found: ${filePath}`);
        return false;
      }

      // Create a temporary directory for the test
      const tmpDir = path.join(process.cwd(), ".test-migration-tmp");
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }

      // Get the absolute path to the test file
      const absolutePath = path.resolve(filePath);

      // Run the test with Bun
      console.log(`Running test: ${absolutePath}`);

      const { stdout, stderr } = await execFilePromise("bun", ["test", absolutePath], {
        timeout,
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test",
          BUN_ENV: "test",
        },
      });

      // Check for test failures
      if (stderr && stderr.includes("fail")) {
        console.error(`Test failed: ${filePath}`);
        console.error(stderr);
        return false;
      }

      // Test passed
      console.log(`Test passed: ${filePath}`);
      return true;
    } catch (error) {
      console.error(`Error running test ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Run multiple test files in batch
   *
   * @param filePaths Array of test file paths
   * @param timeout Timeout in milliseconds
   * @returns Object with results for each file
   */
  async runTestBatch(filePaths: string[], timeout = 30000): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    // Test files sequentially to avoid interference
    for (const filePath of filePaths) {
      results[filePath] = await this.runTest(filePath, timeout);
    }

    return results;
  }

  /**
   * Compare test results before and after migration
   *
   * @param beforeResults Test results before migration
   * @param afterResults Test results after migration
   * @returns Analysis of result changes
   */
  compareResults(
    beforeResults: Record<string, boolean>,
    afterResults: Record<string, boolean>
  ): {
    improved: string[];
    regressed: string[];
    unchanged: string[];
  } {
    const improved: string[] = [];
    const regressed: string[] = [];
    const unchanged: string[] = [];

    for (const filePath in beforeResults) {
      if (!(filePath in afterResults)) continue;

      const before = beforeResults[filePath];
      const after = afterResults[filePath];

      if (before === after) {
        unchanged.push(filePath);
      } else if (!before && after) {
        improved.push(filePath);
      } else if (before && !after) {
        regressed.push(filePath);
      }
    }

    return { improved, regressed, unchanged };
  }
}
