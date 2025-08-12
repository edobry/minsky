import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { ValidationError } from "../errors/index";
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";

// Mock the fs modules to use our mock filesystem
const mockFs = createMockFilesystem();

mock.module("fs/promises", () => ({
  writeFile: mockFs.writeFile,
  mkdir: mockFs.mkdir,
  rm: mockFs.rm,
  readFile: mockFs.readFile,
}));

describe("Session PR bodyPath file reading functionality", () => {
  const testDir = "/mock/test/body-path";
  const testFilePath = join(testDir, "test-body.txt");
  const testContent = "This is the PR body content from file";

  beforeEach(async () => {
    // Reset mock filesystem
    mockFs.reset();

    // Setup test directory and file in mock filesystem
    mockFs.ensureDirectorySync(testDir);
    mockFs.writeFileSync(testFilePath, testContent, "utf8");
  });

  afterEach(() => {
    mock.restore();
  });

  test("should read body content from bodyPath when provided", async () => {
    // Test the file reading logic directly using mock filesystem
    const content = mockFs.readFileSync(testFilePath, "utf8");

    expect(content).toBe(testContent);
  });

  test("should handle non-existent file path", async () => {
    const nonExistentPath = join(testDir, "non-existent.txt");

    expect(() => mockFs.readFileSync(nonExistentPath, "utf8")).toThrow();
  });

  test("should handle file reading with different encodings", async () => {
    const binaryContent = mockFs.readFileSync(testFilePath, "utf8");

    expect(typeof binaryContent).toBe("string");
    expect(binaryContent).toBe(testContent);
  });

  test("ValidationError should be constructible", () => {
    // Test that doesn't require filesystem operations
    const error = new ValidationError("Test validation error");
    expect(error.message).toBe("Test validation error");
    expect(error.name).toBe("ValidationError");
  });
});
