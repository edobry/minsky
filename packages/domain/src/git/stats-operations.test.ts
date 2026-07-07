import { describe, test, expect } from "bun:test";
import { gitStatsImpl, type GitStatsDependencies } from "./stats-operations";

const WORKDIR = "/tmp/work";
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

function makeDeps(stdout: string): GitStatsDependencies {
  return {
    async execAsync() {
      return { stdout, stderr: "" };
    },
  };
}

function makeCapturingDeps(stdout: string): {
  deps: GitStatsDependencies;
  commands: string[];
} {
  const commands: string[] = [];
  return {
    commands,
    deps: {
      async execAsync(command: string) {
        commands.push(command);
        return { stdout, stderr: "" };
      },
    },
  };
}

describe("gitStatsImpl", () => {
  test("is defined and takes 2 parameters", () => {
    expect(gitStatsImpl).toBeDefined();
    expect(gitStatsImpl.length).toBe(2);
  });

  test("aggregates per-path commit counts and churn from --numstat output", async () => {
    const output = [
      HASH_A,
      "",
      "12\t5\tsrc/domain/foo.ts",
      "3\t0\tsrc/domain/bar.ts",
      HASH_B,
      "",
      "1\t1\tsrc/domain/foo.ts",
      "",
    ].join("\n");

    const result = await gitStatsImpl({ repoPath: WORKDIR }, makeDeps(output));

    expect(result.workdir).toBe(WORKDIR);
    expect(result.nameOnly).toBe(false);
    expect(result.totalCommits).toBe(2);

    const foo = result.files.find((f) => f.path === "src/domain/foo.ts");
    expect(foo).toBeDefined();
    expect(foo?.commits).toBe(2);
    expect(foo?.insertions).toBe(13);
    expect(foo?.deletions).toBe(6);

    const bar = result.files.find((f) => f.path === "src/domain/bar.ts");
    expect(bar).toBeDefined();
    expect(bar?.commits).toBe(1);
    expect(bar?.insertions).toBe(3);
    expect(bar?.deletions).toBe(0);
  });

  test("sorts files by total churn (insertions + deletions) descending", async () => {
    const output = [
      HASH_A,
      "",
      "1\t1\tsrc/small.ts",
      "50\t20\tsrc/hot.ts",
      "5\t5\tsrc/medium.ts",
      "",
    ].join("\n");

    const result = await gitStatsImpl({ repoPath: WORKDIR }, makeDeps(output));

    expect(result.files.map((f) => f.path)).toEqual([
      "src/hot.ts",
      "src/medium.ts",
      "src/small.ts",
    ]);
  });

  test("treats binary file markers (-\\t-\\tpath) as zero churn but still counts the commit", async () => {
    const output = [HASH_A, "", "-\t-\tassets/logo.png", ""].join("\n");

    const result = await gitStatsImpl({ repoPath: WORKDIR }, makeDeps(output));

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("assets/logo.png");
    expect(result.files[0]?.insertions).toBe(0);
    expect(result.files[0]?.deletions).toBe(0);
    expect(result.files[0]?.commits).toBe(1);
  });

  test("nameOnly mode parses bare paths with zero churn", async () => {
    const output = [HASH_A, "", "src/domain/foo.ts", "src/domain/bar.ts", ""].join("\n");

    const result = await gitStatsImpl({ repoPath: WORKDIR, nameOnly: true }, makeDeps(output));

    expect(result.nameOnly).toBe(true);
    expect(result.files).toHaveLength(2);
    for (const f of result.files) {
      expect(f.insertions).toBe(0);
      expect(f.deletions).toBe(0);
      expect(f.commits).toBe(1);
    }
  });

  test("applies limit after sorting by churn", async () => {
    const output = [
      HASH_A,
      "",
      "1\t1\tsrc/small.ts",
      "50\t20\tsrc/hot.ts",
      "5\t5\tsrc/medium.ts",
      "",
    ].join("\n");

    const result = await gitStatsImpl({ repoPath: WORKDIR, limit: 1 }, makeDeps(output));

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("src/hot.ts");
  });

  test("returns empty result when no commits touched the window", async () => {
    const result = await gitStatsImpl({ repoPath: WORKDIR }, makeDeps(""));

    expect(result.totalCommits).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  test("builds the git command with --no-renames, --numstat, and window filters", async () => {
    const { deps, commands } = makeCapturingDeps("");

    await gitStatsImpl(
      {
        repoPath: WORKDIR,
        since: "2024-01-01",
        until: "2024-02-01",
        path: "src",
        author: "eugene",
      },
      deps
    );

    expect(commands).toHaveLength(1);
    const cmd = commands[0] ?? "";
    expect(cmd).toContain("--no-renames");
    expect(cmd).toContain("--numstat");
    expect(cmd).toContain("--pretty=format:%H");
    expect(cmd).toContain("--since='2024-01-01'");
    expect(cmd).toContain("--until='2024-02-01'");
    expect(cmd).toContain("--author='eugene'");
    expect(cmd).toContain("-- 'src'");
  });

  test("builds the git command with --name-only when nameOnly is set", async () => {
    const { deps, commands } = makeCapturingDeps("");

    await gitStatsImpl({ repoPath: WORKDIR, nameOnly: true }, deps);

    const cmd = commands[0] ?? "";
    expect(cmd).toContain("--name-only");
    expect(cmd).not.toContain("--numstat");
  });
});
