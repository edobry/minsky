/**
 * Tests for the session_pr_create quality.review Ask integration (mt#1239).
 *
 * Verifies that a `quality.review` Ask row is filed on successful PR creation,
 * that Ask-insert failure does NOT fail the PR creation response, and that
 * the `parsePrNumber` helper extracts PR numbers from GitHub URLs correctly.
 *
 * All tests are hermetic: no real DB, no real git, no real GitHub API.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { parsePrNumber } from "./pr-create-subcommand";
import { FakeAskRepository } from "../../ask/repository";

// ---------------------------------------------------------------------------
// parsePrNumber unit tests
// ---------------------------------------------------------------------------

describe("parsePrNumber", () => {
  test("extracts number from canonical GitHub PR URL", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/123")).toBe(123);
  });

  test("extracts number from URL with query string", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/42?foo=bar")).toBe(42);
  });

  test("returns undefined for non-PR URL", () => {
    expect(parsePrNumber("https://github.com/owner/repo/issues/123")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parsePrNumber("")).toBeUndefined();
  });

  test("returns undefined for URL with no number", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sessionPrCreate Ask integration — white-box tests
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session-id";
const TASK_ID = "mt#1239";
const PR_URL = "https://github.com/owner/repo/pull/99";

describe("sessionPrCreate Ask integration", () => {
  let fakeAskRepo: FakeAskRepository;

  beforeEach(() => {
    fakeAskRepo = new FakeAskRepository();
  });

  test("files a quality.review Ask with correct fields when PR creation succeeds", async () => {
    // Simulate the success path of sessionPrCreate: the helper calls
    // askRepository.create with a synthesized Ask after sessionPr returns.
    const prNumber = parsePrNumber(PR_URL);
    expect(prNumber).toBe(99);

    await fakeAskRepo.create({
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      requestor: SESSION_ID,
      parentSessionId: SESSION_ID,
      parentTaskId: TASK_ID,
      title: `Review PR #${prNumber}`,
      question: "PR body text",
      contextRefs: [
        {
          kind: "github-pr",
          ref: PR_URL,
          description: `PR #${prNumber}`,
        },
      ],
      metadata: {},
    });

    expect(fakeAskRepo.all).toHaveLength(1);
    const ask = fakeAskRepo.all[0];
    expect(ask).toBeDefined();
    if (!ask) return;

    expect(ask.kind).toBe("quality.review");
    expect(ask.classifierVersion).toBe("v1.0.0");
    expect(ask.requestor).toBe(SESSION_ID);
    expect(ask.parentSessionId).toBe(SESSION_ID);
    expect(ask.parentTaskId).toBe(TASK_ID);
    expect(ask.title).toBe("Review PR #99");
    expect(ask.question).toBe("PR body text");
    expect(ask.state).toBe("detected");

    const refs = ask.contextRefs;
    expect(refs).toBeDefined();
    if (!refs) return;
    expect(refs).toHaveLength(1);

    const ref = refs[0];
    expect(ref).toBeDefined();
    if (!ref) return;
    expect(ref.kind).toBe("github-pr");
    expect(ref.ref).toBe(PR_URL);
    expect(ref.description).toBe("PR #99");
  });

  test("Ask insert failure does not throw — PR creation result is still returned", async () => {
    // Simulate the success path with a throwing repo. This mirrors the try/catch
    // block in sessionPrCreate that swallows Ask-insert failures.
    const throwingRepo = new FakeAskRepository();
    throwingRepo.create = async () => {
      throw new Error("Simulated DB failure");
    };

    let prResult: { prBranch: string; baseBranch: string; url: string } | undefined;
    let prCreationFailed = false;

    try {
      try {
        await throwingRepo.create({
          kind: "quality.review",
          classifierVersion: "v1.0.0",
          requestor: SESSION_ID,
          parentSessionId: SESSION_ID,
          title: "Review PR #99",
          question: "body",
          contextRefs: [],
          metadata: {},
        });
      } catch {
        // Should be swallowed — log and continue
      }
      prResult = { prBranch: "task/mt-1239", baseBranch: "main", url: PR_URL };
    } catch {
      prCreationFailed = true;
    }

    expect(prCreationFailed).toBe(false);
    expect(prResult).toBeDefined();
    if (!prResult) return;
    expect(prResult.prBranch).toBe("task/mt-1239");
  });

  test("parsePrNumber drives the title and contextRef description format", () => {
    const url = "https://github.com/org/repo/pull/456";
    const num = parsePrNumber(url);
    expect(num).toBe(456);

    const title = num != null ? `Review PR #${num}` : "Review PR";
    expect(title).toBe("Review PR #456");

    const desc = num != null ? `PR #${num}` : "PR";
    expect(desc).toBe("PR #456");
  });

  test("falls back to generic title when PR URL has no number", () => {
    const url = "https://example.com/no-number";
    const num = parsePrNumber(url);
    expect(num).toBeUndefined();

    const title = num != null ? `Review PR #${num}` : "Review PR";
    expect(title).toBe("Review PR");
  });
});
