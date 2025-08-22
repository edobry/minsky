/**
 * Fixture: Examples of good filesystem patterns that ESLint should NOT flag
 * This is NOT a test file - it's test data for the ESLint rule
 */

import { mock } from "bun:test";

// ✅ GOOD: Mock filesystem operations
mock.module("fs", () => ({
  existsSync: mock(() => true),
  readFileSync: mock(() => "mocked content"),
  writeFileSync: mock(),
}));

mock.module("fs/promises", () => ({
  readFile: mock(() => Promise.resolve("mocked content")),
  writeFile: mock(() => Promise.resolve()),
  mkdir: mock(() => Promise.resolve()),
}));

describe("good filesystem test", () => {
  // ✅ GOOD: Mock filesystem setup
  beforeEach(() => {
    // No real filesystem operations
    mockFs.setup();
  });

  it("should use mocked filesystem", () => {
    // ✅ GOOD: Using mocked filesystem
    const content = mockFs.readFileSync("/mock/file.txt");
    expect(content).toBe("mocked content");
  });

  it("should use dependency injection", () => {
    // ✅ GOOD: Dependency injection for filesystem
    const mockFileSystem = {
      readFile: mock(() => "injected content"),
      writeFile: mock(),
    };

    const result = myService.processFile("test.txt", { fs: mockFileSystem });
    expect(result).toBeDefined();
  });
});
