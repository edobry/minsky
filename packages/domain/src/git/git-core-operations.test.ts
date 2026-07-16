/**
 * Tests for commitImpl's message-format fail-fast (mt#2821).
 *
 * Before this fix, a malformed commit message paid for a full round through
 * `git commit` (and, in the real repo, the entire pre-commit suite) before
 * the commit-msg hook could reject it — because git's fixed hook order runs
 * `pre-commit` before `commit-msg` for every commit. commitImpl now runs the
 * same format check itself, BEFORE shelling out to git at all, so a bad
 * message never reaches execAsync.
 */
import { describe, expect, test, mock } from "bun:test";
import { commitImpl } from "./git-core-operations";
import { ValidationError } from "../errors/index";

describe("commitImpl — message-format fail-fast (mt#2821)", () => {
  test("rejects a malformed message without ever calling execAsync", async () => {
    const execAsync = mock(async (_command: string) => ({ stdout: "abc123", stderr: "" }));

    await expect(
      commitImpl(execAsync, "not a conventional commit message", "/tmp/repo")
    ).rejects.toThrow(ValidationError);

    expect(execAsync).not.toHaveBeenCalled();
  });

  test("rejects a forbidden placeholder message without calling execAsync", async () => {
    const execAsync = mock(async (_command: string) => ({ stdout: "abc123", stderr: "" }));

    await expect(commitImpl(execAsync, "wip", "/tmp/repo")).rejects.toThrow(ValidationError);

    expect(execAsync).not.toHaveBeenCalled();
  });

  test("proceeds to execAsync for a well-formed conventional commit message", async () => {
    const execAsync = mock(async (_command: string) => ({
      stdout: "[main abc1234] feat(mt#2821): valid message\n",
      stderr: "",
    }));

    const hash = await commitImpl(execAsync, "feat(mt#2821): valid message", "/tmp/repo");

    expect(execAsync).toHaveBeenCalledTimes(1);
    expect(hash).toBe("abc1234");
  });
});
