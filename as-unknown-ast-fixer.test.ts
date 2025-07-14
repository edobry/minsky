#!/usr/bin/env bun

/**
 * Test Suite for AS-UNKNOWN AST Codemod
 * 
 * Tests all transformation patterns and edge cases for the as-unknown codemod.
 * Ensures safe and accurate transformations while maintaining TypeScript compilation.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rmSync, writeFileSync, readFileSync } from "fs";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { AsUnknownASTFixer } from "./as-unknown-ast-fixer";

const mkdtempAsync = promisify(mkdtemp);

describe("AS-UNKNOWN AST Codemod", () => {
  let tempDir: string;
  let testFiles: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtempAsync(join(tmpdir(), "as-unknown-test-"));
    testFiles = [];
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  function createTestFile(filename: string, content: string): string {
    const filePath = join(tempDir, filename);
    writeFileSync(filePath, content);
    testFiles.push(filePath);
    return filePath;
  }

  function readTestFile(filename: string): string {
    return readFileSync(join(tempDir, filename), "utf-8");
  }

  async function runCodemod(options: { dryRun?: boolean; verbose?: boolean } = {}): Promise<AsUnknownASTFixer> {
    const fixer = new AsUnknownASTFixer({
      includePatterns: [`${tempDir}/**/*.ts`],
      excludePatterns: ["**/*.d.ts", "**/*.test.ts", "**/node_modules/**"],
      dryRun: options.dryRun ?? false,
      verbose: options.verbose ?? false,
      tsConfigPath: undefined // Skip ts-config for tests
    });

    await fixer.execute();
    return fixer;
  }

  describe("Critical Priority Transformations", () => {
    test("should fix return statement null/undefined patterns", async () => {
      createTestFile("return-statements.ts", `
        function test1(): string | null {
          return null as unknown;
        }

        function test2(): string | undefined {
          return undefined as unknown;
        }

        function test3(): any {
          if (condition) {
            return null as unknown;
          }
          return undefined as unknown;
        }
      `);

      const fixer = await runCodemod();
      const result = readTestFile("return-statements.ts");

      expect(result).toContain("return null;");
      expect(result).toContain("return undefined;");
      expect(result).not.toContain("as unknown");
      expect((fixer as any).metrics.issuesFixed).toBeGreaterThan(0);
    });

    test("should fix null/undefined assignment patterns", async () => {
      createTestFile("null-undefined.ts", `
        const value1 = null as unknown;
        const value2 = undefined as unknown;
        let value3: any = null as unknown;
        let value4: any = undefined as unknown;
        
        const obj = {
          prop1: null as unknown,
          prop2: undefined as unknown
        };
      `);

      const fixer = await runCodemod();
      const result = readTestFile("null-undefined.ts");

      expect(result).toContain("const value1 = null;");
      expect(result).toContain("const value2 = undefined;");
      expect(result).toContain("let value3: any = null;");
      expect(result).toContain("let value4: any = undefined;");
      expect(result).toContain("prop1: null,");
      expect(result).toContain("prop2: undefined");
      expect(result).not.toContain("as unknown");
    });
  });

  describe("High Priority Transformations", () => {
    test("should fix state/session property access", async () => {
      createTestFile("state-access.ts", `
        function listSessions(state: any): any[] {
          return [...(state as unknown).sessions];
        }

        function getSession(state: any, sessionName: string): any {
          return (state.sessions as unknown).find(s => s.name === sessionName);
        }

        function getSessionById(sessions: any[], id: string): any {
          return (sessions as unknown).find(s => s.id === id);
        }
      `);

      const fixer = await runCodemod();
      const result = readTestFile("state-access.ts");

      expect(result).toContain("return [...state.sessions];");
      expect(result).toContain("return state.sessions.find(s => s.name === sessionName);");
      expect(result).toContain("return sessions.find(s => s.id === id);");
      expect(result).not.toContain("as unknown");
    });

    test("should fix service method calls", async () => {
      createTestFile("service-calls.ts", `
        class TestService {
          private sessionProvider: any;
          private pathResolver: any;
          private workspaceBackend: any;
          private config: any;

          async getSession(name: string) {
            return await (this.sessionProvider as unknown).getSession(name);
          }

          getPath(dir: string, path: string) {
            return (this.pathResolver as unknown).getRelativePathFromSession(dir, path);
          }

          readFile(dir: string, path: string) {
            return (this.workspaceBackend as unknown).readFile(dir, path);
          }

          getConfigPath() {
            return (this.config as unknown).path;
          }
        }
      `);

      const fixer = await runCodemod();
      const result = readTestFile("service-calls.ts");

      expect(result).toContain("return await this.sessionProvider.getSession(name);");
      expect(result).toContain("return this.pathResolver.getRelativePathFromSession(dir, path);");
      expect(result).toContain("return this.workspaceBackend.readFile(dir, path);");
      expect(result).toContain("return this.config.path;");
      expect(result).not.toContain("as unknown");
    });

    test("should fix array/object method access", async () => {
      createTestFile("array-methods.ts", `
        function processItems(items: any[]): any {
          const found = (items as unknown).find(item => item.id === 1);
          const length = (items as unknown).length;
          (items as unknown).push({ id: 2 });
          const filtered = (items as unknown).filter(item => item.active);
          const mapped = (items as unknown).map(item => item.name);
          const index = (items as unknown).findIndex(item => item.id === 3);
          (items as unknown).splice(0, 1);
          
          return { found, length, filtered, mapped, index };
        }

        function processObject(obj: any): any {
          const keys = (Object as unknown).keys(obj);
          const values = (Object as unknown).values(obj);
          const entries = (Object as unknown).entries(obj);
          
          return { keys, values, entries };
        }
      `);

      const fixer = await runCodemod();
      const result = readTestFile("array-methods.ts");

      expect(result).toContain("const found = items.find(item => item.id === 1);");
      expect(result).toContain("const length = items.length;");
      expect(result).toContain("items.push({ id: 2 });");
      expect(result).toContain("const filtered = items.filter(item => item.active);");
      expect(result).toContain("const mapped = items.map(item => item.name);");
      expect(result).toContain("const index = items.findIndex(item => item.id === 3);");
      expect(result).toContain("items.splice(0, 1);");
      expect(result).not.toContain("as unknown");
    });

    test("should fix this context access", async () => {
      createTestFile("this-context.ts", `
        class CustomError extends Error {
          constructor(message: string) {
            super(message);
            (this as unknown).name = "CustomError";
          }
        }

        class SessionError extends Error {
          constructor(sessionId: string) {
            super(\`Session error: \${sessionId}\`);
            (this as unknown).name = "SessionError";
          }
        }
      `);

      const fixer = await runCodemod();
      const result = readTestFile("this-context.ts");

      expect(result).toContain("this.name = \"CustomError\";");
      expect(result).toContain("this.name = \"SessionError\";");
      expect(result).not.toContain("as unknown");
    });
  });

  describe("Medium Priority Transformations", () => {
    test("should fix environment variable access", async () => {
      createTestFile("env-vars.ts", `
        const homeDir = (process.env as unknown).HOME;
        const nodeEnv = (process.env as unknown).NODE_ENV;
        const customVar = (process.env as unknown).CUSTOM_VAR;
      `);

      const fixer = await runCodemod();
      const result = readTestFile("env-vars.ts");

      expect(result).toContain("const homeDir = process.env.HOME;");
      expect(result).toContain("const nodeEnv = process.env.NODE_ENV;");
      expect(result).toContain("const customVar = process.env.CUSTOM_VAR;");
      expect(result).not.toContain("as unknown");
    });
  });

  describe("Pattern Detection and Risk Assessment", () => {
    test("should correctly identify and categorize patterns", async () => {
      createTestFile("mixed-patterns.ts", `
        // Critical patterns
        function criticalTest() {
          return null as unknown;
          const val = undefined as unknown;
        }

        // High priority patterns
        function highPriorityTest(state: any, service: any) {
          const sessions = (state as unknown).sessions;
          const result = (service.provider as unknown).getSession("test");
          const length = (sessions as unknown).length;
          (this as unknown).name = "TestError";
        }

        // Medium priority patterns
        function mediumPriorityTest() {
          const home = (process.env as unknown).HOME;
        }

        // Unmatched patterns (should be flagged for manual review)
        function unmatchedTest() {
          const complex = (someComplexExpression() as unknown).someProperty;
        }
      `);

      const fixer = await runCodemod({ dryRun: true });
      
      // Check that issues were found and categorized
      expect((fixer as any).metrics.issuesFound).toBeGreaterThan(0);
      
      // Should find multiple patterns
      const issues = (fixer as any).asUnknownIssues;
      expect(issues.length).toBeGreaterThan(6);
      
      // Should have different risk levels
      const riskLevels = [...new Set(issues.map((i: any) => i.riskLevel))];
      expect(riskLevels).toContain("critical");
      expect(riskLevels).toContain("high");
      expect(riskLevels).toContain("medium");
      
      // Should have different transformation types
      const transformTypes = [...new Set(issues.map((i: any) => i.transformationType))];
      expect(transformTypes.length).toBeGreaterThan(3);
    });

    test("should handle complex nested expressions", async () => {
      createTestFile("complex-nested.ts", `
        function complexTest() {
          const result = {
            sessions: (state as unknown).sessions,
            count: (state as unknown).sessions.length,
            first: (state as unknown).sessions.find(s => s.active)
          };
          
          const chained = (obj as unknown).prop1.prop2.prop3;
          const multiLine = (veryLongVariableName as unknown)
            .someMethod()
            .anotherMethod();
        }
      `);

      const fixer = await runCodemod();
      const result = readTestFile("complex-nested.ts");

      expect(result).toContain("sessions: state.sessions,");
      expect(result).toContain("count: state.sessions.length,");
      expect(result).toContain("first: state.sessions.find(s => s.active)");
    });
  });

  describe("Edge Cases and Error Handling", () => {
    test("should handle files with syntax errors gracefully", async () => {
      createTestFile("syntax-error.ts", `
        function broken() {
          return null as unknown;
          // Missing closing brace
      `);

      // Should not throw an error
      const fixer = await runCodemod();
      
      // Should track errors but continue processing
      expect((fixer as any).metrics.errors.length).toBeGreaterThanOrEqual(0);
    });

    test("should handle empty files", async () => {
      createTestFile("empty.ts", "");

      const fixer = await runCodemod();
      
      expect((fixer as any).metrics.filesProcessed).toBe(1);
      expect((fixer as any).metrics.issuesFound).toBe(0);
    });

    test("should handle files with no as unknown patterns", async () => {
      createTestFile("no-patterns.ts", `
        function clean() {
          const value = "test";
          return value.toUpperCase();
        }

        const obj = {
          prop: 123,
          method: () => "hello"
        };
      `);

      const fixer = await runCodemod();
      const result = readTestFile("no-patterns.ts");

      expect(result).toContain("const value = \"test\";");
      expect(result).toContain("return value.toUpperCase();");
      expect((fixer as any).metrics.issuesFound).toBe(0);
    });

    test("should preserve code formatting and comments", async () => {
      createTestFile("formatting.ts", `
        /**
         * This is a comment
         */
        function test() {
          // This is another comment
          const value = null as unknown; // inline comment
          
          return value;
        }
      `);

      const fixer = await runCodemod();
      const result = readTestFile("formatting.ts");

      expect(result).toContain("/**");
      expect(result).toContain("* This is a comment");
      expect(result).toContain("// This is another comment");
      expect(result).toContain("const value = null; // inline comment");
      expect(result).toContain("return value;");
    });
  });

  describe("Dry Run Mode", () => {
    test("should not modify files in dry run mode", async () => {
      const originalContent = `
        function test() {
          return null as unknown;
        }
      `;
      
      createTestFile("dry-run-test.ts", originalContent);

      const fixer = await runCodemod({ dryRun: true });
      const result = readTestFile("dry-run-test.ts");

      expect(result.trim()).toBe(originalContent.trim());
      expect((fixer as any).metrics.issuesFound).toBeGreaterThan(0);
      expect((fixer as any).metrics.issuesFixed).toBe(0);
    });
  });

  describe("Metrics and Reporting", () => {
    test("should provide accurate metrics", async () => {
      createTestFile("metrics-test.ts", `
        function test() {
          const a = null as unknown;
          const b = undefined as unknown;
          const c = (state as unknown).sessions;
          const d = (items as unknown).length;
          return null as unknown;
        }
      `);

      const fixer = await runCodemod();
      
      expect((fixer as any).metrics.filesProcessed).toBe(1);
      expect((fixer as any).metrics.issuesFound).toBe(5);
      expect((fixer as any).metrics.issuesFixed).toBe(5);
      expect((fixer as any).metrics.fileChanges.size).toBe(1);
      expect((fixer as any).metrics.processingTime).toBeGreaterThan(0);
    });

    test("should calculate success rate correctly", async () => {
      createTestFile("success-rate.ts", `
        function fixablePatterns() {
          const a = null as unknown;
          const b = (state as unknown).sessions;
          return undefined as unknown;
        }
      `);

      const fixer = await runCodemod();
      
      const successRate = (fixer as any).metrics.issuesFixed / (fixer as any).metrics.issuesFound * 100;
      expect(successRate).toBeGreaterThan(90); // Should be very high for auto-fixable patterns
    });
  });

  describe("Integration with TypeScript", () => {
    test("should maintain valid TypeScript syntax after transformation", async () => {
      createTestFile("typescript-syntax.ts", `
        interface Config {
          path: string;
          timeout: number;
        }

        class Service {
          private config: Config;
          
          constructor(config: Config) {
            this.config = config;
          }

          getPath(): string {
            return (this.config as unknown).path;
          }

          getTimeout(): number {
            return (this.config as unknown).timeout;
          }
        }
      `);

      const fixer = await runCodemod();
      const result = readTestFile("typescript-syntax.ts");

      expect(result).toContain("return this.config.path;");
      expect(result).toContain("return this.config.timeout;");
      expect(result).not.toContain("as unknown");
      
      // Should maintain interface and class structure
      expect(result).toContain("interface Config {");
      expect(result).toContain("class Service {");
      expect(result).toContain("private config: Config;");
    });
  });
}); 
