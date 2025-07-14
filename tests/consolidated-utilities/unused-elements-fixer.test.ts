#!/usr/bin/env bun

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Import the consolidated utility
import { UnusedElementsFixer } from "../../codemods/unused-elements-fixer-consolidated";

describe("Unused Elements Fixer Consolidated", () => {
  let testDir: string;
  let fixer: UnusedElementsFixer;

  beforeEach(() => {
    // Create temporary test directory
    testDir = mkdtempSync(join(tmpdir(), "unused-elements-test-"));
    fixer = new UnusedElementsFixer();
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Unused Variables", () => {
    it("should remove unused variable declarations", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
const used = "hello";
const unused = "world";
console.log(used);`;

      const expectedCode = `
const used = "hello";
console.log(used);`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });

    it("should remove unused function parameters", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
function test(used: string, unused: number) {
  return used.length;
}`;

      const expectedCode = `
function test(used: string) {
  return used.length;
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });

    it("should remove unused imports", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
import { used, unused } from "./module";
import { anotherUnused } from "./other";
console.log(used);`;

      const expectedCode = `
import { used } from "./module";
console.log(used);`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });
  });

  describe("Boundary Validation - Should NOT Remove", () => {
    it("should NOT remove variables with underscore prefix (intentionally unused)", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
const _intentionallyUnused = "keep me";
const used = "hello";
console.log(used);`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });

    it("should NOT remove exports", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
export const exportedButNotUsedHere = "keep me";
const used = "hello";
console.log(used);`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });

    it("should NOT remove type definitions", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
interface UnusedInterface {
  value: string;
}
type UnusedType = string;
const used = "hello";
console.log(used);`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });

    it("should NOT remove variables used in closures", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
function outer() {
  const capturedVar = "captured";
  return function inner() {
    return capturedVar;
  };
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(originalCode.trim());
    });
  });

  describe("Complex Scenarios", () => {
    it("should handle destructuring correctly", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
const { used, unused } = getData();
console.log(used);`;

      const expectedCode = `
const { used } = getData();
console.log(used);`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });

    it("should handle function expressions and arrow functions", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
const callback = (used: string, unused: number) => {
  return used.length;
};
const func = function(used: string, unused: number) {
  return used.toUpperCase();
};`;

      const expectedCode = `
const callback = (used: string) => {
  return used.length;
};
const func = function(used: string) {
  return used.toUpperCase();
};`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });

    it("should handle class properties and methods", () => {
      const testFile = join(testDir, "test.ts");
      const originalCode = `
class TestClass {
  private usedProperty = "used";
  private unusedProperty = "unused";
  
  public usedMethod() {
    return this.usedProperty;
  }
  
  private unusedMethod() {
    return "unused";
  }
}`;

      const expectedCode = `
class TestClass {
  private usedProperty = "used";
  
  public usedMethod() {
    return this.usedProperty;
  }
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });
  });

  describe("Error Handling", () => {
    it("should handle files with syntax errors gracefully", () => {
      const testFile = join(testDir, "broken.ts");
      const brokenCode = `
const used = "hello";
const unused = "world"
console.log(used; // Syntax error`;

      writeFileSync(testFile, brokenCode);
      
      // Should not throw
      expect(() => {
        fixer.processFiles(`${testDir}/**/*.ts`);
      }).not.toThrow();
      
      // File should remain unchanged due to syntax error
      const unchangedCode = readFileSync(testFile, "utf-8");
      expect(unchangedCode.trim()).toBe(brokenCode.trim());
    });

    it("should handle empty files gracefully", () => {
      const testFile = join(testDir, "empty.ts");
      const emptyCode = "";

      writeFileSync(testFile, emptyCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const unchangedCode = readFileSync(testFile, "utf-8");
      expect(unchangedCode).toBe(emptyCode);
    });
  });

  describe("Performance and Metrics", () => {
    it("should provide accurate metrics", () => {
      const testFile = join(testDir, "metrics.ts");
      const originalCode = `
const used = "hello";
const unused1 = "world";
const unused2 = "test";
console.log(used);`;

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
      const metricsLog = logs.find(log => log.includes("Unused Elements Fix Results"));
      expect(metricsLog).toBeDefined();
      
      const removalsLog = logs.find(log => log.includes("Total unused elements removed"));
      expect(removalsLog).toContain("2"); // Should have removed 2 unused variables
    });
  });

  describe("Integration with AST Analysis", () => {
    it("should properly handle TypeScript-specific syntax", () => {
      const testFile = join(testDir, "typescript-syntax.ts");
      const originalCode = `
interface Config {
  value: string;
}

function test<T>(used: T, unused: Config): T {
  return used;
}`;

      const expectedCode = `
interface Config {
  value: string;
}

function test<T>(used: T): T {
  return used;
}`;

      writeFileSync(testFile, originalCode);
      
      fixer.processFiles(`${testDir}/**/*.ts`);
      
      const fixedCode = readFileSync(testFile, "utf-8");
      expect(fixedCode.trim()).toBe(expectedCode.trim());
    });
  });
}); 
