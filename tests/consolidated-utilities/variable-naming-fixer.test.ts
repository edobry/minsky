#!/usr/bin/env bun

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { createMockFilesystem } from "../../src/utils/test-utils/filesystem/mock-filesystem";

// Import the consolidated utility
import { VariableNamingFixer } from "../../codemods/variable-naming-fixer-consolidated";

describe.skip("Variable Naming Fixer Consolidated", () => {
  let mockFs: ReturnType<typeof createMockFilesystem>;
  let fixer: VariableNamingFixer;

  // Static mock paths to prevent environment dependencies
  const mockTestDir = "/mock/tmp/variable-naming-test";

  beforeEach(() => {
    // Create isolated mock filesystem for each test
    mockFs = createMockFilesystem();

    // Use mock.module() to mock filesystem operations
    mock.module("fs", () => ({
      mkdtempSync: () => mockTestDir,
      rmSync: mockFs.rmSync,
      writeFileSync: mockFs.writeFileSync,
      readFileSync: mockFs.readFileSync,
      existsSync: mockFs.existsSync,
      mkdirSync: mockFs.mkdirSync,
    }));

    // Ensure mock test directory exists
    mockFs.ensureDirectoryExists(mockTestDir);

    fixer = new VariableNamingFixer();
  });

  afterEach(() => {
    // Clean up using mock filesystem
    try {
      mockFs.cleanup();
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("Underscore Prefix Mismatches", () => {
    it("should fix parameter definitions with underscores when usage has no underscore", async () => {
      const testFilePath = join(mockTestDir, "test1.ts");
      const content = `
function test(_param: string) {
  console.log(param); // Error: param is not defined
  return param;
}`;

      const expected = `
function test(param: string) {
  console.log(param); // Fixed: removed underscore from parameter
  return param;
}`;

      // Use mock filesystem instead of real filesystem
      mockFs.writeFile(testFilePath, content);

      await fixer.processSingleFile(testFilePath);
      const result = mockFs.readFile(testFilePath);

      expect(result.trim()).toBe(expected.trim());
    });

    it("should fix variable declarations with underscores when usage has no underscore", async () => {
      const testFilePath = join(mockTestDir, "test2.ts");
      const content = `
const _value = getData();
console.log(value); // Error: value is not defined
`;

      const expected = `
const value = getData();
console.log(value); // Fixed: removed underscore from declaration
`;

      // Use mock filesystem instead of real filesystem
      mockFs.writeFile(testFilePath, content);

      await fixer.processSingleFile(testFilePath);
      const result = mockFs.readFile(testFilePath);

      expect(result.trim()).toBe(expected.trim());
    });

    it("should fix destructuring patterns with underscore prefixes", async () => {
      const testFilePath = join(mockTestDir, "test3.ts");
      const content = `
const { _data, _status } = response;
if (data && status) {
  console.log(data, status);
}`;

      const expected = `
const { data, status } = response;
if (data && status) {
  console.log(data, status);
}`;

      // Use mock filesystem instead of real filesystem
      mockFs.writeFile(testFilePath, content);

      await fixer.processSingleFile(testFilePath);
      const result = mockFs.readFile(testFilePath);

      expect(result.trim()).toBe(expected.trim());
    });

    it("should fix array destructuring with underscore prefixes", async () => {
      const testFilePath = join(mockTestDir, "test4.ts");
      const content = `
const [_first, _second] = items;
return first + second;
`;

      const expected = `
const [first, second] = items;
return first + second;
`;

      // Use mock filesystem instead of real filesystem
      mockFs.writeFile(testFilePath, content);

      await fixer.processSingleFile(testFilePath);
      const result = mockFs.readFile(testFilePath);

      expect(result.trim()).toBe(expected.trim());
    });

    it("should handle multiple parameter mismatches in same function", async () => {
      const testFilePath = join(mockTestDir, "test5.ts");
      const content = `
function process(_input: string, _options: object) {
  if (input && options) {
    return processData(input, options);
  }
}`;

      const expected = `
function process(input: string, options: object) {
  if (input && options) {
    return processData(input, options);
  }
}`;

      // Use mock filesystem instead of real filesystem
      mockFs.writeFile(testFilePath, content);

      await fixer.processSingleFile(testFilePath);
      const result = mockFs.readFile(testFilePath);

      expect(result.trim()).toBe(expected.trim());
    });

    it("should preserve intentionally unused parameters with underscores", async () => {
      const testFilePath = join(mockTestDir, "test6.ts");
      const content = `
function handler(_event: Event, data: string) {
  // _event is intentionally unused, should keep underscore
  return data.toUpperCase();
}`;

      // Use mock filesystem instead of real filesystem
      mockFs.writeFile(testFilePath, content);

      await fixer.processSingleFile(testFilePath);
      const result = mockFs.readFile(testFilePath);

      // Should remain unchanged since _event is truly unused
      expect(result.trim()).toBe(content.trim());
    });
  });

  describe("Edge Cases", () => {
    it("should handle complex nested patterns", async () => {
      const testFilePath = join(mockTestDir, "test7.ts");
      const content = `
const { _metadata: { _title, _author } } = book;
console.log(title, author);
`;

      // Use mock filesystem instead of real filesystem
      mockFs.writeFile(testFilePath, content);

      await fixer.processSingleFile(testFilePath);
      const result = mockFs.readFile(testFilePath);

      // Should fix the nested destructuring patterns
      expect(result).toContain("title, author");
      expect(result).not.toContain("_title, _author");
    });

    it("should handle TypeScript type annotations correctly", async () => {
      const testFilePath = join(mockTestDir, "test8.ts");
      const content = `
function typedFunction(_param: { id: string; name: string }) {
  return param.id + param.name;
}`;

      const expected = `
function typedFunction(param: { id: string; name: string }) {
  return param.id + param.name;
}`;

      // Use mock filesystem instead of real filesystem
      mockFs.writeFile(testFilePath, content);

      await fixer.processSingleFile(testFilePath);
      const result = mockFs.readFile(testFilePath);

      expect(result.trim()).toBe(expected.trim());
    });
  });

  describe("Multiple Variable Patterns", () => {
    it("should handle multiple variables in single file correctly", async () => {
      const testFilePath = join(mockTestDir, "complex-test.ts");

      const content = `
function complexFunction(_input: string, _options: Options) {
  const _processed = processInput(input);
  const { _result, _errors } = validateData(processed);
  
  if (result && !errors.length) {
    return result;
  }
  
  return null;
}`;

      // Use mock filesystem instead of real filesystem
      mockFs.writeFile(testFilePath, content);

      await fixer.processSingleFile(testFilePath);
      const finalResult = mockFs.readFile(testFilePath);

      // All underscores should be removed from definitions since variables are used
      expect(finalResult).toContain("function complexFunction(input: string, options: Options)");
      expect(finalResult).toContain("const processed = processInput(input);");
      expect(finalResult).toContain("const { result, errors } = validateData(processed);");
      expect(finalResult).not.toContain("_input");
      expect(finalResult).not.toContain("_options");
      expect(finalResult).not.toContain("_processed");
      expect(finalResult).not.toContain("_result");
      expect(finalResult).not.toContain("_errors");
    });
  });
});
