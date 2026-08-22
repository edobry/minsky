/**
 * mt#4417 — `session.commit`'s result is trimmed for MCP and untouched elsewhere.
 *
 * The cases below are built from the ACTUAL stored notification behind the
 * report (session `322e94eb`, turnIndex 177), not from an invented payload, so
 * the size assertion measures the real ratio rather than a made-up one.
 */
import { describe, expect, test } from "bun:test";
import { MAX_WIRE_FILES, shapeCommitResultForTransport } from "./commit-result-transport";

/** The commit body from the observed notification, abridged but same order of magnitude. */
const OBSERVED_MESSAGE = [
  "fix(mt#4342): PR #3233 R1 — ascend to the work tree instead of testing one path",
  "",
  "The reviewer's BLOCKING finding was correct: the probe tested `<repoPath>/.git`,",
  "so a server started anywhere inside a repo other than its root classified",
  "hosted and refused git.* — the same misclassification mt#4342 exists to fix, one",
  "level in.",
  "",
  "The repo already had the right walk. `isInsideGitWorkTree` ascends to find `.git`",
  "and already counts the worktree/submodule FILE form, which a hand-rolled walk",
  "would have had to rediscover.",
].join("\n");

const OBSERVED_SUBJECT =
  "fix(mt#4342): PR #3233 R1 — ascend to the work tree instead of testing one path";

function observedResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    sessionId: "b21c0090-858f-4c0a-b3a1-fe76c093b22d",
    commitHash: "aaf8e4614",
    shortHash: "aaf8e4614",
    subject: OBSERVED_SUBJECT,
    branch: "task/mt-4342",
    message: OBSERVED_MESSAGE,
    filesChanged: 6,
    files: [
      { status: "A", path: "packages/domain/src/utils/git-exec.test.ts" },
      { status: "M", path: "packages/domain/src/utils/git-exec.ts" },
    ],
    pushed: true,
    ...overrides,
  };
}

describe("shapeCommitResultForTransport — non-MCP transports are untouched", () => {
  test("the CLI keeps the full payload, so its own rendering is unaffected", () => {
    const result = observedResult();

    const shaped = shapeCommitResultForTransport(result, OBSERVED_MESSAGE, "cli");

    // Identity, not merely equality: nothing was copied or reshaped on this path.
    expect(shaped).toBe(result);
    expect(shaped.message).toBe(OBSERVED_MESSAGE);
  });

  test("an absent transport keeps the full payload", () => {
    const result = observedResult();

    expect(shapeCommitResultForTransport(result, OBSERVED_MESSAGE, undefined)).toBe(result);
  });
});

describe("shapeCommitResultForTransport — MCP drops only the caller's own echo", () => {
  test("a message byte-identical to the caller's input is dropped and marked", () => {
    const shaped = shapeCommitResultForTransport(observedResult(), OBSERVED_MESSAGE, "mcp");

    expect("message" in shaped).toBe(false);
    expect(shaped.messageOmitted).toBe("echoed-caller-input");
    // The subject is what identifies the commit, and it survives.
    expect(shaped.subject).toBe(OBSERVED_SUBJECT);
  });

  test("the trimmed payload is materially smaller — AT1's size assertion", () => {
    const result = observedResult();

    const before = JSON.stringify(result).length;
    const after = JSON.stringify(
      shapeCommitResultForTransport(result, OBSERVED_MESSAGE, "mcp")
    ).length;

    // The echoed body is the bulk of the payload; asserting a ratio rather than
    // a byte count keeps this from pinning the fixture's exact prose.
    expect(after).toBeLessThan(before / 2);
  });

  test("the source object is not mutated", () => {
    const result = observedResult();

    shapeCommitResultForTransport(result, OBSERVED_MESSAGE, "mcp");

    expect(result.message).toBe(OBSERVED_MESSAGE);
  });
});

describe("shapeCommitResultForTransport — every message the caller did NOT write survives", () => {
  test('"Nothing to commit" is the whole outcome and is kept', () => {
    const shaped = shapeCommitResultForTransport(
      observedResult({ message: "Nothing to commit, working tree clean", nothingToCommit: true }),
      "some commit message the caller sent",
      "mcp"
    );

    expect(shaped.message).toBe("Nothing to commit, working tree clean");
    expect("messageOmitted" in shaped).toBe(false);
  });

  test("the mt#3660 stash-restore warning is kept — dropping it would restore that defect", () => {
    const warning =
      "Committed abc1234 — but restoring work parked by an earlier session_update FAILED" +
      " (the pop conflicted on src/a.ts and was rolled back). That work is still parked" +
      " in refs/stash@{0} and is NOT in this commit.";

    const shaped = shapeCommitResultForTransport(
      observedResult({ message: warning }),
      OBSERVED_MESSAGE,
      "mcp"
    );

    expect(shaped.message).toBe(warning);
  });

  test("an --amend with no supplied message keeps the body git reused", () => {
    const reused = "chore: the previous commit's body, which the caller has never seen";

    const shaped = shapeCommitResultForTransport(
      observedResult({ message: reused }),
      undefined,
      "mcp"
    );

    expect(shaped.message).toBe(reused);
    expect("messageOmitted" in shaped).toBe(false);
  });
});

describe("shapeCommitResultForTransport — the file list is bounded, not dropped", () => {
  const manyFiles = Array.from({ length: MAX_WIRE_FILES + 12 }, (_, i) => ({
    status: "M",
    path: `src/generated/file-${i}.ts`,
  }));

  test("an ordinary commit's file list is returned whole", () => {
    const shaped = shapeCommitResultForTransport(observedResult(), OBSERVED_MESSAGE, "mcp");

    expect(shaped.files).toHaveLength(2);
    expect("filesTruncated" in shaped).toBe(false);
  });

  test("a bulk regeneration is capped, and the true total stays recoverable", () => {
    const shaped = shapeCommitResultForTransport(
      observedResult({ files: manyFiles, filesChanged: manyFiles.length }),
      OBSERVED_MESSAGE,
      "mcp"
    );

    expect(shaped.files).toHaveLength(MAX_WIRE_FILES);
    expect(shaped.filesTruncated).toEqual({
      returned: MAX_WIRE_FILES,
      total: manyFiles.length,
    });
    // Two independent ways back to the real number, so a reader who ignores the
    // truncation marker still is not misled about how much changed.
    expect(shaped.filesChanged).toBe(manyFiles.length);
  });

  test("a list exactly at the cap is not marked truncated", () => {
    const exact = manyFiles.slice(0, MAX_WIRE_FILES);

    const shaped = shapeCommitResultForTransport(
      observedResult({ files: exact }),
      OBSERVED_MESSAGE,
      "mcp"
    );

    expect(shaped.files).toHaveLength(MAX_WIRE_FILES);
    expect("filesTruncated" in shaped).toBe(false);
  });

  test("the CLI still receives every file, however many there are", () => {
    const shaped = shapeCommitResultForTransport(
      observedResult({ files: manyFiles }),
      OBSERVED_MESSAGE,
      "cli"
    );

    expect(shaped.files).toHaveLength(manyFiles.length);
  });
});
