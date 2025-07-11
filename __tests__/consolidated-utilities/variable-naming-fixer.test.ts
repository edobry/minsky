#!/usr/bin/env bun

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Import the consolidated utility
import { VariableNamingFixer } from "../../codemods/variable-naming-fixer-consolidated";

describe("Variable Naming Fixer Consolidated", () => {
  let testDir: string;
  let fixer: VariableNamingFixer;

  beforeEach(() => {
    // Create temporary test directory
    testDir = mkdtempSync(join(tmpdir(), "variable-naming-test-"));
    fixer = new VariableNamingFixer();
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Underscore Prefix Mismatches", () => {
    it("should fix parameter definitions with underscores when usage has no underscore", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
function processData(_data: unknown) {
  console.log(data.length);
  return data.toString();
}`;

      const expectedCode = `
function processData(data: unknown) {
  console.log(data.length);
  return data.toString();
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });

    it("should fix variable declarations with underscores when usage has no underscore", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
const _result = fetchData();
console.log(result.status);
return result.data;`;

      const expectedCode = `
const result = fetchData();
console.log(result.status);
return result.data;`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });

    it("should handle destructuring with underscore mismatches", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
const { _name, _age } = person;
console.log(name, age);`;

      const expectedCode = `
const { name, age } = person;
console.log(name, age);`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });
  });

  describe("Boundary Validation - Should NOT Change", () => {
    it("should NOT change intentionally unused parameters with underscores", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
function handler(_unusedEvent: Event, data: unknown) {
  return data;
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });

    it("should NOT change variables that are used with underscores consistently", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
const _privateVar = getValue();
console.log(_privateVar);
return _privateVar.data;`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });

    it("should NOT change underscore patterns in strings or comments", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
// This is about _someVariable
const message = "Use _parameter for private vars";
const regex = /_[a-z]+/g;`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });

    it("should handle scope correctly - same variable names in different scopes", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
function outer(_data: unknown) {
  // _data is unused here - should stay with underscore
  function inner(data: unknown) {
    return data.length; // data is used here - no underscore needed
  }
  return inner;
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });
  });

  describe("Error Handling", () => {
    it("should handle files with syntax errors gracefully", () => {
      const testFile = join(testDir, "broken.ts");
      const brokenCode = `
function test(_param: unknown) {
  return param.
}; // Syntax error`;

      writeFileSync(testFile, brokenCode);
      
      // Should not throw
      expect(() => {
        fixer.processFiles(`${testDir}/**/*.ts`);
      }).not.toThrow();
      
      // File should remain unchanged due to syntax error
      const unchangedCode = readFileSync(testFile, "utf-8");
      expect(unchangedCode.trim()).toBe(brokenCode.trim());
    });

    it("should handle non-existent patterns gracefully", () => {
      const testFile = join(testDir, "clean.ts");
      const cleanCode = `
function test(param: unknown) {
  return param.toString();
}`;

      writeFileSync(testFile, cleanCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const unchangedCode = readFileSync(testFile, "utf-8");
      expect(unchangedCode.trim()).toBe(cleanCode.trim());
    });
  });

  describe("Complex Scenarios", () => {
    it("should handle mixed scenarios correctly", () => {
      const testFile = join(testDir, "mixed.ts");
      const originalCode = `
function complex(_config: Config, data: Data) {
  // _config is unused, should stay with underscore
  const _result = processData(data);
  console.log(result.status); // result used without underscore
  
  const { _name, age } = data;
  console.log(name); // name used without underscore
  console.log(age);  // age used consistently
  
  return result;
}`;

      const expectedCode = `
function complex(_config: Config, data: Data) {
  // _config is unused, should stay with underscore
  const result = processData(data);
  console.log(result.status); // result used without underscore
  
  const { name, age } = data;
  console.log(name); // name used without underscore
  console.log(age);  // age used consistently
  
  return result;
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });
  });

  describe("Performance and Metrics", () => {
    it("should provide accurate metrics", () => {
      const testFile = join(testDir, "metrics.ts");
      const originalCode = `
function test(_param: unknown, _another: string) {
  console.log(param, another);
  return param + another;
}`;

      writeFileSync(testFile, originalCode);
      
      // Mock the console.log to capture metrics
      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      console.log = originalLog;
      
      // Check that metrics were logged
      const metricsLog = logs.find(log => log.includes("Variable Naming Fix Results"));
      expect(metricsLog).toBeDefined();
      
      const fixesLog = logs.find(log => log.includes("Total fixes applied"));
      expect(fixesLog).toContain("2"); // Should have fixed 2 variables
    });
  });

  describe("Integration with AST Analysis", () => {
    it("should properly parse TypeScript files with complex syntax", () => {
      const testFile = join(testDir, "complex-syntax.ts");
      const originalCode = `
interface Config {
  _value: string;
}

function test<T>(_generic: T): Promise<T> {
  const _typed: T = _generic;
  return Promise.resolve(typed);
}`;

      const expectedCode = `
interface Config {
  _value: string;
}

function test<T>(_generic: T): Promise<T> {
  const typed: T = _generic;
  return Promise.resolve(typed);
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });
  });
}); 
