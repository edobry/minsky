#!/usr/bin/env bun
import { describe, test, expect, beforeEach } from "bun:test";
import { Project, SourceFile } from "ts-morph";
import { ComprehensiveAsUnknownFixer } from "./comprehensive-as-unknown-fixer";

describe("ComprehensiveAsUnknownFixer", () => {
  let project: Project;
  let fixer: ComprehensiveAsUnknownFixer;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: 99, // ESNext
        module: 99, // ESNext
      },
    });
    fixer = new ComprehensiveAsUnknownFixer(project);
  });

  describe("Session Object Property Access Patterns", () => {
    test("should remove sessionProvider cast with non-null assertion", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        const sessionRecord = await (sessionProvider as unknown)!.getSession(sessionName);
        if ((sessionProvider as unknown)!.isActive()) {
          return (sessionProvider as unknown)!.config;
        }
      `);

      const transformations = fixer.fixSessionObjectPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("sessionProvider.getSession(sessionName)");
      expect(sourceFile.getFullText()).toContain("sessionProvider.isActive()");
      expect(sourceFile.getFullText()).toContain("sessionProvider.config");
      expect(transformations.length).toBe(3);
    });

    test("should remove sessionRecord cast with non-null assertion", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        if (sessionRecord && (sessionRecord as unknown)!.repoUrl) {
          return (sessionRecord as unknown)!.repoUrl;
        }
        const taskId = (sessionRecord as unknown)!.taskId;
      `);

      const transformations = fixer.fixSessionObjectPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("sessionRecord.repoUrl");
      expect(sourceFile.getFullText()).toContain("sessionRecord.taskId");
      expect(transformations.length).toBe(3);
    });

    test("should remove sessionInfo cast with non-null assertion", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        return sessionInfo ? (sessionInfo as unknown)!.session : null;
        const name = (sessionInfo as unknown)!.session;
        const upstream = (sessionInfo as unknown)!.upstreamRepository;
      `);

      const transformations = fixer.fixSessionObjectPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("sessionInfo.session");
      expect(sourceFile.getFullText()).toContain("sessionInfo.upstreamRepository");
      expect(transformations.length).toBe(3);
    });
  });

  describe("Dynamic Import Patterns", () => {
    test("should fix relative import patterns", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
        const util = new ((await import("../utils/helper.js")) as unknown).Helper();
      `);

      const transformations = fixer.fixDynamicImportPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain('(await import("./session.js")).SessionDB()');
      expect(sourceFile.getFullText()).toContain('(await import("../utils/helper.js")).Helper()');
      expect(transformations.length).toBe(2);
    });

    test("should NOT fix absolute import patterns (keep them safe)", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        const proc = ((await import("child_process")) as unknown).exec;
        const util = ((await import("util")) as unknown).promisify;
      `);

      const transformations = fixer.fixDynamicImportPatterns(sourceFile);

      // Should remain unchanged for absolute imports
      expect(sourceFile.getFullText()).toContain('((await import("child_process")) as unknown).exec');
      expect(sourceFile.getFullText()).toContain('((await import("util")) as unknown).promisify');
      expect(transformations.length).toBe(0);
    });
  });

  describe("Config Object Patterns", () => {
    test("should remove config object casts", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        const value = (config as unknown).apiKey;
        const timeout = (config as unknown).timeout;
        const options = (config as unknown).database;
      `);

      const transformations = fixer.fixConfigObjectPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("config.apiKey");
      expect(sourceFile.getFullText()).toContain("config.timeout");
      expect(sourceFile.getFullText()).toContain("config.database");
      expect(transformations.length).toBe(3);
    });

    test("should remove options object casts", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        const debug = (options as unknown).debug;
        const verbose = (options as unknown).verbose;
      `);

      const transformations = fixer.fixConfigObjectPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("options.debug");
      expect(sourceFile.getFullText()).toContain("options.verbose");
      expect(transformations.length).toBe(2);
    });
  });

  describe("Error Handling Patterns", () => {
    test("should remove error object casts", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        const message = (error as unknown).message;
        const code = (err as unknown).code;
        const stack = (e as unknown).stack;
      `);

      const transformations = fixer.fixErrorHandlingPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("error.message");
      expect(sourceFile.getFullText()).toContain("err.code");
      expect(sourceFile.getFullText()).toContain("e.stack");
      expect(transformations.length).toBe(3);
    });
  });

  describe("Provider/Service Patterns", () => {
    test("should remove provider/service/backend casts", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        const data = (taskProvider as unknown).getTasks();
        const result = (userService as unknown).getUser();
        const config = (storageBackend as unknown).getConfig();
      `);

      const transformations = fixer.fixProviderServicePatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("taskProvider.getTasks()");
      expect(sourceFile.getFullText()).toContain("userService.getUser()");
      expect(sourceFile.getFullText()).toContain("storageBackend.getConfig()");
      expect(transformations.length).toBe(3);
    });
  });

  describe("Redundant Cast Patterns", () => {
    test("should remove redundant double casts", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        const result1 = (output as unknown) as string;
        const result2 = (result as unknown) as number;
        const result3 = (data as unknown) as boolean;
      `);

      const transformations = fixer.fixRedundantCastPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("output as string");
      expect(sourceFile.getFullText()).toContain("result as number");
      expect(sourceFile.getFullText()).toContain("data as boolean");
      expect(transformations.length).toBe(3);
    });
  });

  describe("Promise Return Patterns", () => {
    test("should remove unnecessary Promise casts", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        return Promise.resolve(value) as unknown;
        return Promise.reject(error) as unknown;
        const p = Promise.resolve(data) as unknown;
      `);

      const transformations = fixer.fixPromiseReturnPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("Promise.resolve(value)");
      expect(sourceFile.getFullText()).toContain("Promise.reject(error)");
      expect(sourceFile.getFullText()).toContain("Promise.resolve(data)");
      expect(transformations.length).toBe(3);
    });
  });

  describe("Simple Variable Patterns", () => {
    test("should remove simple variable casts", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        const p = (params as unknown);
        const r = (result as unknown);
        const c = (current as unknown);
        const t = (task as unknown);
      `);

      const transformations = fixer.fixSimpleVariablePatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("const p = params");
      expect(sourceFile.getFullText()).toContain("const r = result");
      expect(sourceFile.getFullText()).toContain("const c = current");
      expect(sourceFile.getFullText()).toContain("const t = task");
      expect(transformations.length).toBe(4);
    });
  });

  describe("Edge Cases and Safety", () => {
    test("should NOT transform complex expressions", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        const complex = (someObject.deepProperty.methodCall() as unknown).value;
        const chained = (obj.method().then() as unknown).property;
      `);

      const transformations = fixer.fixAllPatterns(sourceFile);

      // Should remain unchanged due to complexity
      expect(sourceFile.getFullText()).toContain("(someObject.deepProperty.methodCall() as unknown).value");
      expect(sourceFile.getFullText()).toContain("(obj.method().then() as unknown).property");
      expect(transformations.length).toBe(0);
    });

    test("should handle mixed patterns in single file", () => {
      const sourceFile = project.createSourceFile("test.ts", `
        // Session pattern
        const session = (sessionInfo as unknown)!.session;
        
        // Config pattern  
        const debug = (config as unknown).debug;
        
        // Error pattern
        const message = (error as unknown).message;
        
        // Redundant cast
        const result = (output as unknown) as string;
      `);

      const transformations = fixer.fixAllPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("sessionInfo.session");
      expect(sourceFile.getFullText()).toContain("config.debug");
      expect(sourceFile.getFullText()).toContain("error.message");
      expect(sourceFile.getFullText()).toContain("output as string");
      expect(transformations.length).toBe(4);
    });
  });

  describe("Real Codebase Scenarios", () => {
    test("should handle actual workspace.ts patterns", () => {
      const sourceFile = project.createSourceFile("workspace.ts", `
        const sessionRecord = await (sessionProvider as unknown)!.getSession(sessionName);
        if (sessionRecord && (sessionRecord as unknown)!.repoUrl) {
          return (sessionRecord as unknown)!.repoUrl;
        }
        return sessionInfo ? (sessionInfo as unknown)!.session : null;
      `);

      const transformations = fixer.fixAllPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain("sessionProvider.getSession(sessionName)");
      expect(sourceFile.getFullText()).toContain("sessionRecord.repoUrl");
      expect(sourceFile.getFullText()).toContain("sessionInfo.session");
      expect(transformations.length).toBe(4);
    });

    test("should handle actual repository.ts dynamic import patterns", () => {
      const sourceFile = project.createSourceFile("repository.ts", `
        const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
        await (await import("util")).promisify(((await import("child_process")) as unknown).exec)(
          \`git clone \${repoUrl}\`
        );
      `);

      const transformations = fixer.fixAllPatterns(sourceFile);

      expect(sourceFile.getFullText()).toContain('(await import("./session.js")).SessionDB()');
      // Child_process should remain unchanged (absolute import)
      expect(sourceFile.getFullText()).toContain('((await import("child_process")) as unknown).exec');
      expect(transformations.length).toBe(1);
    });
  });
}); 
