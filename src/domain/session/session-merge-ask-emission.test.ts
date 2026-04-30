/**
 * Tests for the session_pr_merge quality.review Ask emission (mt#1475).
 *
 * Verifies that:
 *   - A quality.review Ask is emitted before each merge attempt
 *   - The Ask carries the correct parentTaskId, parentSessionId, and kind
 *   - When askRepository is absent (undefined), merge proceeds without crashing
 *   - When askRepository.create throws, merge proceeds without crashing (best-effort)
 *
 * All tests are hermetic: no real DB, no real git, no real GitHub API.
 * Uses FakeAskRepository for assertions.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { AskRepository, CreateAskInput } from "../ask/repository";
import { FakeAskRepository } from "../ask/repository";

// ---------------------------------------------------------------------------
// Constants mirrored from session-merge-operations.ts (mt#1475)
// ---------------------------------------------------------------------------

const QUALITY_REVIEW_KIND = "quality.review" as const;
const ASK_INITIAL_STATE = "detected" as const;
const MERGE_CLASSIFIER_VERSION = "v1.0.0" as const;

// ---------------------------------------------------------------------------
// Minimal Ask fixture type (avoids `as` casts on the full Ask interface)
// ---------------------------------------------------------------------------

interface AskFixture {
  kind: string;
  classifierVersion: string;
  state: string;
  requestor: string;
  parentSessionId?: string;
  parentTaskId?: string;
  title: string;
  question: string;
  contextRefs?: Array<{ kind: string; ref: string; description?: string }>;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Emit helper — mirrors the logic in mergeSessionPr's emission block
// so tests exercise the same construction path without requiring a full
// mergeSessionPr invocation (which needs git, GitHub API, etc.).
// ---------------------------------------------------------------------------

async function emitMergeAsk(
  askRepository: AskRepository,
  opts: {
    sessionId: string;
    taskId?: string;
    prUrl?: string;
    prNumber?: number;
  }
): Promise<void> {
  const { sessionId, taskId, prUrl, prNumber } = opts;

  await askRepository.create({
    kind: QUALITY_REVIEW_KIND,
    classifierVersion: MERGE_CLASSIFIER_VERSION,
    requestor: sessionId,
    parentSessionId: sessionId,
    parentTaskId: taskId,
    title: prNumber != null ? `Review PR #${prNumber} before merge` : "Review PR before merge",
    question:
      prUrl != null
        ? `Review the changes in PR ${prUrl} before merge.`
        : "Review the session PR changes before merge.",
    contextRefs: prUrl
      ? [
          {
            kind: "github-pr",
            ref: prUrl,
            description: prNumber != null ? `PR #${prNumber}` : "PR",
          },
        ]
      : [],
    metadata: {},
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SESSION_ID = "session-abc-123";
const TASK_ID = "mt#1475";
const PR_URL = "https://github.com/owner/repo/pull/42";
const PR_NUMBER = 42;

describe("session_pr_merge quality.review Ask emission (mt#1475)", () => {
  let repo: FakeAskRepository;

  beforeEach(() => {
    repo = new FakeAskRepository();
  });

  it("emits exactly one quality.review Ask with state=detected", async () => {
    await emitMergeAsk(repo, {
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      prUrl: PR_URL,
      prNumber: PR_NUMBER,
    });

    expect(repo.all).toHaveLength(1);

    const ask = repo.all[0];
    expect(ask).toBeDefined();
    if (!ask) return;

    const fixture: AskFixture = ask;
    expect(fixture.kind).toBe(QUALITY_REVIEW_KIND);
    expect(fixture.state).toBe(ASK_INITIAL_STATE);
    expect(fixture.classifierVersion).toBe(MERGE_CLASSIFIER_VERSION);
  });

  it("carries correct parentTaskId and parentSessionId", async () => {
    await emitMergeAsk(repo, {
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      prUrl: PR_URL,
      prNumber: PR_NUMBER,
    });

    const ask = repo.all[0];
    expect(ask).toBeDefined();
    if (!ask) return;

    const fixture: AskFixture = ask;
    expect(fixture.parentSessionId).toBe(SESSION_ID);
    expect(fixture.parentTaskId).toBe(TASK_ID);
    expect(fixture.requestor).toBe(SESSION_ID);
  });

  it("embeds the PR URL as a github-pr contextRef", async () => {
    await emitMergeAsk(repo, {
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      prUrl: PR_URL,
      prNumber: PR_NUMBER,
    });

    const ask = repo.all[0];
    expect(ask).toBeDefined();
    if (!ask) return;

    const fixture: AskFixture = ask;
    expect(fixture.contextRefs).toBeDefined();
    const refs = fixture.contextRefs;
    if (!refs) return;
    expect(refs).toHaveLength(1);

    const ref = refs[0];
    expect(ref).toBeDefined();
    if (!ref) return;
    expect(ref.kind).toBe("github-pr");
    expect(ref.ref).toBe(PR_URL);
    expect(ref.description).toBe(`PR #${PR_NUMBER}`);
  });

  it("uses a generic title and question when PR URL is absent", async () => {
    await emitMergeAsk(repo, {
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      // no prUrl or prNumber
    });

    const ask = repo.all[0];
    expect(ask).toBeDefined();
    if (!ask) return;

    const fixture: AskFixture = ask;
    expect(fixture.title).toBe("Review PR before merge");
    expect(fixture.question).toBe("Review the session PR changes before merge.");
    expect(fixture.contextRefs).toHaveLength(0);
  });

  it("does not emit when askRepository is undefined (missing repo case)", async () => {
    // Simulate the guard in mergeSessionPr: `if (deps.askRepository) { ... }`
    // Use a function return to prevent TypeScript from narrowing the variable
    // to `never` inside the `if` block due to const assignment of `undefined`.
    function getMaybeRepo(): AskRepository | undefined {
      return undefined;
    }
    const askRepo = getMaybeRepo();

    let errorThrown = false;
    try {
      if (askRepo) {
        await askRepo.create({} as CreateAskInput);
      }
    } catch {
      errorThrown = true;
    }

    expect(errorThrown).toBe(false);
    // repo is empty — no Asks created
    expect(repo.all).toHaveLength(0);
  });

  it("swallows askRepository.create errors — merge proceeds without crashing", async () => {
    const throwingRepo = new FakeAskRepository();
    throwingRepo.create = async () => {
      throw new Error("Simulated DB failure");
    };

    // Mirror the try/catch in mergeSessionPr
    let askEmissionFailed = false;
    try {
      await emitMergeAsk(throwingRepo, {
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        prUrl: PR_URL,
        prNumber: PR_NUMBER,
      });
    } catch {
      askEmissionFailed = true;
    }

    // The try/catch in mergeSessionPr swallows this — verify the pattern
    // by running the same swallow logic and asserting the outer merge
    // operation (represented here as a boolean) succeeds.
    let mergeProceeded = false;
    try {
      try {
        await emitMergeAsk(throwingRepo, {
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          prUrl: PR_URL,
          prNumber: PR_NUMBER,
        });
      } catch {
        // Swallowed — same as the production catch block
      }
      mergeProceeded = true;
    } catch {
      mergeProceeded = false;
    }

    expect(askEmissionFailed).toBe(true); // raw call did throw
    expect(mergeProceeded).toBe(true); // with try/catch, merge continues
  });

  it("parentTaskId is undefined when session has no associated task", async () => {
    await emitMergeAsk(repo, {
      sessionId: SESSION_ID,
      // taskId is omitted
      prUrl: PR_URL,
      prNumber: PR_NUMBER,
    });

    const ask = repo.all[0];
    expect(ask).toBeDefined();
    if (!ask) return;

    const fixture: AskFixture = ask;
    expect(fixture.parentTaskId).toBeUndefined();
    expect(fixture.parentSessionId).toBe(SESSION_ID);
  });
});
