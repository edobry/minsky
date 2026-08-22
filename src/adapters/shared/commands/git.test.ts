import { describe, test, expect } from "bun:test";
import { buildGitLogArgs, buildGitPathHistoryProbeArgs, probeGitLogPathHistory } from "./git";

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

describe("buildGitPathHistoryProbeArgs (mt#4422)", () => {
  test("builds a rev-list count over all refs, with the pathspec after --", () => {
    const cmd = buildGitPathHistoryProbeArgs({ repo: "/tmp/work", path: "src/domain" }).join(" ");

    expect(cmd).toBe("git -C '/tmp/work' rev-list --all --count -- 'src/domain'");
  });

  test("quotes a pathspec containing spaces as a single token", () => {
    const cmd = buildGitPathHistoryProbeArgs({
      repo: "/tmp/work",
      path: "a.ts b.ts",
    }).join(" ");

    // The whole thing is ONE pathspec — which is exactly why such a call
    // matches nothing and why this probe is what catches it.
    expect(cmd).toContain("-- 'a.ts b.ts'");
  });
});

/**
 * The DECISION is what these assert — count 0 rejects, count > 0 allows, a
 * broken probe allows — with the subprocess injected, so nothing here touches a
 * real repository.
 *
 * What is deliberately NOT asserted here is git's own behaviour: that
 * `git log -- <pathspec>` exits 0 with empty output on an unmatched pathspec,
 * and that a deleted file still reports history. A double reproducing those
 * would be asserting a model of git rather than git (ADR-036). That half is
 * checked against a real repository by
 * `scripts/verify-git-log-path-precondition.ts`, whose live output is in the PR.
 */
describe("probeGitLogPathHistory (mt#4422)", () => {
  const repo = "/tmp/work";

  /** An injected probe that reports `count` commits, recording the command. */
  function probeReturning(count: string) {
    const calls: string[] = [];
    return {
      calls,
      exec: async (cmd: string) => {
        calls.push(cmd);
        return { stdout: `${count}\n` };
      },
    };
  }

  test("AT1: reports unmatched for a pathspec no commit has ever touched (count 0)", async () => {
    const verdict = await probeGitLogPathHistory(
      { repo, path: "src/never-existed.ts" },
      probeReturning("0")
    );

    expect(verdict).toEqual({ checked: true, matched: false, commitCount: 0 });
  });

  test("AT1 negative control: a pathspec WITH history is reported matched", async () => {
    // The control that matters: an implementation that reported everything
    // unmatched would pass AT1 and fail here.
    const verdict = await probeGitLogPathHistory(
      { repo, path: "src/real.ts" },
      probeReturning("73")
    );

    expect(verdict).toEqual({ checked: true, matched: true, commitCount: 73 });
  });

  test("AT2: a DELETED path reports matched — history, not current tracking, decides", async () => {
    // The real fixture behind this: a deleted file reports
    // `ls-files --error-unmatch` exit 1 while `rev-list --all --count` is > 0.
    // Using ls-files would report it unmatched — the false positive this pins
    // against, and the reason `git log` must still return its commits.
    const verdict = await probeGitLogPathHistory(
      { repo, path: "packages/deleted.ts" },
      probeReturning("2")
    );

    expect(verdict).toEqual({ checked: true, matched: true, commitCount: 2 });
  });

  test("AT3: no path supplied — the probe never runs at all", async () => {
    const probe = probeReturning("0");
    const verdict = await probeGitLogPathHistory({ repo }, probe);

    expect(verdict).toEqual({ checked: false, reason: "no-path" });
    // Not merely the right verdict: the subprocess was never spawned, which is
    // what keeps the common no-path call free.
    expect(probe.calls).toHaveLength(0);
  });

  test("AT4: a space-separated path LIST reports unmatched, and went out as ONE pathspec", async () => {
    const probe = probeReturning("0");
    const verdict = await probeGitLogPathHistory({ repo, path: "a.ts b.ts" }, probe);

    expect(verdict).toEqual({ checked: true, matched: false, commitCount: 0 });
    // Why it can never match: quoted as a single filename containing a space.
    expect(probe.calls[0]).toContain("-- 'a.ts b.ts'");
  });

  test("a broken probe reports checked:false — NOT matched:false", async () => {
    // The distinction the verdict type exists for: "I could not find out" must
    // not be reported as "nothing ever touched this path" (mem#704).
    const verdict = await probeGitLogPathHistory(
      { repo, path: "src/real.ts" },
      {
        exec: async () => {
          throw new Error("fatal: not a git repository");
        },
      }
    );

    expect(verdict).toEqual({ checked: false, reason: "probe-unavailable" });
  });

  test("a non-numeric count is the probe failing a second way, not an unmatched path", async () => {
    const verdict = await probeGitLogPathHistory(
      { repo, path: "src/real.ts" },
      probeReturning("not-a-number")
    );

    expect(verdict).toEqual({ checked: false, reason: "probe-unavailable" });
  });
});
