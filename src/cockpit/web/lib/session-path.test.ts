/**
 * Tests for session-workspace path recognition (mt#3378).
 */
import { describe, test, expect } from "bun:test";
import { parseSessionWorkspacePath, toolInputPath, sessionFileTargetFor } from "./session-path";

const SESSION_ID = "010b0467-f007-4b2f-9d80-d5f6ed3cf4b7";
const SESSION_ROOT = `/Users/x/.local/state/minsky/sessions/${SESSION_ID}`;

describe("parseSessionWorkspacePath", () => {
  test("splits an absolute session path into session id and relative path", () => {
    const target = parseSessionWorkspacePath(`${SESSION_ROOT}/src/cockpit/web/lib/tool-summary.ts`);
    expect(target).not.toBeNull();
    expect(target?.sessionId).toBe(SESSION_ID);
    expect(target?.relativePath).toBe("src/cockpit/web/lib/tool-summary.ts");
    expect(target?.absolutePath).toBe(`${SESSION_ROOT}/src/cockpit/web/lib/tool-summary.ts`);
  });

  test("a main-workspace path is not a session path", () => {
    expect(parseSessionWorkspacePath("/Users/x/Projects/minsky/CLAUDE.md")).toBeNull();
  });

  test("a non-Minsky directory literally named `sessions` is not a session path", () => {
    // The id segment is what makes the match specific — `bar.ts` is not id-shaped.
    expect(parseSessionWorkspacePath("/Users/x/Projects/foo/sessions/bar.ts")).toBeNull();
  });

  test("the session root itself, with no file below it, does not parse", () => {
    expect(parseSessionWorkspacePath(SESSION_ROOT)).toBeNull();
    expect(parseSessionWorkspacePath(`${SESSION_ROOT}/`)).toBeNull();
  });

  test("a relative path never parses", () => {
    expect(parseSessionWorkspacePath("src/foo.ts")).toBeNull();
  });

  test("a truncated (non-36-char) id segment does not parse", () => {
    expect(
      parseSessionWorkspacePath("/Users/x/.local/state/minsky/sessions/010b0467/src/a.ts")
    ).toBeNull();
  });

  test("an XDG_STATE_HOME-relocated state dir still parses", () => {
    const target = parseSessionWorkspacePath(`/var/state/minsky/sessions/${SESSION_ID}/src/a.ts`);
    expect(target?.sessionId).toBe(SESSION_ID);
    expect(target?.relativePath).toBe("src/a.ts");
  });
});

describe("toolInputPath", () => {
  test("reads each supported path key", () => {
    expect(toolInputPath({ file_path: "/a.ts" })).toBe("/a.ts");
    expect(toolInputPath({ path: "/b.ts" })).toBe("/b.ts");
    expect(toolInputPath({ filePath: "/c.ts" })).toBe("/c.ts");
    expect(toolInputPath({ notebook_path: "/d.ipynb" })).toBe("/d.ipynb");
  });

  test("returns undefined for inputs carrying no path", () => {
    expect(toolInputPath({ command: "bun test" })).toBeUndefined();
    expect(toolInputPath(null)).toBeUndefined();
    expect(toolInputPath("a string")).toBeUndefined();
    expect(toolInputPath(["/a.ts"])).toBeUndefined();
    expect(toolInputPath({ file_path: "" })).toBeUndefined();
  });
});

describe("sessionFileTargetFor", () => {
  test("a native Edit on a session path is labeled as session-scoped", () => {
    const target = sessionFileTargetFor("Edit", { file_path: `${SESSION_ROOT}/src/a.ts` });
    expect(target?.relativePath).toBe("src/a.ts");
    expect(target?.labelAsSession).toBe(true);
  });

  test("an MCP session_* tool is NOT re-labeled — its name already says session", () => {
    const target = sessionFileTargetFor("mcp__minsky__session_edit_file", {
      path: `${SESSION_ROOT}/src/a.ts`,
    });
    expect(target?.relativePath).toBe("src/a.ts");
    expect(target?.labelAsSession).toBe(false);
  });

  test("an MCP session_* tool's session-relative path yields no target to split", () => {
    const target = sessionFileTargetFor("mcp__minsky__session_edit_file", {
      sessionId: SESSION_ID,
      path: "src/foo.ts",
    });
    expect(target).toBeNull();
  });

  test("a native Edit outside any session yields no target", () => {
    expect(sessionFileTargetFor("Edit", { file_path: "/Users/x/Projects/minsky/a.ts" })).toBeNull();
  });

  test("a tool carrying no path at all yields no target", () => {
    expect(sessionFileTargetFor("Bash", { command: "bun test" })).toBeNull();
  });
});
