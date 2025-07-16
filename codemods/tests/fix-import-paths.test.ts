import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Project, SourceFile } from "ts-morph";
import { GlobalImportPathFixer } from "../fix-global-import-paths";
import * as fs from "fs";
import * as path from "path";

describe("GlobalImportPathFixer", () => {
  let project: Project;
  let tempDir: string;
  let fixer: GlobalImportPathFixer;

  beforeEach(() => {
    // Create temporary directory structure
    tempDir = fs.mkdtempSync(path.join(import.meta.dir, "temp-"));

    // Create directory structure matching our codebase
    const dirs = [
      "src/errors",
      "src/schemas",
      "src/utils",
      "src/domain/session/commands",
      "src/domain/session",
      "src/domain/git",
      "src/domain/storage",
      "src/domain/tasks",
      "src/adapters/mcp",
      "src/adapters/shared"
    ];

    dirs.forEach(dir => {
      fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
    });

    project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: false
    });

    fixer = new GlobalImportPathFixer({
      dryRun: false,
      verbose: false,
      includePatterns: [`${tempDir}/src/**/*.ts`],
      excludePatterns: [`${tempDir}/**/*.test.ts`, `${tempDir}/**/*.d.ts`]
    });
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Session Commands Directory (3 levels deep)", () => {
    it("should fix ../../errors to ../../../errors", () => {
      const content = `import { ValidationError } from "../../errors/index";
import { ResourceNotFoundError } from "../../errors";

export function test() {
  throw new ValidationError("test");
}`;

      const filePath = path.join(tempDir, "src/domain/session/commands/test-command.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { ValidationError } from "../../../errors";`);
      expect(result).toContain(`import { ResourceNotFoundError } from "../../../errors";`);
    });

    it("should fix ../../schemas to ../../../schemas", () => {
      const content = `import type { SessionParams } from "../../schemas/session";

export function test(params: SessionParams) {}`;

      const filePath = path.join(tempDir, "src/domain/session/commands/test-command.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import type { SessionParams } from "../../../schemas/session";`);
    });

    it("should fix ../../utils to ../../../utils", () => {
      const content = `import { log } from "../../utils/logger";
import { exec } from "../../utils/exec";

export function test() {
  log("test");
}`;

      const filePath = path.join(tempDir, "src/domain/session/commands/test-command.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { log } from "../../../utils/logger";`);
      expect(result).toContain(`import { exec } from "../../../utils/exec";`);
    });
  });

  describe("Session Directory (2 levels deep)", () => {
    it("should fix ../../errors to ../../../errors", () => {
      const content = `import { ValidationError } from "../../errors/index";
import { getErrorMessage } from "../../errors";

export function test() {
  throw new ValidationError("test");
}`;

      const filePath = path.join(tempDir, "src/domain/session/test-operations.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { ValidationError } from "../../../errors";`);
      expect(result).toContain(`import { getErrorMessage } from "../../../errors";`);
    });

    it("should fix ../../utils to ../../../utils", () => {
      const content = `import { log } from "../../utils/logger";
import { getMinskyStateDir } from "../../utils/paths";

export function test() {
  log("test");
}`;

      const filePath = path.join(tempDir, "src/domain/session/test-operations.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { log } from "../../../utils/logger";`);
      expect(result).toContain(`import { getMinskyStateDir } from "../../../utils/paths";`);
    });
  });

  describe("Other Domain Subdirectories", () => {
    it("should fix git operations imports", () => {
      const content = `import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";

export function test() {
  log("test");
}`;

      const filePath = path.join(tempDir, "src/domain/git/test-operations.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { getErrorMessage } from "../../../errors";`);
      expect(result).toContain(`import { log } from "../../../utils/logger";`);
    });

    it("should fix storage operations imports", () => {
      const content = `import { getErrorMessage } from "../../errors/index";
import { validateTaskState } from "../../schemas/storage";
import { log } from "../../utils/logger";

export function test() {
  log("test");
}`;

      const filePath = path.join(tempDir, "src/domain/storage/test-backend.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { getErrorMessage } from "../../../errors";`);
      expect(result).toContain(`import { validateTaskState } from "../../../schemas/storage";`);
      expect(result).toContain(`import { log } from "../../../utils/logger";`);
    });

    it("should fix tasks operations imports", () => {
      const content = `import { getErrorMessage } from "../../errors/index";
import { ValidationError } from "../../errors/index";
import { log } from "../../utils/logger";

export function test() {
  log("test");
}`;

      const filePath = path.join(tempDir, "src/domain/tasks/test-backend.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { getErrorMessage } from "../../../errors";`);
      expect(result).toContain(`import { ValidationError } from "../../../errors";`);
      expect(result).toContain(`import { log } from "../../../utils/logger";`);
    });
  });

  describe("Adapters Directory", () => {
    it("should fix MCP adapter imports", () => {
      const content = `import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";

export function test() {
  log("test");
}`;

      const filePath = path.join(tempDir, "src/adapters/mcp/test-adapter.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { getErrorMessage } from "../../../errors";`);
      expect(result).toContain(`import { log } from "../../../utils/logger";`);
    });

    it("should fix shared adapter imports", () => {
      const content = `import { MinskyError } from "../../errors/index";
import { log } from "../../utils/logger";

export function test() {
  log("test");
}`;

      const filePath = path.join(tempDir, "src/adapters/shared/test-adapter.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { MinskyError } from "../../../errors";`);
      expect(result).toContain(`import { log } from "../../../utils/logger";`);
    });
  });

  describe("Import Path Detection Logic", () => {
    it("should detect all incorrect import patterns", () => {
      const content = `import { ValidationError } from "../../errors/index";
import { ResourceNotFoundError } from "../../errors";
import { taskIdSchema } from "../../schemas/common";
import type { SessionParams } from "../../schemas/session";
import { log } from "../../utils/logger";
import { execAsync } from "../../utils/exec";

// This should not be changed
import { someFunction } from "../types";
import { anotherFunction } from "./local-file";
import { externalLib } from "external-library";

export function test() {}`;

      const filePath = path.join(tempDir, "src/domain/session/test-file.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);

      const originalIssues = fixer.analyzeImportIssues(sourceFile);
      expect(originalIssues).toHaveLength(6); // Should find 6 issues

      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { ValidationError } from "../../../errors";`);
      expect(result).toContain(`import { ResourceNotFoundError } from "../../../errors";`);
      expect(result).toContain(`import { taskIdSchema } from "../../../schemas/common";`);
      expect(result).toContain(`import type { SessionParams } from "../../../schemas/session";`);
      expect(result).toContain(`import { log } from "../../../utils/logger";`);
      expect(result).toContain(`import { execAsync } from "../../../utils/exec";`);

      // These should remain unchanged
      expect(result).toContain(`import { someFunction } from "../types";`);
      expect(result).toContain(`import { anotherFunction } from "./local-file";`);
      expect(result).toContain(`import { externalLib } from "external-library";`);
    });
  });

  describe("Edge Cases", () => {
    it("should handle mixed import types correctly", () => {
      const content = `import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import type { Session } from "../types";
import { log } from "../../utils/logger";

export function test() {}`;

      const filePath = path.join(tempDir, "src/domain/session/test-file.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toContain(`import { ValidationError, ResourceNotFoundError } from "../../../errors";`);
      expect(result).toContain(`import type { Session } from "../types";`); // unchanged
      expect(result).toContain(`import { log } from "../../../utils/logger";`);
    });

    it("should handle files with no import issues", () => {
      const content = `import { Session } from "../types";
import { someUtil } from "./utils";
import { externalLib } from "external-library";

export function test() {}`;

      const filePath = path.join(tempDir, "src/domain/session/test-file.ts");
      fs.writeFileSync(filePath, content);

      const sourceFile = project.addSourceFileAtPath(filePath);
      const originalContent = sourceFile.getFullText();

      fixer.fixImportPathsInFile(sourceFile);

      const result = sourceFile.getFullText();
      expect(result).toBe(originalContent); // Should be unchanged
    });
  });

  describe("Full Integration Test", () => {
    it("should process multiple files and generate comprehensive report", async () => {
      // Create multiple files with different import issues
      const files = [
        {
          path: "src/domain/session/commands/test1.ts",
          content: `import { ValidationError } from "../../errors/index";
import { log } from "../../utils/logger";`
        },
        {
          path: "src/domain/git/test2.ts",
          content: `import { getErrorMessage } from "../../errors/index";
import { execAsync } from "../../utils/exec";`
        },
        {
          path: "src/domain/tasks/test3.ts",
          content: `import { ResourceNotFoundError } from "../../errors/index";
import type { TaskParams } from "../../schemas/tasks";`
        }
      ];

      files.forEach(file => {
        const fullPath = path.join(tempDir, file.path);
        fs.writeFileSync(fullPath, file.content);
      });

      fixer = new GlobalImportPathFixer({
        dryRun: false,
        verbose: false,
        includePatterns: [`${tempDir}/src/**/*.ts`],
        excludePatterns: [`${tempDir}/**/*.test.ts`]
      });

      await fixer.execute();

      // Verify the fixes were applied
      files.forEach(file => {
        const fullPath = path.join(tempDir, file.path);
        const result = fs.readFileSync(fullPath, 'utf-8');

        expect(result).not.toContain('../../errors');
        expect(result).not.toContain('../../utils');
        expect(result).not.toContain('../../schemas');

        expect(result).toContain('../../../errors');
        if (result.includes('utils')) {
          expect(result).toContain('../../../utils');
        }
        if (result.includes('schemas')) {
          expect(result).toContain('../../../schemas');
        }
      });
    });
  });
});
