import { describe, test, expect } from "bun:test";
import {
  pushImpl,
  pushWithConfirmation,
  DEFAULT_PUSH_CONFIRM_TIMEOUT_MS,
  verifyRemoteRefAdvanced,
  type PushDependencies,
} from "./push-operations";

const WORKDIR = "/tmp/work";
const CMD_REV_PARSE_BRANCH = `git -C '/tmp/work' rev-parse --abbrev-ref HEAD`;
const CMD_REV_PARSE_SHORT = `git -C '/tmp/work' rev-parse --short HEAD`;
const CMD_REV_PARSE_HEAD = `git -C '/tmp/work' rev-parse HEAD`;
const CMD_REMOTE = `git -C '/tmp/work' remote`;
const RX_PUSH = /^git -C '\/tmp\/work' push /;
const RX_LS_REMOTE = /^git -C '\/tmp\/work' ls-remote /;

/** Sentinel handler value: the mocked exec call never resolves (mt#3177 — forces the
 * "push timed out" / "verification timed out" branches deterministically, no real wait). */
const HANG = Symbol("hang");

type ExecCall = { command: string };
type Handler = { stdout: string; stderr?: string } | Error | typeof HANG;
type HandlerKey = string | RegExp;
type HandlerEntry = [HandlerKey, Handler];

// Anchored / exact matching: keys are either exact strings (matched via
// command === key) or RegExp (matched via key.test(command)). Substring
// matching is intentionally absent so accidental extra flags can't be
// silently absorbed by a handler.
function makeDeps(handlers: HandlerEntry[]): {
  deps: PushDependencies;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const deps: PushDependencies = {
    async execAsync(command: string) {
      calls.push({ command });
      for (const [key, result] of handlers) {
        const matched = typeof key === "string" ? command === key : key.test(command);
        if (matched) {
          if (result === HANG) return new Promise(() => {}); // never resolves
          if (result instanceof Error) throw result;
          return { stdout: result.stdout, stderr: result.stderr ?? "" };
        }
      }
      throw new Error(`Unhandled exec call: ${command}`);
    },
  };
  return { deps, calls };
}

describe("pushImpl", () => {
  test("is defined and takes 2 parameters", () => {
    expect(pushImpl).toBeDefined();
    expect(pushImpl.length).toBe(2);
  });

  test("throws actionable error on detached HEAD with current SHA", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "HEAD\n" }],
      [CMD_REV_PARSE_SHORT, { stdout: "abc1234\n" }],
    ]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Cannot push: HEAD is detached in \/tmp\/work \(currently at abc1234\).*(?:git switch|git checkout -b)/s
    );

    expect(calls.every((c) => c.command !== CMD_REMOTE)).toBe(true);
    expect(calls.every((c) => !RX_PUSH.test(c.command))).toBe(true);
  });

  test("detached-HEAD message omits SHA suffix when rev-parse --short fails", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "HEAD\n" }],
      [CMD_REV_PARSE_SHORT, new Error("rev-parse --short failed")],
    ]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Cannot push: HEAD is detached in \/tmp\/work\. /
    );
  });

  test("propagates the original rev-parse error unchanged (preserves type/stack/fields)", async () => {
    class GitExecError extends Error {
      stderr = "fatal: not a git repository (or any of the parent directories)";
      code = 128;
    }
    const original = new GitExecError("Command failed");
    const { deps } = makeDeps([[CMD_REV_PARSE_BRANCH, original]]);

    let caught: unknown;
    try {
      await pushImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
    expect((caught as GitExecError).code).toBe(128);
    expect((caught as GitExecError).stderr).toMatch(/not a git repository/);
  });

  test("propagates the original push error unchanged for unrecognized stderr", async () => {
    class GitExecError extends Error {
      stderr = "fatal: unable to access 'https://example/': SSL connection error";
      code = 128;
    }
    const original = new GitExecError("push failed");
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "feature/x\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, original],
    ]);

    let caught: unknown;
    try {
      await pushImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
    expect((caught as GitExecError).code).toBe(128);
    expect((caught as GitExecError).stderr).toMatch(/SSL connection error/);
  });

  test("rewrites push error to actionable message when stderr contains '[rejected]'", async () => {
    class GitExecError extends Error {
      stderr = "! [rejected]   task/mt-1356 -> task/mt-1356 (non-fast-forward)";
    }
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-1356\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, new GitExecError("push failed")],
    ]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Push was rejected by the remote/
    );
  });

  test("rewrites push error to actionable message when stderr contains 'no upstream'", async () => {
    class GitExecError extends Error {
      stderr = "fatal: The current branch has no upstream branch.";
    }
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-1356\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, new GitExecError("push failed")],
    ]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /No upstream branch is set/
    );
  });

  test("succeeds for normal attached HEAD on a fresh branch", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-994\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, { stdout: "" }],
    ]);

    const result = await pushImpl({ repoPath: WORKDIR }, deps);

    expect(result).toEqual({ workdir: WORKDIR, pushed: true });
    const pushCall = calls.find((c) => RX_PUSH.test(c.command));
    expect(pushCall?.command).toBe(`git -C '/tmp/work' push 'origin' 'task/mt-994'`);
  });

  test("appends --force when options.force is true", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-994\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, { stdout: "" }],
    ]);

    await pushImpl({ repoPath: WORKDIR, force: true }, deps);

    const pushCall = calls.find((c) => RX_PUSH.test(c.command));
    expect(pushCall?.command).toBe(`git -C '/tmp/work' push 'origin' 'task/mt-994' --force`);
  });

  test("targets the configured remote when options.remote is non-default", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "feature/x\n" }],
      [CMD_REMOTE, { stdout: "origin\nupstream\n" }],
      [RX_PUSH, { stdout: "" }],
    ]);

    await pushImpl({ repoPath: WORKDIR, remote: "upstream" }, deps);

    const pushCall = calls.find((c) => RX_PUSH.test(c.command));
    expect(pushCall?.command).toBe(`git -C '/tmp/work' push 'upstream' 'feature/x'`);
  });

  test("throws when configured remote does not exist", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-994\n" }],
      [CMD_REMOTE, { stdout: "upstream\n" }],
    ]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Remote 'origin' does not exist/
    );
  });

  test("throws when rev-parse returns an empty branch name", async () => {
    const { deps } = makeDeps([[CMD_REV_PARSE_BRANCH, { stdout: "\n" }]]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /rev-parse returned an empty branch name/
    );
  });

  test("handles workdir with spaces", async () => {
    const SPACE_WORKDIR = "/tmp/work dir";
    const SP_RP = `git -C '/tmp/work dir' rev-parse --abbrev-ref HEAD`;
    const SP_REMOTE = `git -C '/tmp/work dir' remote`;
    const SP_PUSH = /^git -C '\/tmp\/work dir' push /;

    const { deps, calls } = makeDeps([
      [SP_RP, { stdout: "task/mt-1356\n" }],
      [SP_REMOTE, { stdout: "origin\n" }],
      [SP_PUSH, { stdout: "" }],
    ]);

    const result = await pushImpl({ repoPath: SPACE_WORKDIR }, deps);

    expect(result).toEqual({ workdir: SPACE_WORKDIR, pushed: true });
    const pushCall = calls.find((c) => SP_PUSH.test(c.command));
    expect(pushCall?.command).toBe(`git -C '/tmp/work dir' push 'origin' 'task/mt-1356'`);
  });

  test("handles remote and branch with spaces (shell-arg quoting end-to-end)", async () => {
    const FUNNY_REMOTE = "weird remote";
    const FUNNY_BRANCH = "feature/with space";
    const RP = `git -C '/tmp/work' rev-parse --abbrev-ref HEAD`;
    const REMOTE_LIST = `git -C '/tmp/work' remote`;
    const PUSH = `git -C '/tmp/work' push 'weird remote' 'feature/with space'`;

    const { deps, calls } = makeDeps([
      [RP, { stdout: `${FUNNY_BRANCH}\n` }],
      [REMOTE_LIST, { stdout: `${FUNNY_REMOTE}\n` }],
      [PUSH, { stdout: "" }],
    ]);

    const result = await pushImpl({ repoPath: WORKDIR, remote: FUNNY_REMOTE }, deps);

    expect(result).toEqual({ workdir: WORKDIR, pushed: true });
    const pushCall = calls.find((c) => c.command.startsWith("git -C '/tmp/work' push"));
    expect(pushCall?.command).toBe(PUSH);
  });

  test("includes credential override flags when authToken is set (mt#1477)", async () => {
    const token = "ghs_test_token_abc123";
    const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-1477\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [/^git -C '\/tmp\/work' -c credential\.helper= -c/, { stdout: "" }],
    ]);

    const result = await pushImpl({ repoPath: WORKDIR, authToken: token }, deps);

    expect(result).toEqual({ workdir: WORKDIR, pushed: true });
    const pushCall = calls.find((c) => c.command.includes("push"));
    expect(pushCall).toBeDefined();
    expect(pushCall?.command).toContain("-c credential.helper=");
    expect(pushCall?.command).toContain(`AUTHORIZATION: basic ${encoded}`);
    expect(pushCall?.command).toContain("http.https://github.com/.extraheader=");
    expect(pushCall?.command).toContain("push 'origin' 'task/mt-1477'");
  });

  test("does not include credential flags when authToken is absent", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-1477\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [`git -C '/tmp/work' push 'origin' 'task/mt-1477'`, { stdout: "" }],
    ]);

    const result = await pushImpl({ repoPath: WORKDIR }, deps);

    expect(result).toEqual({ workdir: WORKDIR, pushed: true });
    const pushCall = calls.find((c) => c.command.includes("push"));
    expect(pushCall?.command).not.toContain("credential.helper");
    expect(pushCall?.command).not.toContain("extraheader");
  });
});

// ---------------------------------------------------------------------------
// verifyRemoteRefAdvanced (mt#3177)
// ---------------------------------------------------------------------------

describe("verifyRemoteRefAdvanced", () => {
  const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  test("confirmed:true when the remote branch head matches expectedSha", async () => {
    const { deps } = makeDeps([[RX_LS_REMOTE, { stdout: `${SHA_A}\trefs/heads/task/mt-3177\n` }]]);

    const result = await verifyRemoteRefAdvanced(WORKDIR, "task/mt-3177", SHA_A, deps);

    expect(result).toEqual({ confirmed: true, remoteSha: SHA_A });
  });

  test("confirmed:false (with remoteSha) when the remote head does not match", async () => {
    const { deps } = makeDeps([[RX_LS_REMOTE, { stdout: `${SHA_B}\trefs/heads/task/mt-3177\n` }]]);

    const result = await verifyRemoteRefAdvanced(WORKDIR, "task/mt-3177", SHA_A, deps);

    expect(result).toEqual({ confirmed: false, remoteSha: SHA_B });
  });

  test("confirmed:false with checkError when ls-remote returns no matching ref", async () => {
    const { deps } = makeDeps([[RX_LS_REMOTE, { stdout: "" }]]);

    const result = await verifyRemoteRefAdvanced(WORKDIR, "task/mt-3177", SHA_A, deps);

    expect(result.confirmed).toBe(false);
    expect(result.remoteSha).toBeUndefined();
    expect(result.checkError).toMatch(/no matching ref/);
  });

  test("confirmed:false with checkError when ls-remote throws (network failure)", async () => {
    const { deps } = makeDeps([[RX_LS_REMOTE, new Error("ssh: connect to host timed out")]]);

    const result = await verifyRemoteRefAdvanced(WORKDIR, "task/mt-3177", SHA_A, deps);

    expect(result.confirmed).toBe(false);
    expect(result.checkError).toMatch(/connect to host timed out/);
  });

  test("confirmed:false with checkError when the ls-remote call itself hangs past timeoutMs", async () => {
    const { deps } = makeDeps([[RX_LS_REMOTE, HANG]]);

    // Real (tiny) timeoutMs — no injected fake timeout signal needed since the
    // mocked exec call never resolves on its own; the real setTimeout wins the
    // race almost instantly. Mirrors the existing commit-phase-timeout test's
    // "slow real operation + tiny real timeout" pattern in
    // session-commit-push-outcome.test.ts.
    const result = await verifyRemoteRefAdvanced(WORKDIR, "task/mt-3177", SHA_A, deps, {
      timeoutMs: 20,
    });

    expect(result.confirmed).toBe(false);
    expect(result.checkError).toMatch(/exceeded 20ms/);
  });

  test("queries refs/heads/<branch> on the configured remote (default origin)", async () => {
    const { deps, calls } = makeDeps([[RX_LS_REMOTE, { stdout: `${SHA_A}\trefs/heads/foo\n` }]]);

    await verifyRemoteRefAdvanced(WORKDIR, "foo", SHA_A, deps);

    const call = calls.find((c) => RX_LS_REMOTE.test(c.command));
    expect(call?.command).toBe(`git -C '/tmp/work' ls-remote 'origin' 'refs/heads/foo'`);
  });

  test("honors an explicit remote override", async () => {
    const { deps, calls } = makeDeps([[RX_LS_REMOTE, { stdout: `${SHA_A}\trefs/heads/foo\n` }]]);

    await verifyRemoteRefAdvanced(WORKDIR, "foo", SHA_A, deps, { remote: "upstream" });

    const call = calls.find((c) => RX_LS_REMOTE.test(c.command));
    expect(call?.command).toBe(`git -C '/tmp/work' ls-remote 'upstream' 'refs/heads/foo'`);
  });
});

// ---------------------------------------------------------------------------
// pushWithConfirmation (mt#3177 acceptance tests)
// ---------------------------------------------------------------------------

describe("pushWithConfirmation", () => {
  const LOCAL_SHA = "cccccccccccccccccccccccccccccccccccccccc";

  test("passes through a direct success unchanged (no confirmation fields set)", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3177\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, { stdout: "" }],
    ]);

    // mt#3480 added always-on timing fields, so the exact-shape assertion now
    // includes them. An injected clock keeps `elapsedMs` exact rather than a
    // range, which would be flaky on a loaded machine.
    let clock = 1000;
    deps.now = () => clock;
    const result = await pushWithConfirmation(
      { repoPath: WORKDIR },
      {
        ...deps,
        execAsync: async (cmd: string, opts?: Record<string, unknown>) => {
          clock += 250;
          return deps.execAsync(cmd, opts);
        },
      }
    );

    expect(result).toEqual({
      workdir: WORKDIR,
      pushed: true,
      elapsedMs: 750,
      pushTimeoutMs: DEFAULT_PUSH_CONFIRM_TIMEOUT_MS,
    });
    // No phase is named on a clean success — there is nothing to disambiguate.
    expect(result.timedOutDuring).toBeUndefined();
  });

  test("mt#3480: a timed-out push reports elapsed time, the bound, and the phase", async () => {
    // The gap this closes: a bare `pushTimedOut: true` reads as "hung" and cost
    // a multi-round investigation before a longer bound showed the push was
    // merely SLOW. Elapsed-vs-bound is what makes "how much longer does it
    // need?" the obvious next question.
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3480\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, HANG],
      [CMD_REV_PARSE_HEAD, { stdout: `${LOCAL_SHA}\n` }],
      [
        RX_LS_REMOTE,
        { stdout: `dddddddddddddddddddddddddddddddddddddddd\trefs/heads/task/mt-3480\n` },
      ],
    ]);

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps, {
      pushTimeoutMs: 20,
      verifyTimeoutMs: 20,
    });

    expect(result.pushUnconfirmed).toBe(true);
    expect(result.pushTimeoutMs).toBe(20);
    expect(result.timedOutDuring).toBe("push");
    // Elapsed is at least the bound — the call cannot have returned sooner.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(20);
  });

  test("mt#3480: a slow-but-confirmed push also reports timing", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3480\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, HANG],
      [CMD_REV_PARSE_HEAD, { stdout: `${LOCAL_SHA}\n` }],
      // Remote HAS advanced to the local sha — the push landed despite the bound.
      [RX_LS_REMOTE, { stdout: `${LOCAL_SHA}\trefs/heads/task/mt-3480\n` }],
    ]);

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps, {
      pushTimeoutMs: 20,
      verifyTimeoutMs: 20,
    });

    expect(result.pushed).toBe(true);
    expect(result.pushConfirmedVia).toBe("remote-check");
    expect(result.pushTimeoutMs).toBe(20);
    // "push" not "remote-verify": the PUSH is what ran out of time; the check
    // then succeeded. Naming it stops a reader blaming the verification.
    expect(result.timedOutDuring).toBe("push");
  });

  test("mt#3480: a definite push error reports timing too, and names no phase", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3480\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, new Error("fatal: unable to access")],
    ]);

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps);

    expect(result.pushError).toMatch(/unable to access/);
    expect(result.pushTimeoutMs).toBe(DEFAULT_PUSH_CONFIRM_TIMEOUT_MS);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    // Nothing timed out, so there is no phase to report.
    expect(result.timedOutDuring).toBeUndefined();
  });

  test("passes through a definite push error unchanged — no remote-check attempted", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3177\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, new Error("fatal: unable to access: SSL connection error")],
    ]);

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps);

    expect(result.pushed).toBe(false);
    expect(result.pushError).toMatch(/SSL connection error/);
    expect(result.pushTimedOut).toBeFalsy();
    expect(result.pushUnconfirmed).toBeFalsy();
    expect(calls.some((c) => RX_LS_REMOTE.test(c.command))).toBe(false);
  });

  // Acceptance test 1 (mt#3177 spec): "With the push path forced to hang
  // (inject a never-resolving push in a seam), session_commit reports the
  // unambiguous unconfirmed state" — exercised here at the pushWithConfirmation
  // seam sessionCommit itself delegates to (via pushFromParamsWithConfirmation).
  test("AT1: push hangs and remote-check does NOT confirm -> pushUnconfirmed:true, pushed:false", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3177\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, HANG],
      [CMD_REV_PARSE_HEAD, { stdout: `${LOCAL_SHA}\n` }],
      // Remote hasn't advanced — still on some older sha.
      [
        RX_LS_REMOTE,
        { stdout: `dddddddddddddddddddddddddddddddddddddddd\trefs/heads/task/mt-3177\n` },
      ],
    ]);

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps, {
      pushTimeoutMs: 20,
      verifyTimeoutMs: 20,
    });

    expect(result.pushed).toBe(false);
    expect(result.pushTimedOut).toBe(true);
    expect(result.pushUnconfirmed).toBe(true);
    expect(result.pushConfirmedVia).toBeUndefined();
  });

  // Acceptance test 2 (mt#3177 spec): "with a mocked remote-ref check
  // confirming advancement it reports confirmed-pushed."
  test("AT2: push hangs but remote-check confirms it landed -> pushed:true, pushConfirmedVia:remote-check", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3177\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, HANG],
      [CMD_REV_PARSE_HEAD, { stdout: `${LOCAL_SHA}\n` }],
      // Remote already matches the local commit that was being pushed.
      [RX_LS_REMOTE, { stdout: `${LOCAL_SHA}\trefs/heads/task/mt-3177\n` }],
    ]);

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps, {
      pushTimeoutMs: 20,
      verifyTimeoutMs: 20,
    });

    expect(result.pushed).toBe(true);
    expect(result.pushTimedOut).toBe(true);
    expect(result.pushConfirmedVia).toBe("remote-check");
    expect(result.pushUnconfirmed).toBeUndefined();
  });

  test("uses config.branch when supplied, skipping a SECOND rev-parse --abbrev-ref HEAD call", async () => {
    // pushImpl itself always needs ONE rev-parse --abbrev-ref HEAD call to
    // build the push command (unaffected by config.branch). What config.branch
    // skips is the VERIFICATION step's own resolution of the branch — without
    // it, resolveVerificationTarget would issue a SECOND identical call.
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3177\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, HANG],
      [CMD_REV_PARSE_HEAD, { stdout: `${LOCAL_SHA}\n` }],
      [RX_LS_REMOTE, { stdout: `${LOCAL_SHA}\trefs/heads/task/mt-3177\n` }],
    ]);

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps, {
      pushTimeoutMs: 20,
      verifyTimeoutMs: 20,
      branch: "task/mt-3177",
    });

    expect(result.pushed).toBe(true);
    expect(result.pushConfirmedVia).toBe("remote-check");
    // Exactly one rev-parse --abbrev-ref HEAD call (pushImpl's own) — not two.
    expect(calls.filter((c) => c.command === CMD_REV_PARSE_BRANCH)).toHaveLength(1);
  });

  test("does not attempt verification when the branch cannot be resolved (detached HEAD)", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "HEAD\n" }],
      [CMD_REV_PARSE_SHORT, { stdout: "abc1234\n" }],
    ]);

    // pushImpl itself throws synchronously on detached HEAD (not a timeout),
    // so this exercises the "definite error, no verification" branch too —
    // included here specifically to confirm ls-remote is never called.
    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps);

    expect(result.pushed).toBe(false);
    expect(result.pushError).toMatch(/detached/);
    expect(calls.some((c) => RX_LS_REMOTE.test(c.command))).toBe(false);
  });

  // mt#3177 R1 review (PR #2297): the first version of resolveVerificationTarget
  // left its two LOCAL `rev-parse` calls completely unbounded — only the push
  // call and the remote ls-remote check were bounded. A local git command can
  // hang too (index lock, stalled filesystem/NFS mount, concurrent `git gc`),
  // which would have silently reintroduced an unbounded wait exactly where this
  // task exists to remove one. These two tests force each local rev-parse call
  // to hang and confirm pushWithConfirmation still returns within the bound
  // instead of hanging, degrading to the explicit pushUnconfirmed state.
  test("bounds the SHA-resolution rev-parse call when it hangs -> pushUnconfirmed:true", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3177\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, HANG],
      // config.branch is supplied below, so resolveVerificationTarget skips
      // its OWN branch-resolution call and goes straight to this SHA lookup —
      // which hangs, isolating this test to exactly the call under test.
      [CMD_REV_PARSE_HEAD, HANG],
    ]);

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps, {
      pushTimeoutMs: 20,
      verifyTimeoutMs: 20,
      branch: "task/mt-3177",
    });

    expect(result.pushed).toBe(false);
    expect(result.pushTimedOut).toBe(true);
    expect(result.pushUnconfirmed).toBe(true);
    expect(result.pushConfirmedVia).toBeUndefined();
    // The hung rev-parse never resolved a SHA, so ls-remote must never fire —
    // proves the bound actually short-circuited verification rather than
    // racing ls-remote in parallel with a still-hanging local call.
    expect(calls.some((c) => RX_LS_REMOTE.test(c.command))).toBe(false);
  });

  test("bounds the branch-resolution rev-parse call when it hangs -> pushUnconfirmed:true", async () => {
    // No config.branch supplied here, AND rev-parse --abbrev-ref HEAD hangs
    // for EVERY call — including pushImpl's own FIRST call (made before the
    // push step even runs). So the outer pushTimeoutMs race times out on
    // pushImpl itself (never reaching the push command at all), and the
    // verification phase's OWN attempt to resolve the branch (config.branch
    // omitted) hits the exact same hanging command a second time — bounded
    // independently by verifyTimeoutMs this time.
    const { deps, calls } = makeDeps([[CMD_REV_PARSE_BRANCH, HANG]]);

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps, {
      pushTimeoutMs: 20,
      verifyTimeoutMs: 20,
    });

    expect(result.pushed).toBe(false);
    expect(result.pushTimedOut).toBe(true);
    expect(result.pushUnconfirmed).toBe(true);
    expect(result.pushConfirmedVia).toBeUndefined();
    // Never got far enough to resolve a SHA or query the remote.
    expect(calls.some((c) => c.command === CMD_REV_PARSE_HEAD)).toBe(false);
    expect(calls.some((c) => RX_LS_REMOTE.test(c.command))).toBe(false);
  });
});
