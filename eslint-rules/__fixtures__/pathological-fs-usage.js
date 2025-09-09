/**
 * Fixture: Examples of pathological filesystem patterns that ESLint should detect
 * This is NOT a test file - it's test data for the ESLint rule
 */

// ❌ SHOULD BE DETECTED: Forbidden filesystem imports
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { mkdir, writeFile, readFile, unlink, rm } from "fs/promises";
import { tmpdir } from "os";

// ❌ SHOULD BE DETECTED: Global counters
let testSequenceNumber = 0;
let globalCounter = 0;

describe("filesystem operations test", () => {
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
    const testDir = `/tmp/test-${Date.now()}`;
    const testFile = `${testDir}/test.txt`;

    mkdirSync(testDir);
    writeFileSync(testFile, "test content");

    expect(existsSync(testFile)).toBe(true);

    rmSync(testDir, { recursive: true });
  });

  it("should detect dynamic imports", () => {
    // ❌ SHOULD BE DETECTED: Dynamic imports of filesystem modules
    const fs = require("fs");
    const path = require("path");

    const testPath = "/tmp/dynamic-test";
    fs.mkdirSync(testPath);

    expect(fs.existsSync(testPath)).toBe(true);
  });

  it("should detect process.cwd usage", () => {
    // ❌ SHOULD BE DETECTED: process.cwd() in tests
    const currentDir = process.cwd();
    const testFile = `${currentDir}/test-file.txt`;

    fs.writeFileSync(testFile, "content");
    expect(fs.existsSync(testFile)).toBe(true);
  });
});
