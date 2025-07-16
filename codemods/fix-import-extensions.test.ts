#!/usr/bin/env bun

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { Project } from "ts-morph";
import { ImportExtensionFixer, ImportFixResult, ImportFixMetrics } from "./fix-import-extensions";

/**
 * Test Suite for Import Extension Fixer
 *
 * Comprehensive test coverage following established codemod testing patterns:
 * - Unit tests for individual transformation functions
 * - Integration tests for full codemod execution
 * - Edge case tests for boundary conditions
 * - Performance benchmarks for processing metrics
 *
 * Test Structure:
 * - Isolated temporary directories for each test
 * - Realistic TypeScript code fixtures
 * - AST-based validation of transformations
 * - Comprehensive error condition testing
 */

describe("ImportExtensionFixer", () => {
  let testDir: string;
  let fixer: ImportExtensionFixer;
  let originalCwd: string;

  beforeEach(() => {
    // Create isolated test environment
    originalCwd = process.cwd();
    testDir = join(tmpdir(), `import-fixer-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    mkdirSync(testDir, { recursive: true });

    // Create test src directory
    mkdirSync(join(testDir, "src"), { recursive: true });

    // Create minimal tsconfig.json
    writeFileSync(join(testDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "node",
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        strict: true
      },
      include: ["src/**/*"]
    }, null, 2));

    // Change to test directory
    process.chdir(testDir);

    // Create fresh fixer instance
    fixer = new ImportExtensionFixer();
  });

  afterEach(() => {
    // Cleanup test environment
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Unit Tests - Individual Transformations", () => {
    test("should remove .js extension from local imports", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
import { helper } from "./utils.js";
import { config } from "../config.js";
import { Component } from "./components/Button.js";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const imports = sourceFile.getImportDeclarations();
      expect(imports[0].getModuleSpecifierValue()).toBe("./utils");
      expect(imports[1].getModuleSpecifierValue()).toBe("../config");
      expect(imports[2].getModuleSpecifierValue()).toBe("./components/Button");
    });

    test("should remove .ts extension from local imports", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
import { TypeHelper } from "./types.ts";
import { Interface } from "../interfaces.ts";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const imports = sourceFile.getImportDeclarations();
      expect(imports[0].getModuleSpecifierValue()).toBe("./types");
      expect(imports[1].getModuleSpecifierValue()).toBe("../interfaces");
    });

    test("should remove extensions from export statements", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
export { helper } from "./utils.js";
export type { Config } from "../config.ts";
export * from "./components/Button.js";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const exports = sourceFile.getExportDeclarations();
      expect(exports[0].getModuleSpecifierValue()).toBe("./utils");
      expect(exports[1].getModuleSpecifierValue()).toBe("../config");
      expect(exports[2].getModuleSpecifierValue()).toBe("./components/Button");
    });

    test("should preserve external npm package imports", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
import { readFile } from "fs/promises";
import express from "express";
import { z } from "zod";
import { join } from "path";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const imports = sourceFile.getImportDeclarations();
      expect(imports[0].getModuleSpecifierValue()).toBe("fs/promises");
      expect(imports[1].getModuleSpecifierValue()).toBe("express");
      expect(imports[2].getModuleSpecifierValue()).toBe("zod");
      expect(imports[3].getModuleSpecifierValue()).toBe("path");
    });

    test("should preserve non-.js/.ts extensions", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
import "./styles.css";
import config from "./config.json";
import template from "./template.html";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const imports = sourceFile.getImportDeclarations();
      expect(imports[0].getModuleSpecifierValue()).toBe("./styles.css");
      expect(imports[1].getModuleSpecifierValue()).toBe("./config.json");
      expect(imports[2].getModuleSpecifierValue()).toBe("./template.html");
    });

    test("should handle mixed import types correctly", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
import { readFile } from "fs/promises";
import { helper } from "./utils.js";
import "./styles.css";
import express from "express";
import { config } from "../config.ts";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const imports = sourceFile.getImportDeclarations();
      expect(imports[0].getModuleSpecifierValue()).toBe("fs/promises"); // npm package
      expect(imports[1].getModuleSpecifierValue()).toBe("./utils"); // local .js removed
      expect(imports[2].getModuleSpecifierValue()).toBe("./styles.css"); // css preserved
      expect(imports[3].getModuleSpecifierValue()).toBe("express"); // npm package
      expect(imports[4].getModuleSpecifierValue()).toBe("../config"); // local .ts removed
    });
  });

  describe("Integration Tests - Full Codemod Execution", () => {
    test("should process multiple files correctly", async () => {
      // Create multiple test files
      const files = [
        { path: "src/app.ts", content: `import { helper } from "./utils.js";` },
        { path: "src/components/Button.ts", content: `export { theme } from "../theme.ts";` },
        { path: "src/utils/index.ts", content: `import { config } from "./config.js";` }
      ];

      files.forEach(file => {
        const fullPath = join(testDir, file.path);
        mkdirSync(join(testDir, file.path.split('/').slice(0, -1).join('/')), { recursive: true });
        writeFileSync(fullPath, file.content);
      });

      await fixer.execute();

      const metrics = fixer.getMetrics();
      expect(metrics.filesProcessed).toBe(3);
      expect(metrics.filesModified).toBe(3);
      expect(metrics.totalImportsFixed).toBe(2);
      expect(metrics.totalExportsFixed).toBe(1);
      expect(metrics.totalTransformations).toBe(3);
      expect(metrics.successRate).toBe(100);
    });

    test("should generate accurate metrics", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
import { a } from "./a.js";
import { b } from "./b.ts";
import { c } from "external";
export { d } from "./d.js";
      `);

      await fixer.execute();

      const metrics = fixer.getMetrics();
      expect(metrics.filesProcessed).toBe(1);
      expect(metrics.filesModified).toBe(1);
      expect(metrics.totalImportsFixed).toBe(2); // a.js and b.ts
      expect(metrics.totalExportsFixed).toBe(1); // d.js
      expect(metrics.totalTransformations).toBe(3);
      expect(metrics.processingTime).toBeGreaterThan(0);
      expect(metrics.successRate).toBe(100);
      expect(metrics.errors.length).toBe(0);
    });

    test("should provide detailed results per file", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
import { helper } from "./utils.js";
export { config } from "./config.ts";
      `);

      await fixer.execute();

      const results = fixer.getResults();
      expect(results.length).toBe(1);
      expect(results[0].importsFixed).toBe(1);
      expect(results[0].exportsFixed).toBe(1);
      expect(results[0].errors.length).toBe(0);
      expect(results[0].file).toContain("test.ts");
    });

    test("should handle files with no changes", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
import { readFile } from "fs/promises";
import express from "express";
const message = "Hello World";
      `);

      await fixer.execute();

      const metrics = fixer.getMetrics();
      expect(metrics.filesProcessed).toBe(1);
      expect(metrics.filesModified).toBe(0);
      expect(metrics.totalImportsFixed).toBe(0);
      expect(metrics.totalExportsFixed).toBe(0);
      expect(metrics.totalTransformations).toBe(0);
      expect(metrics.successRate).toBe(100);
    });
  });

  describe("Edge Cases and Error Handling", () => {
    test("should handle empty files", async () => {
      const testFile = join(testDir, "src/empty.ts");
      writeFileSync(testFile, "");

      await fixer.execute();

      const metrics = fixer.getMetrics();
      expect(metrics.filesProcessed).toBe(1);
      expect(metrics.filesModified).toBe(0);
      expect(metrics.totalTransformations).toBe(0);
      expect(metrics.successRate).toBe(100);
    });

    test("should handle files with only comments", async () => {
      const testFile = join(testDir, "src/comments.ts");
      writeFileSync(testFile, `
// This is a comment
/*
 * Multi-line comment
 */
      `);

      await fixer.execute();

      const metrics = fixer.getMetrics();
      expect(metrics.filesProcessed).toBe(1);
      expect(metrics.filesModified).toBe(0);
      expect(metrics.totalTransformations).toBe(0);
      expect(metrics.successRate).toBe(100);
    });

    test("should handle imports without extensions", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
import { helper } from "./utils";
import { config } from "../config";
      `);

      await fixer.execute();

      const metrics = fixer.getMetrics();
      expect(metrics.filesProcessed).toBe(1);
      expect(metrics.filesModified).toBe(0);
      expect(metrics.totalTransformations).toBe(0);
      expect(metrics.successRate).toBe(100);
    });

    test("should handle complex import/export patterns", async () => {
      const testFile = join(testDir, "src/complex.ts");
      writeFileSync(testFile, `
import type { Config } from "./types.ts";
import { default as Helper, type HelperType } from "./helper.js";
import * as Utils from "./utils.js";
export { default } from "./main.js";
export type { Theme } from "./theme.ts";
export * from "./components.js";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const imports = sourceFile.getImportDeclarations();
      expect(imports[0].getModuleSpecifierValue()).toBe("./types");
      expect(imports[1].getModuleSpecifierValue()).toBe("./helper");
      expect(imports[2].getModuleSpecifierValue()).toBe("./utils");

      const exports = sourceFile.getExportDeclarations();
      expect(exports[0].getModuleSpecifierValue()).toBe("./main");
      expect(exports[1].getModuleSpecifierValue()).toBe("./theme");
      expect(exports[2].getModuleSpecifierValue()).toBe("./components");
    });

    test("should handle exports without module specifiers", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
const helper = () => {};
export { helper };
export default helper;
      `);

      await fixer.execute();

      const metrics = fixer.getMetrics();
      expect(metrics.filesProcessed).toBe(1);
      expect(metrics.filesModified).toBe(0);
      expect(metrics.totalTransformations).toBe(0);
      expect(metrics.successRate).toBe(100);
    });

    test("should exclude test files from processing", async () => {
      const testFile = join(testDir, "src/component.test.ts");
      writeFileSync(testFile, `
import { helper } from "./utils.js";
      `);

      await fixer.execute();

      const metrics = fixer.getMetrics();
      expect(metrics.filesProcessed).toBe(0); // Test files should be excluded
    });

    test("should exclude spec files from processing", async () => {
      const specFile = join(testDir, "src/component.spec.ts");
      writeFileSync(specFile, `
import { helper } from "./utils.js";
      `);

      await fixer.execute();

      const metrics = fixer.getMetrics();
      expect(metrics.filesProcessed).toBe(0); // Spec files should be excluded
    });
  });

  describe("Performance Benchmarks", () => {
    test("should process files efficiently", async () => {
      // Create multiple files for performance testing
      const fileCount = 10;
      for (let i = 0; i < fileCount; i++) {
        const testFile = join(testDir, `src/file${i}.ts`);
        writeFileSync(testFile, `
import { helper${i} } from "./utils${i}.js";
export { config${i} } from "./config${i}.ts";
        `);
      }

      const startTime = Date.now();
      await fixer.execute();
      const endTime = Date.now();

      const metrics = fixer.getMetrics();
      expect(metrics.filesProcessed).toBe(fileCount);
      expect(metrics.processingTime).toBeLessThan(5000); // Should complete within 5 seconds
      expect(metrics.processingTime).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(10000); // Total time should be reasonable
    });

    test("should maintain high success rate", async () => {
      const testFile = join(testDir, "src/test.ts");
      writeFileSync(testFile, `
import { valid } from "./valid.js";
import { another } from "./another.ts";
import { external } from "external-package";
      `);

      await fixer.execute();

      const metrics = fixer.getMetrics();
      expect(metrics.successRate).toBe(100);
      expect(metrics.errors.length).toBe(0);
    });
  });

  describe("TypeScript Support", () => {
    test("should handle TypeScript-specific imports", async () => {
      const testFile = join(testDir, "src/typescript.ts");
      writeFileSync(testFile, `
import type { Config } from "./types.ts";
import type { Theme } from "./theme.js";
import { type Utils, helper } from "./utils.js";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const imports = sourceFile.getImportDeclarations();
      expect(imports[0].getModuleSpecifierValue()).toBe("./types");
      expect(imports[1].getModuleSpecifierValue()).toBe("./theme");
      expect(imports[2].getModuleSpecifierValue()).toBe("./utils");
    });

    test("should handle JSX/TSX files", async () => {
      const testFile = join(testDir, "src/component.tsx");
      writeFileSync(testFile, `
import React from "react";
import { Button } from "./Button.js";
import { theme } from "./theme.ts";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const imports = sourceFile.getImportDeclarations();
      expect(imports[0].getModuleSpecifierValue()).toBe("react"); // External preserved
      expect(imports[1].getModuleSpecifierValue()).toBe("./Button"); // Local .js removed
      expect(imports[2].getModuleSpecifierValue()).toBe("./theme"); // Local .ts removed
    });
  });

  describe("Real-world Scenarios", () => {
    test("should handle Bun-style imports correctly", async () => {
      const testFile = join(testDir, "src/bun-example.ts");
      writeFileSync(testFile, `
import { serve } from "bun";
import { readFileSync } from "fs";
import { helper } from "./utils.js";
import { config } from "./config.ts";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const imports = sourceFile.getImportDeclarations();
      expect(imports[0].getModuleSpecifierValue()).toBe("bun");
      expect(imports[1].getModuleSpecifierValue()).toBe("fs");
      expect(imports[2].getModuleSpecifierValue()).toBe("./utils");
      expect(imports[3].getModuleSpecifierValue()).toBe("./config");
    });

    test("should handle nested directory imports", async () => {
      const testFile = join(testDir, "src/nested/deep/component.ts");
      mkdirSync(join(testDir, "src/nested/deep"), { recursive: true });
      writeFileSync(testFile, `
import { helper } from "../../utils.js";
import { config } from "../../../config.ts";
import { theme } from "./theme.js";
      `);

      await fixer.execute();

      const project = new Project();
      project.addSourceFileAtPath(testFile);
      const sourceFile = project.getSourceFile(testFile)!;

      const imports = sourceFile.getImportDeclarations();
      expect(imports[0].getModuleSpecifierValue()).toBe("../../utils");
      expect(imports[1].getModuleSpecifierValue()).toBe("../../../config");
      expect(imports[2].getModuleSpecifierValue()).toBe("./theme");
    });
  });
});
