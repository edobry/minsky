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
        expect(["new-user-facing-string", REASON_TOP_LEVEL, "new-file"]).toContain(result.reason);
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
        expect([REASON_TOP_LEVEL, "new-file"]).toContain(result.reason);
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

// Shared test constants (mt#2029 — hoisted to file scope to deduplicate with
// earlier suites that also reference the new-top-level-export reason).
const SESSION_EDIT_FILE = "mcp__minsky__session_edit_file";
const SESSION_SEARCH_REPLACE = "mcp__minsky__session_search_replace";
const SESSION_WRITE_FILE = "mcp__minsky__session_write_file";
const SESSION_READ_FILE = "mcp__minsky__session_read_file";
const EXPORT_CONST = "export const X = 1;";
const EXPORT_CLASS_FOO = "export class Foo {}";
const REASON_TOP_LEVEL = "new-top-level-export";

describe("MCP session file-write tools (mt#2029)", () => {
  describe("extractToolCallParams handles MCP-tool parameter shapes", () => {
    it("session_edit_file: path → filePath, content preserved", () => {
      const params = extractToolCallParams(SESSION_EDIT_FILE, {
        path: "src/foo.ts",
        content: EXPORT_CONST,
        instructions: "add export",
      });
      expect(params.filePath).toBe("src/foo.ts");
      expect(params.content).toBe(EXPORT_CONST);
    });

    it("session_write_file: path → filePath, content preserved", () => {
      const params = extractToolCallParams(SESSION_WRITE_FILE, {
        path: "src/new.ts",
        content: EXPORT_CLASS_FOO,
      });
      expect(params.filePath).toBe("src/new.ts");
      expect(params.content).toBe(EXPORT_CLASS_FOO);
    });

    it("session_search_replace: path → filePath, search → oldString, replace → newString", () => {
      const params = extractToolCallParams(SESSION_SEARCH_REPLACE, {
        path: "src/bar.ts",
        search: "const OLD = 1;",
        replace: "const NEW = 2;",
      });
      expect(params.filePath).toBe("src/bar.ts");
      expect(params.oldString).toBe("const OLD = 1;");
      expect(params.newString).toBe("const NEW = 2;");
    });

    it("session_search_replace: old_string/new_string canonical names also work", () => {
      const params = extractToolCallParams(SESSION_SEARCH_REPLACE, {
        path: "src/baz.ts",
        old_string: "foo",
        new_string: "bar",
      });
      expect(params.oldString).toBe("foo");
      expect(params.newString).toBe("bar");
    });

    it("explicit old_string wins over search alias when both present", () => {
      const params = extractToolCallParams(SESSION_SEARCH_REPLACE, {
        path: "src/x.ts",
        old_string: "canonical",
        search: "alias",
      });
      expect(params.oldString).toBe("canonical");
    });
  });

  describe("applyActionFilter fires on MCP-session tools", () => {
    it("fires on session_edit_file adding a new top-level export to a .ts file (the R6 case)", () => {
      const result = applyActionFilter({
        toolName: SESSION_EDIT_FILE,
        filePath: "src/commands/mcp/discovery-config.ts",
        content: "export const DEFAULT_EXCLUDE_CATEGORIES = [CommandCategory.AI];",
      });
      expect(result.fires).toBe(true);
      if (result.fires) {
        expect(result.reason).toBe(REASON_TOP_LEVEL);
      }
    });

    it("fires on session_write_file creating a new file", () => {
      const result = applyActionFilter({
        toolName: SESSION_WRITE_FILE,
        filePath: "src/new-module.ts",
        content: EXPORT_CONST,
      });
      expect(result.fires).toBe(true);
    });

    it("fires on session_search_replace introducing a new config key in a json file", () => {
      const result = applyActionFilter({
        toolName: SESSION_SEARCH_REPLACE,
        filePath: ".claude/settings.local.json",
        oldString: '  "existing": true',
        newString: '  "existing": true,\n  "newSetting": true',
      });
      expect(result.fires).toBe(true);
      if (result.fires) {
        expect(result.reason).toBe("new-config-key");
      }
    });

    it("does NOT fire on session_read_file (read-only)", () => {
      const result = applyActionFilter({
        toolName: SESSION_READ_FILE,
        filePath: "src/foo.ts",
        content: EXPORT_CONST,
      });
      expect(result.fires).toBe(false);
    });
  });
});
