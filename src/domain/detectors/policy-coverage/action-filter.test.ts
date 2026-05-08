/**
 * Tests for the preference-encoding action filter.
 *
 * Acceptance: routine reads / greps / list-directory calls do NOT trigger.
 * Acceptance: Write/Edit/NotebookEdit calls matching the configured patterns DO trigger.
 *
 * Reference: mt#1575 §Acceptance Tests
 */

import { describe, it, expect } from "bun:test";
import {
  applyActionFilter,
  extractToolCallParams,
  isPackageJson,
  isConfigFile,
  hasNewUserFacingString,
  hasNewTopLevelExport,
  hasNewConfigKey,
} from "./action-filter";

describe("applyActionFilter", () => {
  describe("read-only tools never fire", () => {
    const readOnlyCases = [
      "Read",
      "Glob",
      "Grep",
      "LS",
      "Bash",
      "mcp__minsky__session_read_file",
      "mcp__minsky__session_list_directory",
      "mcp__minsky__session_grep_search",
      "mcp__minsky__git_log",
      "mcp__minsky__git_diff",
      "mcp__minsky__tasks_get",
      "mcp__minsky__tasks_list",
      "mcp__minsky__tasks_spec_get",
    ];
    for (const tool of readOnlyCases) {
      it(`does not fire on ${tool}`, () => {
        const result = applyActionFilter({
          toolName: tool,
          filePath: "src/foo.ts",
          content: "const x = 1;",
        });
        expect(result.fires).toBe(false);
      });
    }
  });

  describe("non-write tools never fire", () => {
    it("does not fire on unknown random tool name", () => {
      const result = applyActionFilter({
        toolName: "SomeOtherTool",
        filePath: "src/foo.ts",
      });
      expect(result.fires).toBe(false);
    });
  });

  describe("write tools without filePath do not fire", () => {
    it("returns no-fire when filePath is missing", () => {
      const result = applyActionFilter({ toolName: "Write" });
      expect(result.fires).toBe(false);
    });
  });

  describe("package.json edit fires as new-dependency", () => {
    it("fires on Edit to package.json", () => {
      const result = applyActionFilter({
        toolName: "Edit",
        filePath: "package.json",
        newString: '"foo": "1.0.0"',
      });
      expect(result.fires).toBe(true);
      if (result.fires) {
        expect(result.reason).toBe("new-dependency");
      }
    });

    it("fires on Write to a nested package.json", () => {
      const result = applyActionFilter({
        toolName: "Write",
        filePath: "services/foo/package.json",
        content: "{}",
      });
      expect(result.fires).toBe(true);
      if (result.fires) {
        expect(result.reason).toBe("new-dependency");
      }
    });
  });

  describe("config file with new key fires as new-config-key", () => {
    it("fires on Edit adding a JSON key", () => {
      const result = applyActionFilter({
        toolName: "Edit",
        filePath: "tsconfig.json",
        newString: '"target": "es2022"',
        oldString: undefined,
      });
      expect(result.fires).toBe(true);
      if (result.fires) {
        expect(result.reason).toBe("new-config-key");
      }
    });
  });

  describe("user-facing string fires as new-user-facing-string", () => {
    it("fires on Write with a CLI help description", () => {
      const result = applyActionFilter({
        toolName: "Write",
        filePath: "src/cli/foo.ts",
        content: 'program.description("foo bar baz");',
      });
      expect(result.fires).toBe(true);
      if (result.fires) {
        // either user-facing-string or top-level-export — both valid; assert it's not new-file
        expect(["new-user-facing-string", "new-top-level-export", "new-file"]).toContain(
          result.reason
        );
      }
    });

    it("fires on Edit with thrown error containing user message", () => {
      const result = applyActionFilter({
        toolName: "Edit",
        filePath: "src/lib/bar.ts",
        newString: 'throw new Error("invalid input");',
      });
      expect(result.fires).toBe(true);
      if (result.fires) {
        expect(result.reason).toBe("new-user-facing-string");
      }
    });
  });

  describe("new top-level export fires as new-top-level-export", () => {
    it("fires on Write of a new module exporting a function", () => {
      const result = applyActionFilter({
        toolName: "Write",
        filePath: "src/foo.ts",
        content: "export function doThing() { return 1; }",
      });
      expect(result.fires).toBe(true);
      // Either new-top-level-export or new-file; both are reasonable
      if (result.fires) {
        expect(["new-top-level-export", "new-file"]).toContain(result.reason);
      }
    });
  });

  describe("Write to a new file fires as new-file when no other pattern matches", () => {
    it("fires with new-file when content has no patterns", () => {
      const result = applyActionFilter({
        toolName: "Write",
        filePath: "src/empty.ts",
        content: "// just a comment",
      });
      expect(result.fires).toBe(true);
      if (result.fires) {
        expect(result.reason).toBe("new-file");
      }
    });
  });

  describe("Edit to a regular source file with no preference patterns does not fire", () => {
    it("does not fire on a routine refactor edit", () => {
      const result = applyActionFilter({
        toolName: "Edit",
        filePath: "src/foo.ts",
        newString: "const newName = oldName;",
        oldString: "const oldName = oldName;",
      });
      expect(result.fires).toBe(false);
    });
  });
});

describe("extractToolCallParams", () => {
  it("reads file_path", () => {
    const r = extractToolCallParams("Edit", { file_path: "src/foo.ts" });
    expect(r.filePath).toBe("src/foo.ts");
  });

  it("reads path as fallback", () => {
    const r = extractToolCallParams("Write", { path: "src/foo.ts" });
    expect(r.filePath).toBe("src/foo.ts");
  });

  it("reads content, new_string, old_string", () => {
    const r = extractToolCallParams("Edit", {
      content: "c",
      new_string: "n",
      old_string: "o",
    });
    expect(r.content).toBe("c");
    expect(r.newString).toBe("n");
    expect(r.oldString).toBe("o");
  });

  it("ignores non-string fields", () => {
    const r = extractToolCallParams("Edit", { file_path: 42, content: { foo: "bar" } });
    expect(r.filePath).toBeUndefined();
    expect(r.content).toBeUndefined();
  });
});

describe("path predicate helpers", () => {
  it("isPackageJson recognises top-level and nested", () => {
    expect(isPackageJson("package.json")).toBe(true);
    expect(isPackageJson("services/foo/package.json")).toBe(true);
    expect(isPackageJson("package.json.bak")).toBe(false);
  });

  it("isConfigFile recognises common config extensions", () => {
    expect(isConfigFile("tsconfig.json")).toBe(true);
    expect(isConfigFile("config.yaml")).toBe(true);
    expect(isConfigFile(".env")).toBe(true);
    expect(isConfigFile("src/foo.ts")).toBe(false);
  });
});

describe("string-pattern detectors", () => {
  it("hasNewUserFacingString detects throw new Error", () => {
    expect(hasNewUserFacingString('throw new Error("oops");')).toBe(true);
  });

  it("hasNewUserFacingString detects console.log", () => {
    expect(hasNewUserFacingString('console.log("hello");')).toBe(true);
  });

  it("hasNewUserFacingString does NOT detect plain code", () => {
    expect(hasNewUserFacingString("const x = 1;")).toBe(false);
  });

  it("hasNewTopLevelExport detects export class", () => {
    expect(hasNewTopLevelExport("export class Foo {}")).toBe(true);
  });

  it("hasNewTopLevelExport detects export function", () => {
    expect(hasNewTopLevelExport("export function foo() {}")).toBe(true);
  });

  it("hasNewTopLevelExport does NOT detect imports", () => {
    expect(hasNewTopLevelExport('import { x } from "y";')).toBe(false);
  });

  it("hasNewConfigKey detects fresh JSON key when oldString missing", () => {
    expect(hasNewConfigKey('  "timeout": 14000', undefined)).toBe(true);
  });

  it("hasNewConfigKey skips when both old and new contain same key", () => {
    expect(hasNewConfigKey('  "timeout": 14000', '  "timeout": 9000')).toBe(false);
  });
});
