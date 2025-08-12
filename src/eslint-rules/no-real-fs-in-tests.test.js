/**
 * Test file to verify no-real-fs-in-tests ESLint rule functionality
 * This file contains examples of pathological patterns that should be detected
 */

// ❌ SHOULD BE DETECTED: Forbidden filesystem imports
// Use mock.module() to mock filesystem operations
// import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
// Use mock.module() to mock filesystem operations
// import { mkdir, writeFile, readFile, unlink, rm } from "fs/promises";
import { tmpdir } from "os";

// ❌ SHOULD BE DETECTED: Global counters
let testSequenceNumber = 0;
let globalCounter = 0;

describe.skip("filesystem operations test", () => {
  // ❌ SHOULD BE DETECTED: Real filesystem in test hooks
  beforeEach(async () => {
    const sequence = ++testSequenceNumber; // Race condition!
    await mkdir(testDir, { recursive: true }); // Race condition!
    await writeFile(testFile, "data"); // Filesystem conflict!
  });

  afterEach(async () => {
    await rmSync(testDir, { recursive: true }); // Cleanup race condition!
  });

  it("should detect filesystem operations", () => {
    // ❌ SHOULD BE DETECTED: Non-unique timestamp patterns
    const testDir = join(tmpdir(), `test-${Date.now()}`); // Race condition!
    const uniqueId = `${Date.now()}-${Math.random()}`; // Still not unique in parallel!

    // ❌ SHOULD BE DETECTED: Real filesystem operations
    mkdirSync(testDir);
    writeFileSync(join(testDir, "test.txt"), "content");
    const content = readFileSync(join(testDir, "test.txt"), "utf8");

    expect(content).toBe("content");
  });

  it("should detect dynamic imports", async () => {
    // ❌ SHOULD BE DETECTED: Dynamic imports in test files
    const { someFunction } = await import("../module"); // Can cause infinite loops
    const module = require("../dynamic-module"); // Problematic in test context

    expect(someFunction).toBeDefined();
  });

  it("should detect process.cwd usage", () => {
    // ❌ SHOULD BE DETECTED: process.cwd() for path creation
    const workspaceDir = process.cwd();
    const testPath = join(workspaceDir, "test-data");

    expect(testPath).toContain("test-data");
  });
});
