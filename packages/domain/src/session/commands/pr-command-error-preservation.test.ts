/**
 * mt#4307: `sessionPr` must not report every `ValidationError` as a
 * session-resolution failure.
 *
 * The translation used to sit on a `try` wrapping the whole operation, so a
 * ValidationError raised by ANY later stage came out as "No session detected.
 * Please provide a session ID (--sessionId), task ID (--task), …" — a claim that
 * was false, and misleading in the specific way that costs the most: it names as
 * missing the very thing the caller supplied. `session_pr_create` failed four
 * times in a row this way, including when passed an explicit `--sessionId`, while
 * `session_get --task` resolved that same session throughout.
 *
 * Note the asymmetry that let it survive: the message being DISCARDED
 * (`Failed to read body content from file: …`) was asserted by ZERO tests, while
 * the message that discarded it was asserted by four. This file is the missing
 * half.
 */
/* eslint-disable custom/no-real-fs-in-tests -- The behavior under test is path
   RESOLUTION: whether a relative bodyPath is read against the session workspace or
   the process cwd. An in-memory fs would answer whatever it was told and could not
   fail, which is the defect this file pins. */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { sessionPr } from "./pr-command";
import { FakeSessionProvider } from "../fake-session-provider";
import { FakeGitService } from "../../git/fake-git-service";
import { ValidationError } from "../../errors/index";
import type { SessionRecord } from "../types";

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const SESSION_ID = "pr-error-preservation-session";
const BODY_TEXT = "## Summary\n\nA body written into the session workspace.\n";

function makeSessionRecord(): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoName: "test-repo",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#4307",
    branch: "task/mt-4307",
  };
}

async function makeWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-pr-body-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Deps wired so PR preparation itself is a no-op unless a test overrides it —
 * the DI hook `sessionPrImpl` already exists on this function for exactly this
 * reason (mt#4046).
 */
function makeDeps(workdir: string, prImpl?: () => Promise<never>) {
  return {
    sessionDB: new FakeSessionProvider({
      initialSessions: [makeSessionRecord()],
      sessionWorkdir: workdir,
    }),
    gitService: new FakeGitService({ defaultBranch: "task/mt-4307", sessionWorkdir: workdir }),
    sessionPrImpl: (prImpl ??
      (async () => ({ prBranch: "pr/task/mt-4307", baseBranch: "main" }))) as never,
  };
}

async function capture(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected sessionPr to throw");
}

describe("sessionPr — a relative bodyPath resolves against the session workspace (mt#4307)", () => {
  test("reads a body file written into the session workspace", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, ".pr-body-mt4307.md"), BODY_TEXT);

    let seenBody: string | undefined;
    const deps = makeDeps(workdir);
    deps.sessionPrImpl = (async (params: { body?: string }) => {
      seenBody = params.body;
      return { prBranch: "pr/task/mt-4307", baseBranch: "main" };
    }) as never;

    await sessionPr(
      { session: SESSION_ID, title: "A title", bodyPath: ".pr-body-mt4307.md" } as never,
      deps as never
    );

    // Before mt#4307 this path was resolved against the MCP server's cwd — the
    // MAIN repo — where the file does not exist, so the read failed every time.
    expect(seenBody).toBe(BODY_TEXT);
  });

  test("an unreadable bodyPath names the FILE, not a session-resolution failure", async () => {
    const workdir = await makeWorkdir();
    const deps = makeDeps(workdir);

    const error = await capture(() =>
      sessionPr(
        { session: SESSION_ID, title: "A title", bodyPath: "no-such-body.md" } as never,
        deps as never
      )
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain("Failed to read body content from file");
    expect(error.message).toContain("no-such-body.md");
    // The regression itself: this precise, correct, actionable message was
    // manufactured and then destroyed by the same function.
    expect(error.message).not.toContain("No session detected");
  });

  test("a relative bodyPath that escapes the workspace via `..` is refused (PR #3201 R1)", async () => {
    const workdir = await makeWorkdir();
    // A file that genuinely exists OUTSIDE the workspace, so a passing read would
    // be a real escape rather than a missing-file error wearing the same clothes.
    const outside = await makeWorkdir();
    await writeFile(join(outside, "secret.md"), "not yours\n");
    const escaping = join("..", outside.split("/").pop() ?? "", "secret.md");

    const deps = makeDeps(workdir);
    const error = await capture(() =>
      sessionPr(
        { session: SESSION_ID, title: "A title", bodyPath: escaping } as never,
        deps as never
      )
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain("escapes the session workspace");
    // The refusal must not be mistakable for "the file isn't there".
    expect(error.message).not.toContain("Failed to read body content");
  });

  test("an ABSOLUTE path outside the workspace is still honored", async () => {
    // Containment applies to the RELATIVE branch only: an absolute path is the
    // explicit way to say "elsewhere", so the check costs no capability. This
    // very PR's body was passed that way.
    const workdir = await makeWorkdir();
    const outside = await makeWorkdir();
    const absolute = join(outside, "body.md");
    await writeFile(absolute, BODY_TEXT);

    let seenBody: string | undefined;
    const deps = makeDeps(workdir);
    deps.sessionPrImpl = (async (params: { body?: string }) => {
      seenBody = params.body;
      return { prBranch: "pr/task/mt-4307", baseBranch: "main" };
    }) as never;

    await sessionPr(
      { session: SESSION_ID, title: "A title", bodyPath: absolute } as never,
      deps as never
    );

    expect(seenBody).toBe(BODY_TEXT);
  });

  test("the error names BOTH the given path and the one actually read", async () => {
    const workdir = await makeWorkdir();
    const deps = makeDeps(workdir);

    const error = await capture(() =>
      sessionPr(
        { session: SESSION_ID, title: "A title", bodyPath: "no-such-body.md" } as never,
        deps as never
      )
    );

    // Which of the two is wrong is the whole question when this fires.
    expect(error.message).toContain(join(workdir, "no-such-body.md"));
  });
});

describe("sessionPr — a later-stage ValidationError is not relabelled (mt#4307)", () => {
  test("a ValidationError from PR preparation propagates with its own message", async () => {
    const workdir = await makeWorkdir();
    const deps = makeDeps(workdir, async () => {
      throw new ValidationError("PR title must not be empty");
    });

    const error = await capture(() =>
      sessionPr({ session: SESSION_ID, title: "A title" } as never, deps as never)
    );

    expect(error.message).toContain("PR title must not be empty");
    // The old wide catch turned every one of these into the same false sentence.
    expect(error.message).not.toContain("No session detected");
  });
});
