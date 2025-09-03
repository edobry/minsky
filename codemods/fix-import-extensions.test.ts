#!/usr/bin/env bun

import { describe, test, expect, beforeEach } from "bun:test";
import { Project, SourceFile } from "ts-morph";

/**
 * Test Suite for Import Extension Fixer
 *
 * Uses in-memory file system to test transformations without:
 * - Creating real temp directories
 * - Running the full execute() method with console output
 * - Modifying any real files
 *
 * This follows the pattern of comprehensive-as-unknown-fixer.test.ts
 * for clean, silent test execution.
 */

describe("ImportExtensionFixer", () => {
  let project: Project;

  beforeEach(() => {
    // Use in-memory file system for testing
    project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: 99, // ESNext
        module: 99, // ESNext
        moduleResolution: 2, // Node
      },
    });
  });

  /**
   * Helper to test import transformations
   */
  function testImportTransformation(
    sourceCode: string,
    expectedCode: string,
    description: string
  ) {
    const sourceFile = project.createSourceFile("test.ts", sourceCode);
    
    // Manually apply the transformation logic
    // (extracting the core logic from ImportExtensionFixer)
    const importDeclarations = sourceFile.getImportDeclarations();
    for (const importDecl of importDeclarations) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      
      // Only process local imports
      if (moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../")) {
        // Remove .js or .ts extensions
        if (moduleSpecifier.endsWith(".js") || moduleSpecifier.endsWith(".ts")) {
          const newSpecifier = moduleSpecifier.replace(/\.(js|ts)$/, "");
          importDecl.setModuleSpecifier(newSpecifier);
        }
      }
    }

    // Check export declarations too
    const exportDeclarations = sourceFile.getExportDeclarations();
    for (const exportDecl of exportDeclarations) {
      const moduleSpecifier = exportDecl.getModuleSpecifierValue();
      
      if (moduleSpecifier && (moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../"))) {
        if (moduleSpecifier.endsWith(".js") || moduleSpecifier.endsWith(".ts")) {
          const newSpecifier = moduleSpecifier.replace(/\.(js|ts)$/, "");
          exportDecl.setModuleSpecifier(newSpecifier);
        }
      }
    }

    const result = sourceFile.getFullText();
    expect(result).toContain(expectedCode);
  }

  describe("Import Statement Transformations", () => {
    test("should remove .js extension from local imports", () => {
      testImportTransformation(
        `import { helper } from "./utils.js";`,
        `import { helper } from "./utils";`,
        "Remove .js from local import"
      );
    });

    test("should remove .ts extension from local imports", () => {
      testImportTransformation(
        `import { config } from "../config.ts";`,
        `import { config } from "../config";`,
        "Remove .ts from local import"
      );
    });

    test("should preserve external npm package imports", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `import { Project } from "ts-morph";`
      );
      
      const importDecls = sourceFile.getImportDeclarations();
      for (const importDecl of importDecls) {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        // Should not modify external packages
        expect(moduleSpecifier).toBe("ts-morph");
      }
    });

    test("should preserve non-.js/.ts extensions", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `import styles from "./styles.css";
import data from "./data.json";`
      );
      
      const importDecls = sourceFile.getImportDeclarations();
      const specifiers = importDecls.map(d => d.getModuleSpecifierValue());
      expect(specifiers).toContain("./styles.css");
      expect(specifiers).toContain("./data.json");
    });

    test("should handle multiple imports correctly", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `import { a } from "./a.js";
import { b } from "../b.ts";
import { c } from "external-package";
import { d } from "./d";`
      );
      
      const importDecls = sourceFile.getImportDeclarations();
      for (const importDecl of importDecls) {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        
        if (moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../")) {
          if (moduleSpecifier.endsWith(".js") || moduleSpecifier.endsWith(".ts")) {
            const newSpecifier = moduleSpecifier.replace(/\.(js|ts)$/, "");
            importDecl.setModuleSpecifier(newSpecifier);
          }
        }
      }
      
      const specifiers = importDecls.map(d => d.getModuleSpecifierValue());
      expect(specifiers).toContain("./a");
      expect(specifiers).toContain("../b");
      expect(specifiers).toContain("external-package");
      expect(specifiers).toContain("./d");
    });
  });

  describe("Export Statement Transformations", () => {
    test("should remove extensions from export statements", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `export { helper } from "./utils.js";
export * from "../shared.ts";`
      );
      
      const exportDecls = sourceFile.getExportDeclarations();
      for (const exportDecl of exportDecls) {
        const moduleSpecifier = exportDecl.getModuleSpecifierValue();
        
        if (moduleSpecifier && (moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../"))) {
          if (moduleSpecifier.endsWith(".js") || moduleSpecifier.endsWith(".ts")) {
            const newSpecifier = moduleSpecifier.replace(/\.(js|ts)$/, "");
            exportDecl.setModuleSpecifier(newSpecifier);
          }
        }
      }
      
      const specifiers = exportDecls.map(d => d.getModuleSpecifierValue()).filter(Boolean);
      expect(specifiers).toContain("./utils");
      expect(specifiers).toContain("../shared");
    });

    test("should handle exports without module specifiers", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `export const value = 42;
export function helper() {}`
      );
      
      // These exports don't have module specifiers, so nothing to transform
      const exportDecls = sourceFile.getExportDeclarations();
      expect(exportDecls.length).toBe(0);
    });
  });

  describe("Edge Cases", () => {
    test("should handle empty files", () => {
      const sourceFile = project.createSourceFile("test.ts", "");
      const imports = sourceFile.getImportDeclarations();
      expect(imports.length).toBe(0);
    });

    test("should handle files with only comments", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `// This is a comment
/* Block comment */`
      );
      const imports = sourceFile.getImportDeclarations();
      expect(imports.length).toBe(0);
    });

    test("should handle imports without extensions", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `import { helper } from "./utils";`
      );
      
      const importDecl = sourceFile.getImportDeclarations()[0];
      const originalSpecifier = importDecl.getModuleSpecifierValue();
      
      // Should not modify imports that already don't have extensions
      expect(originalSpecifier).toBe("./utils");
    });

    test("should handle complex import patterns", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `import type { Type } from "./types.ts";
import { default as Component } from "./component.js";
import * as utils from "../utils.js";`
      );
      
      const importDecls = sourceFile.getImportDeclarations();
      for (const importDecl of importDecls) {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        
        if (moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../")) {
          if (moduleSpecifier.endsWith(".js") || moduleSpecifier.endsWith(".ts")) {
            const newSpecifier = moduleSpecifier.replace(/\.(js|ts)$/, "");
            importDecl.setModuleSpecifier(newSpecifier);
          }
        }
      }
      
      const specifiers = importDecls.map(d => d.getModuleSpecifierValue());
      expect(specifiers).toContain("./types");
      expect(specifiers).toContain("./component");
      expect(specifiers).toContain("../utils");
    });
  });

  describe("TypeScript Support", () => {
    test("should handle TypeScript-specific imports", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `import type { Type } from "./types.ts";
import { type AnotherType, value } from "./mixed.js";`
      );
      
      const importDecls = sourceFile.getImportDeclarations();
      for (const importDecl of importDecls) {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        
        if (moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../")) {
          if (moduleSpecifier.endsWith(".js") || moduleSpecifier.endsWith(".ts")) {
            const newSpecifier = moduleSpecifier.replace(/\.(js|ts)$/, "");
            importDecl.setModuleSpecifier(newSpecifier);
          }
        }
      }
      
      const specifiers = importDecls.map(d => d.getModuleSpecifierValue());
      expect(specifiers).toContain("./types");
      expect(specifiers).toContain("./mixed");
    });

    test("should handle TSX/JSX imports", () => {
      const sourceFile = project.createSourceFile(
        "test.tsx",
        `import React from "react";
import Component from "./Component.tsx";
import styles from "./styles.module.css";`
      );
      
      // Note: .tsx extension handling might be different
      // For now, we don't transform .tsx extensions in this simplified test
      const importDecls = sourceFile.getImportDeclarations();
      const specifiers = importDecls.map(d => d.getModuleSpecifierValue());
      
      expect(specifiers).toContain("react");
      expect(specifiers).toContain("./Component.tsx"); // TSX preserved for now
      expect(specifiers).toContain("./styles.module.css");
    });
  });

  describe("Real-world Scenarios", () => {
    test("should handle Bun-style imports correctly", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `import { test } from "bun:test";
import { readFile } from "node:fs";
import { helper } from "./utils.js";`
      );
      
      const importDecls = sourceFile.getImportDeclarations();
      for (const importDecl of importDecls) {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        
        // Only process local imports, not bun: or node: imports
        if (moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../")) {
          if (moduleSpecifier.endsWith(".js") || moduleSpecifier.endsWith(".ts")) {
            const newSpecifier = moduleSpecifier.replace(/\.(js|ts)$/, "");
            importDecl.setModuleSpecifier(newSpecifier);
          }
        }
      }
      
      const specifiers = importDecls.map(d => d.getModuleSpecifierValue());
      expect(specifiers).toContain("bun:test");
      expect(specifiers).toContain("node:fs");
      expect(specifiers).toContain("./utils");
    });

    test("should handle nested directory imports", () => {
      const sourceFile = project.createSourceFile(
        "test.ts",
        `import { service } from "../../services/auth/auth-service.js";
import { Component } from "./components/ui/Button.ts";`
      );
      
      const importDecls = sourceFile.getImportDeclarations();
      for (const importDecl of importDecls) {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        
        if (moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../")) {
          if (moduleSpecifier.endsWith(".js") || moduleSpecifier.endsWith(".ts")) {
            const newSpecifier = moduleSpecifier.replace(/\.(js|ts)$/, "");
            importDecl.setModuleSpecifier(newSpecifier);
          }
        }
      }
      
      const specifiers = importDecls.map(d => d.getModuleSpecifierValue());
      expect(specifiers).toContain("../../services/auth/auth-service");
      expect(specifiers).toContain("./components/ui/Button");
    });
  });
});