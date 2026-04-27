import { describe, test, expect, mock } from "bun:test";
import { sessionPrReviewDismiss } from "./pr-review-dismiss-subcommand";
import { ValidationError, ResourceNotFoundError } from "../../../errors/index";
import type { SessionProviderInterface } from "../types";

function makeSessionDB(sessionRecord: unknown): SessionProviderInterface {
  return {
    getSession: mock(() => Promise.resolve(sessionRecord)),
    listSessions: mock(() => Promise.resolve([])),
    addSession: mock(() => Promise.resolve()),
    deleteSession: mock(() => Promise.resolve(true)),
    updateSession: mock(() => Promise.resolve()),
    getRepoPath: mock(() => Promise.resolve("/fake/path")),
    getSessionByTaskId: mock(() => Promise.resolve(null)),
    getSessionWorkdir: mock(() => Promise.resolve("/fake/workdir")),
  } as unknown as SessionProviderInterface;
}

describe("sessionPrReviewDismiss — validation", () => {
  test("rejects an empty message with ValidationError", async () => {
    const sessionDB = makeSessionDB(null);
    await expect(
      sessionPrReviewDismiss({ sessionId: "s1", reviewId: 123, message: "" }, { sessionDB })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects a whitespace-only message with ValidationError", async () => {
    const sessionDB = makeSessionDB(null);
    await expect(
      sessionPrReviewDismiss(
        { sessionId: "s1", reviewId: 123, message: "   \n\t  " },
        { sessionDB }
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects zero or negative reviewId with ValidationError", async () => {
    const sessionDB = makeSessionDB(null);
    await expect(
      sessionPrReviewDismiss({ sessionId: "s1", reviewId: 0, message: "stale" }, { sessionDB })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      sessionPrReviewDismiss({ sessionId: "s1", reviewId: -5, message: "stale" }, { sessionDB })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects non-integer reviewId with ValidationError", async () => {
    const sessionDB = makeSessionDB(null);
    await expect(
      sessionPrReviewDismiss({ sessionId: "s1", reviewId: 42.5, message: "stale" }, { sessionDB })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects a session that is not GitHub-backed with ValidationError", async () => {
    const sessionDB = makeSessionDB({
      session: "s1",
      taskId: "mt#1",
      repoUrl: "https://example.com/repo",
      backendType: "local",
      pullRequest: { number: 42 },
    });
    await expect(
      sessionPrReviewDismiss({ sessionId: "s1", reviewId: 123, message: "stale" }, { sessionDB })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects a GitHub session with no PR with ResourceNotFoundError", async () => {
    const sessionDB = makeSessionDB({
      session: "s1",
      taskId: "mt#1",
      repoUrl: "https://github.com/owner/repo",
      backendType: "github",
      // no pullRequest field
    });
    await expect(
      sessionPrReviewDismiss({ sessionId: "s1", reviewId: 123, message: "stale" }, { sessionDB })
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  test("rejects an unresolvable session with ResourceNotFoundError", async () => {
    // getSession returns null → ResourceNotFoundError
    const sessionDB = makeSessionDB(null);
    await expect(
      sessionPrReviewDismiss(
        { sessionId: "nonexistent", reviewId: 123, message: "stale" },
        { sessionDB }
      )
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
