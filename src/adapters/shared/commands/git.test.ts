import { describe, test, expect } from "bun:test";
import { buildGitLogArgs } from "./git";

describe("buildGitLogArgs", () => {
  test("builds the default oneline command with a bounded limit", () => {
    const args = buildGitLogArgs({ repo: "/tmp/work" });
    const cmd = args.join(" ");

    expect(cmd).toBe("git -C '/tmp/work' log --oneline -n 20");
  });

  test("keeps behavior identical for well-formed inputs (no spaces/quotes)", () => {
    const args = buildGitLogArgs({
      repo: "/tmp/work",
      limit: 5,
      author: "eugene",
      since: "2024-01-01",
      until: "2024-02-01",
      grep: "fix",
      ref: "main",
      path: "src/domain",
      format: "short",
    });
    const cmd = args.join(" ");

    expect(cmd).toBe(
      "git -C '/tmp/work' log --format=short -n 5 --author='eugene' --since='2024-01-01' " +
        "--until='2024-02-01' --grep='fix' 'main' -- 'src/domain'"
    );
  });

  test("R2: safely quotes a path containing a space as a single shell token", () => {
    const args = buildGitLogArgs({
      repo: "/tmp/work",
      path: "src/some dir/file name.ts",
    });
    const cmd = args.join(" ");

    // The path must appear as ONE single-quoted token after `--`, not be
    // split into multiple argv entries by the embedded spaces.
    expect(cmd).toContain("-- 'src/some dir/file name.ts'");
  });

  test("R2: safely escapes an author containing a single quote character", () => {
    const args = buildGitLogArgs({
      repo: "/tmp/work",
      author: "O'Brien",
    });
    const cmd = args.join(" ");

    // POSIX single-quote escaping: each embedded `'` becomes `'\''`.
    expect(cmd).toContain("--author='O'\\''Brien'");
    // The naive (unescaped) form would break out of quoting early — must
    // NOT appear.
    expect(cmd).not.toContain("--author='O'Brien'");
  });

  test("R2: quotes a repo path containing a space", () => {
    const args = buildGitLogArgs({ repo: "/tmp/some dir/work" });
    const cmd = args.join(" ");

    expect(cmd).toContain("-C '/tmp/some dir/work'");
  });

  test("R2: quotes a ref containing shell metacharacters", () => {
    const args = buildGitLogArgs({ repo: "/tmp/work", ref: "feature; rm -rf /" });
    const cmd = args.join(" ");

    expect(cmd).toContain("'feature; rm -rf /'");
    // Unquoted, this would be interpreted as a second shell command.
    expect(cmd).not.toContain("feature; rm -rf / log");
  });

  test("falls back to a (quoted) default working directory when repo is not provided", () => {
    const args = buildGitLogArgs({});
    expect(args[0]).toBe("git");
    expect(args[1]).toBe("-C");
    // The fallback value is still shell-quoted, whatever it resolves to.
    expect(args[2]).toMatch(/^'.*'$/);
  });
});
