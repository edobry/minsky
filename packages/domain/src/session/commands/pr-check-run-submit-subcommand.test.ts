/**
 * Unit tests for pr-check-run-submit-subcommand.ts (mt#1346).
 *
 * Covers:
 *  - endLine validation: inverted range throws ValidationError before any I/O
 *  - endLine equal to startLine: valid (boundary case)
 *  - endLine omitted: valid (defaults to startLine)
 *  - non-GitHub backend: ValidationError
 *  - missing PR: ResourceNotFoundError
 */

import { describe, test, expect, mock } from "bun:test";
import { sessionPrCheckRunSubmit } from "./pr-check-run-submit-subcommand";
import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import type { SessionProviderInterface } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GITHUB_SESSION = {
  session: "test-session",
  sessionId: "test-session",
  taskId: "mt#1346",
  repoUrl: "https://github.com/owner/repo",
  backendType: "github",
  pullRequest: { number: 42 },
};

/**
 * Build a minimal SessionProviderInterface mock where getSession always
 * returns the provided record (or null). resolveSessionContextWithFeedback
 * calls getSession internally with the explicit sessionId, so the mock must
 * return a non-null record for the session to resolve.
 */
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

/** Minimal valid finding with an explicit endLine. */
function makeFinding(startLine: number, endLine: number) {
  return {
    path: "src/example.ts",
    startLine,
    endLine,
    severity: "BLOCKING",
    title: "Test finding",
    message: "Something is wrong",
  };
}

// ---------------------------------------------------------------------------
// endLine validation
// ---------------------------------------------------------------------------

describe("sessionPrCheckRunSubmit — endLine validation", () => {
  test("throws ValidationError when endLine < startLine (inverted range)", async () => {
    const sessionDB = makeSessionDB(GITHUB_SESSION);

    await expect(
      sessionPrCheckRunSubmit(
        {
          sessionId: "test-session",
          findings: [makeFinding(10, 5)],
        },
        { sessionDB }
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("ValidationError message includes path, startLine, and endLine", async () => {
    const sessionDB = makeSessionDB(GITHUB_SESSION);

    let thrown: unknown;
    try {
      await sessionPrCheckRunSubmit(
        {
          sessionId: "test-session",
          findings: [
            {
              path: "src/foo.ts",
              startLine: 20,
              endLine: 15,
              severity: "NON-BLOCKING",
              title: "T",
              message: "M",
            },
          ],
        },
        { sessionDB }
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    if (thrown instanceof ValidationError) {
      expect(thrown.message).toContain("src/foo.ts");
      expect(thrown.message).toContain("20");
      expect(thrown.message).toContain("15");
    }
  });

  test("endLine equal to startLine is accepted (not a validation error)", async () => {
    const sessionDB = makeSessionDB(GITHUB_SESSION);

    // Equal lines are valid — the error should NOT be a ValidationError.
    // The call will still fail at createRepositoryBackend because there is no
    // real GitHub connection, but that is a different error class.
    let thrown: unknown;
    try {
      await sessionPrCheckRunSubmit(
        {
          sessionId: "test-session",
          findings: [makeFinding(10, 10)],
        },
        { sessionDB }
      );
    } catch (err) {
      thrown = err;
    }

    // Should NOT be a ValidationError about endLine
    if (thrown instanceof ValidationError) {
      expect(thrown.message).not.toContain("endLine");
    }
  });

  test("omitting endLine is accepted (defaults to startLine)", async () => {
    const sessionDB = makeSessionDB(GITHUB_SESSION);

    let thrown: unknown;
    try {
      await sessionPrCheckRunSubmit(
        {
          sessionId: "test-session",
          findings: [
            {
              path: "src/bar.ts",
              startLine: 5,
              severity: "BLOCKING",
              title: "T",
              message: "M",
              // endLine intentionally omitted
            },
          ],
        },
        { sessionDB }
      );
    } catch (err) {
      thrown = err;
    }

    // Should NOT be a ValidationError about endLine
    if (thrown instanceof ValidationError) {
      expect(thrown.message).not.toContain("endLine");
    }
  });

  test("throws ValidationError for the first inverted finding in a mixed list", async () => {
    const sessionDB = makeSessionDB(GITHUB_SESSION);

    await expect(
      sessionPrCheckRunSubmit(
        {
          sessionId: "test-session",
          findings: [
            makeFinding(1, 2), // valid
            makeFinding(10, 3), // invalid — endLine < startLine
            makeFinding(5, 7), // valid, but never reached
          ],
        },
        { sessionDB }
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Pre-validation checks (backend type, PR presence)
// ---------------------------------------------------------------------------

describe("sessionPrCheckRunSubmit — pre-validation", () => {
  test("throws ValidationError for non-GitHub backend", async () => {
    const sessionDB = makeSessionDB({
      ...GITHUB_SESSION,
      backendType: "local",
    });

    await expect(
      sessionPrCheckRunSubmit({ sessionId: "test-session", findings: [] }, { sessionDB })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("throws ResourceNotFoundError when session has no PR", async () => {
    const sessionDB = makeSessionDB({
      ...GITHUB_SESSION,
      pullRequest: undefined,
    });

    await expect(
      sessionPrCheckRunSubmit({ sessionId: "test-session", findings: [] }, { sessionDB })
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  test("throws ResourceNotFoundError when session is not found", async () => {
    const sessionDB = makeSessionDB(null);

    await expect(
      sessionPrCheckRunSubmit({ sessionId: "nonexistent", findings: [] }, { sessionDB })
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
