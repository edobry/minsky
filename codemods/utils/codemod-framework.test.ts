#!/usr/bin/env bun

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import CodemodFramework, { ASTTransform, CommonTransforms } from "./codemod-framework.js";
import { SyntaxKind, Node } from "ts-morph";

describe("CodemodFramework (AST-only)", () => {
  let testDir: string;
  let framework: CodemodFramework;

  beforeEach(() => {
    testDir = `/tmp/codemod-framework-test-${Date.now()}`;
    mkdirSync(testDir, { recursive: true });
    framework = new CodemodFramework();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("AST-based transforms", () => {
    it("should apply AST transformations to property access", async () => {
      const testFile = join(testDir, "test.ts");
      writeFileSync(testFile, `
const config = getConfig();
const value = config.setting;
      `);

      const transforms: ASTTransform[] = [
        {
          name: "TEST_PROPERTY_ACCESS",
          description: "Add type assertion to property access",
          nodeType: SyntaxKind.PropertyAccessExpression,
          matcher: (node: Node) => {
            if (!Node.isPropertyAccessExpression(node)) return false;
            const expression = node.getExpression();
            return Node.isIdentifier(expression) && expression.getText() === "config";
          },
          transformer: (node: Node) => {
            const propAccess = node as any;
            const expression = propAccess.getExpression();
            expression.replaceWithText("(config as any)");
            return {
              applied: true,
              description: "Added type assertion to config"
            };
          }
        }
      ];

      const fixes = await framework.processSingleFile(testFile, transforms);
      expect(fixes).toBe(1);

      const result = readFileSync(testFile, "utf-8");
      expect(result).toContain("(config as any).setting");
    });

    it("should handle multiple transformations", async () => {
      const testFile = join(testDir, "multiple.ts");
      writeFileSync(testFile, `
const config = getConfig();
const options = getOptions();
const configValue = config.setting;
const optionValue = options.flag;
      `);

      const transforms: ASTTransform[] = [
        {
          name: "TEST_CONFIG_ASSERTION",
          description: "Add type assertion to config access",
          nodeType: SyntaxKind.PropertyAccessExpression,
          matcher: (node: Node) => {
            if (!Node.isPropertyAccessExpression(node)) return false;
            const expression = node.getExpression();
            return Node.isIdentifier(expression) && expression.getText() === "config";
          },
          transformer: (node: Node) => {
            const propAccess = node as any;
            const expression = propAccess.getExpression();
            expression.replaceWithText("(config as any)");
            return {
              applied: true,
              description: "Added type assertion to config"
            };
          }
        },
        {
          name: "TEST_OPTIONS_ASSERTION",
          description: "Add type assertion to options access",
          nodeType: SyntaxKind.PropertyAccessExpression,
          matcher: (node: Node) => {
            if (!Node.isPropertyAccessExpression(node)) return false;
            const expression = node.getExpression();
            return Node.isIdentifier(expression) && expression.getText() === "options";
          },
          transformer: (node: Node) => {
            const propAccess = node as any;
            const expression = propAccess.getExpression();
            expression.replaceWithText("(options as any)");
            return {
              applied: true,
              description: "Added type assertion to options"
            };
          }
        }
      ];

      const fixes = await framework.processSingleFile(testFile, transforms);
      expect(fixes).toBe(2);

      const result = readFileSync(testFile, "utf-8");
      expect(result).toContain("(config as any).setting");
      expect(result).toContain("(options as any).flag");
    });

    it("should track results correctly", async () => {
      const testFile = join(testDir, "results.ts");
      writeFileSync(testFile, `
const config = getConfig();
const value1 = config.setting1;
const value2 = config.setting2;
      `);

      const transforms: ASTTransform[] = [
        {
          name: "TEST_RESULT_TRACKING",
          description: "Track multiple config transformations",
          nodeType: SyntaxKind.PropertyAccessExpression,
          matcher: (node: Node) => {
            if (!Node.isPropertyAccessExpression(node)) return false;
            const expression = node.getExpression();
            return Node.isIdentifier(expression) && expression.getText() === "config";
          },
          transformer: (node: Node) => {
            const propAccess = node as any;
            const expression = propAccess.getExpression();
            expression.replaceWithText("(config as any)");
            return {
              applied: true,
              description: "Added type assertion to config"
            };
          }
        }
      ];

      await framework.processSingleFile(testFile, transforms);
      
      const results = framework.getResults();
      expect(results.length).toBe(2);
      expect(results[0].fixType).toBe("TEST_RESULT_TRACKING");
      expect(results[1].fixType).toBe("TEST_RESULT_TRACKING");
    });

    it("should handle syntax errors gracefully", async () => {
      const testFile = join(testDir, "broken.ts");
      writeFileSync(testFile, `
const broken = {
  missing: "quote
  invalid: syntax
      `);

      const transforms: ASTTransform[] = [
        {
          name: "TEST_BROKEN_FILE",
          description: "Should not run on broken files",
          nodeType: SyntaxKind.PropertyAccessExpression,
          matcher: () => true,
          transformer: () => ({ applied: true, description: "Should not reach here" })
        }
      ];
      
      const fixes = await framework.processSingleFile(testFile, transforms);
      expect(fixes).toBe(0); // Should skip broken files
    });

    it("should skip syntax checking when configured", async () => {
      const testFile = join(testDir, "broken-but-skip.ts");
      writeFileSync(testFile, `
const config = getConfig();
const value = config.setting;
// Missing quote will cause syntax error
const broken = "missing quote;
      `);

      const frameworkWithSkip = new CodemodFramework({ skipSyntaxCheck: true });
      
      const transforms: ASTTransform[] = [
        {
          name: "TEST_SKIP_SYNTAX",
          description: "Should run even with syntax errors",
          nodeType: SyntaxKind.PropertyAccessExpression,
          matcher: (node: Node) => {
            if (!Node.isPropertyAccessExpression(node)) return false;
            const expression = node.getExpression();
            return Node.isIdentifier(expression) && expression.getText() === "config";
          },
          transformer: (node: Node) => {
            const propAccess = node as any;
            const expression = propAccess.getExpression();
            expression.replaceWithText("(config as any)");
            return {
              applied: true,
              description: "Added type assertion despite syntax errors"
            };
          }
        }
      ];

      const fixes = await frameworkWithSkip.processSingleFile(testFile, transforms);
      expect(fixes).toBe(1); // Should process despite syntax errors
    });
  });

  describe("Common AST transforms", () => {
    it("should have working optional chaining transform", async () => {
      const testFile = join(testDir, "optional.ts");
      writeFileSync(testFile, `
const config = getConfig();
const value = config.setting;
      `);

      const transforms = [CommonTransforms.optionalChaining.propertyAccess];

      const fixes = await framework.processSingleFile(testFile, transforms);
      expect(fixes).toBe(1);

      const result = readFileSync(testFile, "utf-8");
      expect(result).toContain("config?.setting");
    });

    it("should have working type assertion transform", async () => {
      const testFile = join(testDir, "assertions.ts");
      writeFileSync(testFile, `
const params = getParams();
const value = params.setting;
      `);

      const transforms = [CommonTransforms.typeAssertions.unknownPropertyAccess];

      const fixes = await framework.processSingleFile(testFile, transforms);
      expect(fixes).toBe(1);

      const result = readFileSync(testFile, "utf-8");
      expect(result).toContain("(params as any).setting");
    });
  });

  describe("Framework utilities", () => {
    it("should clear results when requested", async () => {
      const testFile = join(testDir, "clear.ts");
      writeFileSync(testFile, `
const config = getConfig();
const value = config.setting;
      `);

      const transforms: ASTTransform[] = [
        {
          name: "TEST_CLEAR",
          description: "Test clearing results",
          nodeType: SyntaxKind.PropertyAccessExpression,
          matcher: () => true,
          transformer: () => ({ applied: true, description: "Test transform" })
        }
      ];

      await framework.processSingleFile(testFile, transforms);
      expect(framework.getResults().length).toBe(1);

      framework.clearResults();
      expect(framework.getResults().length).toBe(0);
    });

    it("should process multiple files", async () => {
      const srcDir = join(testDir, "src");
      mkdirSync(srcDir, { recursive: true });
      
      writeFileSync(join(srcDir, "file1.ts"), `
const config = getConfig();
const value = config.setting;
      `);
      
      writeFileSync(join(srcDir, "file2.ts"), `
const options = getOptions();
const flag = options.enabled;
      `);

      const transforms: ASTTransform[] = [
        {
          name: "TEST_MULTI_FILE",
          description: "Test multiple file processing",
          nodeType: SyntaxKind.PropertyAccessExpression,
          matcher: (node: Node) => {
            if (!Node.isPropertyAccessExpression(node)) return false;
            const expression = node.getExpression();
            return Node.isIdentifier(expression) && 
                   ["config", "options"].includes(expression.getText());
          },
          transformer: (node: Node) => {
            const propAccess = node as any;
            const expression = propAccess.getExpression();
            const varName = expression.getText();
            expression.replaceWithText(`(${varName} as any)`);
            return {
              applied: true,
              description: `Added type assertion to ${varName}`
            };
          }
        }
      ];

      await framework.processFiles(join(srcDir, "*.ts"), transforms, {
        name: "Test Multi-File",
        description: "Testing multiple file processing"
      });

      const results = framework.getResults();
      expect(results.length).toBe(2);
      
      const file1Content = readFileSync(join(srcDir, "file1.ts"), "utf-8");
      const file2Content = readFileSync(join(srcDir, "file2.ts"), "utf-8");
      
      expect(file1Content).toContain("(config as any).setting");
      expect(file2Content).toContain("(options as any).enabled");
    });
  });
}); 
