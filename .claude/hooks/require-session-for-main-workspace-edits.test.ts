import { describe, expect, it } from "bun:test";
import {
  checkFilePathDenial,
  MAIN_WORKSPACE,
  SESSION_WORKSPACE_ROOT,
} from "./require-session-for-main-workspace-edits";

describe("checkFilePathDenial", () => {
  describe("denies main-workspace edits", () => {
    it("blocks Edit on src/ file", () => {
      const r = checkFilePathDenial("Edit", `${MAIN_WORKSPACE}/src/domain/session.ts`);
      expect(r.denied).toBe(true);
      expect(r.reason).toContain("session_edit_file");
      expect(r.reason).toContain("mt#1103");
    });

    it("blocks Write on a new file under main workspace", () => {
      const r = checkFilePathDenial("Write", `${MAIN_WORKSPACE}/services/reviewer/new.ts`);
      expect(r.denied).toBe(true);
      expect(r.reason).toContain("Main workspace edit blocked");
    });

    it("blocks NotebookEdit on main workspace", () => {
      const r = checkFilePathDenial("NotebookEdit", `${MAIN_WORKSPACE}/notebooks/analysis.ipynb`);
      expect(r.denied).toBe(true);
    });

    it("blocks edits to .claude/ directory under main workspace", () => {
      const r = checkFilePathDenial("Edit", `${MAIN_WORKSPACE}/.claude/hooks/example.ts`);
      expect(r.denied).toBe(true);
    });

    it("blocks edits to the workspace root itself", () => {
      const r = checkFilePathDenial("Edit", MAIN_WORKSPACE);
      expect(r.denied).toBe(true);
    });
  });

  describe("allows session-workspace edits", () => {
    it("allows Edit inside a session workspace", () => {
      const r = checkFilePathDenial(
        "Edit",
        `${SESSION_WORKSPACE_ROOT}/abc-123/sessions/abc-123/src/foo.ts`
      );
      expect(r.denied).toBe(false);
    });

    it("allows Write inside a session workspace", () => {
      const r = checkFilePathDenial("Write", `${SESSION_WORKSPACE_ROOT}/abc-123/new-file.ts`);
      expect(r.denied).toBe(false);
    });
  });

  describe("allows edits outside the main repo", () => {
    it("allows /tmp/ paths", () => {
      expect(checkFilePathDenial("Edit", "/tmp/scratch.ts").denied).toBe(false);
    });

    it("allows home-directory memory files", () => {
      expect(
        checkFilePathDenial(
          "Edit",
          "/Users/edobry/.claude/projects/-Users-edobry-Projects-minsky/memory/MEMORY.md"
        ).denied
      ).toBe(false);
    });

    it("allows edits in other Projects/ directories", () => {
      expect(checkFilePathDenial("Edit", "/Users/edobry/Projects/raycast/index.ts").denied).toBe(
        false
      );
    });
  });

  describe("ignores non-file-editing tools", () => {
    it("allows Bash regardless of path", () => {
      expect(checkFilePathDenial("Bash", `${MAIN_WORKSPACE}/anything`).denied).toBe(false);
    });

    it("allows Read regardless of path", () => {
      expect(checkFilePathDenial("Read", `${MAIN_WORKSPACE}/src/foo.ts`).denied).toBe(false);
    });

    it("allows the MCP session_edit_file tool itself", () => {
      expect(
        checkFilePathDenial("mcp__minsky__session_edit_file", `${MAIN_WORKSPACE}/src/foo.ts`).denied
      ).toBe(false);
    });
  });

  describe("handles edge cases", () => {
    it("allows undefined file_path (pass-through, tool will handle)", () => {
      expect(checkFilePathDenial("Edit", undefined).denied).toBe(false);
    });

    it("allows relative paths (pass-through, Edit enforces absolute)", () => {
      expect(checkFilePathDenial("Edit", "relative/file.ts").denied).toBe(false);
    });

    it("does NOT match a path that merely contains the main workspace as a substring", () => {
      // e.g., a different project whose name starts with the same prefix
      expect(checkFilePathDenial("Edit", `${MAIN_WORKSPACE}-other/src/foo.ts`).denied).toBe(false);
    });
  });
});
