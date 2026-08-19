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

/**
 * The error shape Node's `exec` actually throws on a failed git command, as
 * `gitErrorSchema` models it: `message`, plus optional `stderr` / `stdout` /
 * `code` / `signal`, with `cmd` among the string extras exec attaches.
 *
 * Shared rather than redeclared per test (PR #3174 R1): several tests below
 * declare their own local `class GitExecError extends Error { stderr = "..." }`
 * carrying only the one field the assertion happens to read, which cannot catch
 * a regression in how the OTHER fields survive. Tests asserting field
 * preservation need an error that actually has fields to preserve.
 */
class GitExecError extends Error {
  override readonly name = "GitExecError";
  stderr: string;
  stdout: string;
  code: number;
  cmd: string;

  constructor(opts: { stderr: string; stdout?: string; code?: number; cmd?: string }) {
    // exec's own message is `Command failed: <cmd>` — the shape mt#3219's
    // redaction exists for, since the cmd carries the injected auth header.
    const cmd = opts.cmd ?? `git -C '${WORKDIR}' push 'origin' 'task/mt-3264'`;
    super(`Command failed: ${cmd}`);
    this.stderr = opts.stderr;
    this.stdout = opts.stdout ?? "";
    this.code = opts.code ?? 128;
    this.cmd = cmd;
  }
}

function makeGitExecError(
  stderr: string,
  opts: { cmd?: string; code?: number } = {}
): GitExecError {
  return new GitExecError({ stderr, ...opts });
}

type ExecCall = { command: string };
type Handler = { stdout: string; stderr?: string } | Error | typeof HANG;
type HandlerKey = string | RegExp;
type HandlerEntry = [HandlerKey, Handler];

/**
 * Deterministic clock for the `deps.now` seam (mt#3551).
 *
 * `pushWithConfirmation` samples the clock once on entry and once on whichever
 * return path it takes, reporting the difference as `elapsedMs`. Scripting those
 * samples makes the reported value a function of the clock ALONE, so an
 * `elapsedMs` assertion tests the reporting and never the host's timer
 * behaviour — which is what the seam was added for (see the `now` doc comment
 * in push-operations.ts).
 *
 * Reads past the end of the script repeat the final sample: an added
 * intermediate `now()` read then changes the call count without silently
 * changing the asserted elapsed value.
 */
function scriptedClock(...samples: number[]): () => number {
  let index = 0;
  return () => {
    const sample = samples[Math.min(index, samples.length - 1)] as number;
    index++;
    return sample;
  };
}

// Anchored / exact matching: keys are either exact strings (matched via
// command === key) or RegExp (matched via key.test(command)). Substring
// matching is intentionally absent so accidental extra flags can't be
// silently absorbed by a handler.
function makeDeps(
  handlers: HandlerEntry[],
  now?: () => number
): {
  deps: PushDependencies;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const deps: PushDependencies = {
    ...(now ? { now } : {}),
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

  // mt#3264: both rewrites above used to REPLACE git's stderr. Two rejections
  // with different causes and different fixes produced one identical sentence,
  // so the surfaced error could not distinguish them — the reporting half of the
  // incident this task was filed for.
  test("keeps git's own reason alongside the '[rejected]' guidance (mt#3264)", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3264\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [
        RX_PUSH,
        makeGitExecError(
          "! [rejected]   task/mt-3264 -> task/mt-3264 (cannot lock ref 'refs/heads/task/mt-3264': is at 2e5c5d427 but expected dd17eaf22)"
        ),
      ],
    ]);

    let caught: unknown;
    try {
      await pushImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }

    const message = (caught as Error).message;
    expect(message).toMatch(/Push was rejected by the remote/);
    // The part that used to be discarded: a ref-lock conflict is NOT fixed by
    // pulling or force-pushing, and this is the only text that says so.
    expect(message).toContain("cannot lock ref");
    expect(message).toContain("expected dd17eaf22");

    // PR #3174 R1: the rewrite must not re-wrap. A fresh `new Error(...)` drops
    // the prototype, `name`, and the exec extras — the same loss
    // `redactPushError` documents refusing. Consumers branch on these.
    expect(caught).toBeInstanceOf(GitExecError);
    expect((caught as GitExecError).name).toBe("GitExecError");
    expect((caught as GitExecError).stderr).toContain("cannot lock ref");
    expect((caught as GitExecError).code).toBe(128);
    expect((caught as GitExecError).cmd).toContain("push");
  });

  test("keeps git's own reason alongside the 'no upstream' guidance (mt#3264)", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3264\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [
        RX_PUSH,
        makeGitExecError(
          "fatal: The current branch task/mt-3264 has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin task/mt-3264"
        ),
      ],
    ]);

    let caught: unknown;
    try {
      await pushImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }

    const message = (caught as Error).message;
    expect(message).toMatch(/No upstream branch is set/);
    expect(message).toContain("git push --set-upstream origin task/mt-3264");
  });

  test("redacts the injected credential when lifting stderr into the message (mt#3264)", async () => {
    // The stderr is being copied into a NEW Error, which `redactPushError` never
    // sees — so the redaction has to happen here or mt#3219's leak reopens on
    // this path.
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3264\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [
        RX_PUSH,
        makeGitExecError("! [rejected] task/mt-3264 -> task/mt-3264", {
          cmd: "git -c http.https://github.com/.extraheader='AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==' push origin task/mt-3264",
        }),
      ],
    ]);

    let caught: unknown;
    try {
      await pushImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }

    const err = caught as GitExecError;
    const SECRET = "eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==";

    // The credential rides on `cmd` (mt#3219's actual leak path), and these two
    // paths build their own message, so they bypass the fall-through redaction
    // unless they redact themselves. Assert every string channel, not just the
    // one the guidance is written to.
    expect(err.message).not.toContain(SECRET);
    expect(err.cmd).not.toContain(SECRET);
    expect(err.stack ?? "").not.toContain(SECRET);
    expect(err.cmd).toMatch(/AUTHORIZATION: basic/); // redacted, not deleted

    // Still diagnostic after redaction.
    expect(err.message).toContain("task/mt-3264 -> task/mt-3264");
    expect(err.message).toMatch(/Push was rejected by the remote/);
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
    const { deps } = makeDeps(
      [
        [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3480\n" }],
        [CMD_REMOTE, { stdout: "origin\n" }],
        [RX_PUSH, HANG],
        [CMD_REV_PARSE_HEAD, { stdout: `${LOCAL_SHA}\n` }],
        [
          RX_LS_REMOTE,
          { stdout: `dddddddddddddddddddddddddddddddddddddddd\trefs/heads/task/mt-3480\n` },
        ],
      ],
      scriptedClock(1_000_000, 1_000_035)
    );

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps, {
      pushTimeoutMs: 20,
      verifyTimeoutMs: 20,
    });

    expect(result.pushUnconfirmed).toBe(true);
    expect(result.pushTimeoutMs).toBe(20);
    expect(result.timedOutDuring).toBe("push");
    // mt#3551: `elapsedMs` is asserted EXACTLY, against the scripted clock above
    // — not compared to the 20ms bound on the host's wall clock.
    //
    // The previous form was `expect(result.elapsedMs).toBeGreaterThanOrEqual(20)`
    // against a real `Date.now()`. It measured 19 in CI (run 30713264225,
    // 2026-08-01) and failed the required `build` check while this file passed
    // 35/35 locally. Do not "tighten" it back into a wall-clock comparison: the
    // exact mechanism that produces 19 is CI-platform-specific and was NOT
    // reproducible locally (6,000 probe iterations, idle and under load, never
    // went below 20), so any tolerance picked here would be a guess.
    //
    // Nothing about the bound is lost. "The call cannot have returned sooner"
    // is asserted STRUCTURALLY by `timedOutDuring === "push"` on the line above:
    // that value is reachable only when `raceAgainstTimeout` returned
    // `timedOut: true`, i.e. only when the 20ms timer beat the push. What the
    // wall-clock comparison uniquely covered — that `elapsedMs` faithfully
    // reports the interval between the two clock samples — is what this exact
    // assertion now pins, and pins harder than an inequality could.
    expect(result.elapsedMs).toBe(35);
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

  test("mt#3480: reports remote-verify when the CHECK itself times out (PR #2506 R1)", async () => {
    // This value was advertised in the type but unreachable in code — a false
    // affordance no caller could ever observe. Both the push AND the ls-remote
    // check hang here, so the outcome is doubly unknown and the phase must say
    // which one ran out of time.
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3480\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, HANG],
      [CMD_REV_PARSE_HEAD, { stdout: `${LOCAL_SHA}\n` }],
      [RX_LS_REMOTE, HANG],
    ]);

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps, {
      pushTimeoutMs: 20,
      verifyTimeoutMs: 20,
    });

    expect(result.pushUnconfirmed).toBe(true);
    expect(result.timedOutDuring).toBe("remote-verify");
  });

  test("mt#3480: a definite push error reports timing too, and names no phase", async () => {
    const { deps } = makeDeps(
      [
        [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-3480\n" }],
        [CMD_REMOTE, { stdout: "origin\n" }],
        [RX_PUSH, new Error("fatal: unable to access")],
      ],
      scriptedClock(2_000_000, 2_000_007)
    );

    const result = await pushWithConfirmation({ repoPath: WORKDIR }, deps);

    expect(result.pushError).toMatch(/unable to access/);
    expect(result.pushTimeoutMs).toBe(DEFAULT_PUSH_CONFIRM_TIMEOUT_MS);
    // mt#3551: was `toBeGreaterThanOrEqual(0)` — an assertion no elapsed value
    // can fail, so it carried no information about the error path's reporting.
    // The scripted clock makes it exact, and therefore capable of failing.
    expect(result.elapsedMs).toBe(7);
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
