/**
 * Simple ESLint rule fixture validation tests
 * Just ensures our fixtures contain the expected patterns
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { log } from "../utils/logger";

describe("ESLint Rule Fixtures", () => {
  test("pathological fixture contains forbidden patterns", () => {
    const pathologicalCode = readFileSync(
      join(__dirname, "__fixtures__", "pathological-fs-usage.js"),
      "utf-8"
    );

    // Verify it contains the patterns we expect to detect
    expect(pathologicalCode).toContain("import { mkdirSync");
    expect(pathologicalCode).toContain("import { mkdir");
    expect(pathologicalCode).toContain("process.cwd()");
    expect(pathologicalCode).toContain('require("fs")');
    expect(pathologicalCode).toContain("mkdirSync(testDir)");
    expect(pathologicalCode).toContain("writeFileSync(");

    // This validates the fixtures are correctly defined
    log.debug("✅ Pathological fixture contains expected forbidden patterns");
  });

  test("good fixture contains approved patterns", () => {
    const goodCode = readFileSync(join(__dirname, "__fixtures__", "good-fs-usage.js"), "utf-8");

    // Verify it contains good patterns
    expect(goodCode).toContain('mock.module("fs"');
    expect(goodCode).toContain('mock.module("fs/promises"');
    expect(goodCode).toContain("mockFs.readFileSync");
    expect(goodCode).toContain("fs: mockFileSystem");

    // Should NOT contain forbidden patterns
    expect(goodCode).not.toContain("import { mkdirSync");
    expect(goodCode).not.toContain("process.cwd()");
    expect(goodCode).not.toContain('require("fs")');

    log.debug("✅ Good fixture contains only approved patterns");
  });
});
