import { describe, test, expect } from "bun:test";
import { statusImpl, type StatusDependencies } from "./status-operations";

const WORKDIR = "/tmp/work";
const BRANCH_OID = "# branch.oid abc1234";
const BRANCH_HEAD_MAIN = "# branch.head main";
const BRANCH_AB_ZERO = "# branch.ab +0 -0";
const NUL = "\0";

function makeDeps(stdout: string): StatusDependencies {
  return {
    async execAsync() {
      return { stdout, stderr: "" };
    },
  };
}

describe("statusImpl", () => {
  test("is defined and takes 2 parameters", () => {
    expect(statusImpl).toBeDefined();
    expect(statusImpl.length).toBe(2);
  });

  test("returns structured result for clean repo on main", async () => {
    const output = [
      BRANCH_OID,
      BRANCH_HEAD_MAIN,
      "# branch.upstream origin/main",
      BRANCH_AB_ZERO,
      "",
    ].join(NUL);
    const result = await statusImpl({ repoPath: WORKDIR }, makeDeps(output));
    expect(result.workdir).toBe(WORKDIR);
    expect(result.branch).toBe("main");
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
    expect(result.staged).toHaveLength(0);
    expect(result.unstaged).toHaveLength(0);
    expect(result.untracked).toHaveLength(0);
    expect(result.conflicted).toHaveLength(0);
  });

  test("parses ahead/behind counts", async () => {
    const output = [
      "# branch.oid abc1234",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +3 -2",
      "",
    ].join(NUL);
    const result = await statusImpl({ repoPath: WORKDIR }, makeDeps(output));
    expect(result.branch).toBe("feature/x");
    expect(result.ahead).toBe(3);
    expect(result.behind).toBe(2);
  });

  test("parses ordinary changed entry with staged file", async () => {
    const output = [
      BRANCH_HEAD_MAIN,
      BRANCH_AB_ZERO,
      "1 M. N... 100644 100644 100644 abc def src/foo.ts",
      "",
    ].join(NUL);
    const result = await statusImpl({ repoPath: WORKDIR }, makeDeps(output));
    expect(result.staged).toContain("src/foo.ts");
    expect(result.unstaged).toHaveLength(0);
  });

  test("parses ordinary changed entry with unstaged file", async () => {
    const output = [
      BRANCH_HEAD_MAIN,
      BRANCH_AB_ZERO,
      "1 .M N... 100644 100644 100644 abc def src/bar.ts",
      "",
    ].join(NUL);
    const result = await statusImpl({ repoPath: WORKDIR }, makeDeps(output));
    expect(result.unstaged).toContain("src/bar.ts");
    expect(result.staged).toHaveLength(0);
  });

  test("parses untracked file", async () => {
    const output = [BRANCH_HEAD_MAIN, BRANCH_AB_ZERO, "? new-file.ts", ""].join(NUL);
    const result = await statusImpl({ repoPath: WORKDIR }, makeDeps(output));
    expect(result.untracked).toContain("new-file.ts");
  });

  test("parses conflicted (unmerged) entry", async () => {
    const output = [
      BRANCH_HEAD_MAIN,
      BRANCH_AB_ZERO,
      "u UU N... 100644 100644 100644 100644 abc def ghi src/conflict.ts",
      "",
    ].join(NUL);
    const result = await statusImpl({ repoPath: WORKDIR }, makeDeps(output));
    expect(result.conflicted).toContain("src/conflict.ts");
  });

  test("falls back to HEAD for detached head", async () => {
    const output = [BRANCH_OID, "# branch.head (detached)", ""].join(NUL);
    const result = await statusImpl({ repoPath: WORKDIR }, makeDeps(output));
    expect(result.branch).toBe("(detached)");
  });

  test("preserves embedded spaces in paths (no quoting under -z)", async () => {
    // Under -z, paths with spaces are NOT C-quoted; they're emitted raw.
    // The parser must NOT split the path on spaces.
    const output = [
      BRANCH_HEAD_MAIN,
      BRANCH_AB_ZERO,
      "1 M. N... 100644 100644 100644 abc def docs/file with spaces.md",
      "1 .M N... 100644 100644 100644 abc def src/another file.ts",
      "? untracked file with spaces.txt",
      "",
    ].join(NUL);
    const result = await statusImpl({ repoPath: WORKDIR }, makeDeps(output));
    expect(result.staged).toEqual(["docs/file with spaces.md"]);
    expect(result.unstaged).toEqual(["src/another file.ts"]);
    expect(result.untracked).toEqual(["untracked file with spaces.txt"]);
  });

  test("parses rename entry collecting new path; skips orig follow-up record", async () => {
    // Rename entries (`2 `) emit two NUL-terminated records: the entry with
    // the new path, then the orig path as a separate record.
    const output = [
      BRANCH_HEAD_MAIN,
      BRANCH_AB_ZERO,
      "2 R. N... 100644 100644 100644 abc def R100 src/new-name.ts",
      "src/old-name.ts",
      "1 M. N... 100644 100644 100644 abc def src/other.ts",
      "",
    ].join(NUL);
    const result = await statusImpl({ repoPath: WORKDIR }, makeDeps(output));
    expect(result.staged).toEqual(["src/new-name.ts", "src/other.ts"]);
    // The orig-path record must NOT be classified as untracked or anything else.
    expect(result.untracked).toHaveLength(0);
  });

  test("parses rename entry with spaces in both orig and new path", async () => {
    const output = [
      BRANCH_HEAD_MAIN,
      BRANCH_AB_ZERO,
      "2 R. N... 100644 100644 100644 abc def R100 docs/new name.md",
      "docs/old name.md",
      "",
    ].join(NUL);
    const result = await statusImpl({ repoPath: WORKDIR }, makeDeps(output));
    expect(result.staged).toEqual(["docs/new name.md"]);
    expect(result.untracked).toHaveLength(0);
  });
});
