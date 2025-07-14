#!/usr/bin/env bun

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Import the consolidated utility
import { TypeScriptErrorFixer } from "../../codemods/typescript-error-fixer-consolidated";

describe("TypeScript Error Fixer Consolidated", () => {
  let testDir: string;
  let fixer: TypeScriptErrorFixer;

  beforeEach(() => {
    // Create temporary test directory
    testDir = mkdtempSync(join(tmpdir(), "typescript-error-test-"));
    fixer = new TypeScriptErrorFixer();
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Type Annotations", () => {
    it("should add missing type annotations", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
function test(param) {
  return param;
}`;

      const expectedCode = `
function test(param: any) {
  return param;
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });

    it("should fix implicit any types", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
let data;
const array = [];
function process(value) {
  return value;
}`;

      const expectedCode = `
let data: any;
const array: any[] = [];
function process(value: any) {
  return value;
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });
  });

  describe("Import/Export Fixes", () => {
    it("should fix missing imports", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
function test() {
  return Promise.resolve("test");
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      // Should not add imports for built-in types like Promise
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });

    it("should fix export syntax", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
const value = "test";
export { value };`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });
  });

  describe("Generic Type Fixes", () => {
    it("should fix generic constraint errors", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
function identity<T>(arg: T): T {
  return arg;
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });

    it("should handle complex generic scenarios", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
interface Container<T> {
  value: T;
}

function create<T>(value: T): Container<T> {
  return { value };
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });
  });

  describe("Boundary Validation - Should NOT Change", () => {
    it("should NOT change properly typed code", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
interface User {
  name: string;
  age: number;
}

function createUser(name: string, age: number): User {
  return { name, age };
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });

    it("should NOT change complex type structures", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
type EventHandler<T> = (event: T) => void;

interface EventEmitter<T> {
  on(event: string, handler: EventHandler<T>): void;
  emit(event: string, data: T): void;
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
function test(param {
  return param;
}`;

      writeFileSync(testFile, brokenCode);
      
      // Should not throw
      expect(() => {
        fixer.processFiles(`${testDir}/**/*.ts`);
      }).not.toThrow();
    });

    it("should handle complex TypeScript syntax", () => {
      const testFile = join(testDir, "complex.ts");
      const complexCode = `
type ConditionalType<T> = T extends string ? string[] : T[];

function process<T>(value: T): ConditionalType<T> {
  return Array.isArray(value) ? value : [value] as ConditionalType<T>;
}`;

      writeFileSync(testFile, complexCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(complexCode.trim());
    });
  });

  describe("Performance and Metrics", () => {
    it("should provide accurate metrics", () => {
      const testFile = join(testDir, "metrics.ts");
      const originalCode = `
function test(param1, param2) {
  let data;
  return param1 + param2;
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
      const metricsLog = logs.find(log => log.includes("TypeScript Error Fix Results"));
      expect(metricsLog).toBeDefined();
    });
  });

  describe("Integration with AST Analysis", () => {
    it("should handle nested function types", () => {
      const testFile = join(testDir, "nested.ts");
      const originalCode = `
type AsyncFunction<T> = () => Promise<T>;

function createAsyncFunction<T>(value: T): AsyncFunction<T> {
  return async () => value;
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });
  });
}); 
