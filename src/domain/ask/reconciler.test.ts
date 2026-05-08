/**
 * Tests for the Ask reconciler (mt#1240).
 *
 * Hermetic — uses FakeAskRepository + a fake GithubReviewClient + a fake
 * OperatorNotify. No real DB, no real GitHub API, no real processes.
 *
 * Coverage goals (per mt#1240 spec):
 *   - no reviews → no transition, no notification
 *   - new review → respond + notify
 *   - idempotent (running twice with no new reviews leaves state unchanged)
 *   - GitHub API error logged but does not crash the loop
 *   - PR contextRef parsing
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { safeTruncate } from "../../utils/safe-truncate";

import {
  reconcile,
  parsePrRef,
  findPrRef,
  type GithubReview,
  type GithubReviewClient,
  type ReconcileResult,
} from "./reconciler";
import { FakeAskRepository } from "./repository";
import type { Ask, AskState } from "./types";
import type { OperatorNotify } from "../notify/operator-notify";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_REQUESTOR = "minsky.session:test-session-id";
const TEST_PR_REF = "github-pr:owner/repo/99";
const TEST_REVIEW_BODY = "Looks good to me";

interface NotifyCall {
  title: string;
  body: string;
}

interface FakeNotify extends OperatorNotify {
  bellCalls: number;
  notifyCalls: NotifyCall[];
}

function makeFakeNotify(): FakeNotify {
  const calls: NotifyCall[] = [];
  let bellCount = 0;
  return {
    bell(): void {
      bellCount += 1;
    },
    notify(title: string, body: string): void {
      calls.push({ title, body });
    },
    get bellCalls(): number {
      return bellCount;
    },
    get notifyCalls(): NotifyCall[] {
      return calls;
    },
  } as FakeNotify;
}

function makeFakeGithubClient(reviewsByPr: Map<string, GithubReview[]>): GithubReviewClient {
  return {
    async listReviews(owner: string, repo: string, prNumber: number): Promise<GithubReview[]> {
      const key = `${owner}/${repo}/${prNumber}`;
      return reviewsByPr.get(key) ?? [];
    },
  };
}

function makeReview(reviewId: number, body = "Looks good"): GithubReview {
  return {
    reviewId,
    state: "COMMENTED",
    reviewerLogin: "minsky-reviewer[bot]",
    body,
  };
}

/** Seed a quality.review Ask in `routed` state with a github-pr contextRef. */
function seedRoutedAsk(repo: FakeAskRepository, id: string, prRef: string): Ask {
  const ask: Ask = {
    id,
    kind: "quality.review",
    classifierVersion: "v1.0.0",
    state: "routed" as AskState,
    requestor: TEST_REQUESTOR,
    title: "Review PR #99",
    question: "Please review",
    contextRefs: [{ kind: "github-pr", ref: prRef }],
    createdAt: new Date().toISOString(),
    metadata: {},
  };
  repo._seedAtState(ask);
  return ask;
}

// ---------------------------------------------------------------------------
// parsePrRef / findPrRef unit tests
// ---------------------------------------------------------------------------

describe("parsePrRef", () => {
  // ------------------------------------------------------------------
  // Regression: existing colon-prefixed form must still work (mt#1414)
  // ------------------------------------------------------------------
  test("parses canonical github-pr ref", () => {
    const result = parsePrRef("github-pr:owner/repo/99");
    expect(result).toEqual({ owner: "owner", repo: "repo", prNumber: 99 });
  });

  test("regression: colon-prefixed form with real owner/repo/number (mt#1414)", () => {
    expect(parsePrRef("github-pr:edobry/minsky/787")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 787,
    });
  });

  // ------------------------------------------------------------------
  // URL forms (mt#1414 — producers write URLs, parser must accept them)
  // ------------------------------------------------------------------
  test("parses https URL form", () => {
    expect(parsePrRef("https://github.com/edobry/minsky/pull/787")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 787,
    });
  });

  test("parses http URL form", () => {
    expect(parsePrRef("http://github.com/edobry/minsky/pull/787")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 787,
    });
  });

  test("parses scheme-less github.com URL form", () => {
    expect(parsePrRef("github.com/edobry/minsky/pull/787")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 787,
    });
  });

  test("tolerates trailing path after pull number (e.g. /files)", () => {
    expect(parsePrRef("https://github.com/edobry/minsky/pull/787/files")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 787,
    });
  });

  test("tolerates query string after pull number (e.g. ?diff=split)", () => {
    expect(parsePrRef("https://github.com/edobry/minsky/pull/787?diff=split")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 787,
    });
  });

  test("tolerates fragment after pull number (e.g. #discussion-r12345)", () => {
    expect(parsePrRef("https://github.com/edobry/minsky/pull/787#discussion-r12345")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 787,
    });
  });

  test("tolerates combined query and fragment after pull number", () => {
    expect(parsePrRef("https://github.com/edobry/minsky/pull/787?w=1#issuecomment-999")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 787,
    });
  });

  // ------------------------------------------------------------------
  // Rejection cases
  // ------------------------------------------------------------------
  test("returns null for unrelated ref", () => {
    expect(parsePrRef("github-issue:owner/repo/99")).toBeNull();
  });

  test("returns null for malformed ref", () => {
    expect(parsePrRef("github-pr:owner/repo")).toBeNull();
    expect(parsePrRef("github-pr:owner/repo/abc")).toBeNull();
    expect(parsePrRef("")).toBeNull();
  });

  test("returns null for non-github host", () => {
    expect(parsePrRef("https://gitlab.com/edobry/minsky/pull/787")).toBeNull();
  });

  test("returns null for github.com URL with /issues/ instead of /pull/", () => {
    expect(parsePrRef("https://github.com/edobry/minsky/issues/787")).toBeNull();
  });

  test("returns null for plain string", () => {
    expect(parsePrRef("not a ref")).toBeNull();
  });
});

describe("findPrRef", () => {
  test("returns first github-pr contextRef", () => {
    const ask: Ask = {
      id: "x",
      kind: "quality.review",
      classifierVersion: "v1",
      state: "routed",
      requestor: TEST_REQUESTOR,
      title: "t",
      question: "q",
      contextRefs: [
        { kind: "spec", ref: "spec://a" },
        { kind: "github-pr", ref: "github-pr:o/r/42" },
      ],
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    expect(findPrRef(ask)).toEqual({ owner: "o", repo: "r", prNumber: 42 });
  });

  test("returns null when no github-pr ref present", () => {
    const ask: Ask = {
      id: "x",
      kind: "quality.review",
      classifierVersion: "v1",
      state: "routed",
      requestor: TEST_REQUESTOR,
      title: "t",
      question: "q",
      contextRefs: [],
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    expect(findPrRef(ask)).toBeNull();
  });

  test("returns null when contextRefs is undefined", () => {
    const ask: Ask = {
      id: "x",
      kind: "quality.review",
      classifierVersion: "v1",
      state: "routed",
      requestor: TEST_REQUESTOR,
      title: "t",
      question: "q",
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    expect(findPrRef(ask)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcile() integration tests
// ---------------------------------------------------------------------------

describe("reconcile", () => {
  let repo: FakeAskRepository;
  let notify: FakeNotify;

  beforeEach(() => {
    repo = new FakeAskRepository();
    notify = makeFakeNotify();
  });

  test("inspects no asks when none are routed/suspended", async () => {
    const client = makeFakeGithubClient(new Map());
    const result: ReconcileResult = await reconcile(repo, client, notify);

    expect(result.inspected).toBe(0);
    expect(result.responded).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(notify.bellCalls).toBe(0);
  });

  test("no new reviews → no transition, no notification", async () => {
    seedRoutedAsk(repo, "ask-1", TEST_PR_REF);
    const client = makeFakeGithubClient(new Map());

    const result = await reconcile(repo, client, notify);

    expect(result.inspected).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.responded).toBe(0);
    expect(notify.bellCalls).toBe(0);
    expect(notify.notifyCalls).toHaveLength(0);

    const after = await repo.getById("ask-1");
    expect(after?.state).toBe("routed");
  });

  test("new review → ask transitions to responded, bell + notify fire", async () => {
    seedRoutedAsk(repo, "ask-1", TEST_PR_REF);
    const reviews = new Map([["owner/repo/99", [makeReview(1001, TEST_REVIEW_BODY)]]]);
    const client = makeFakeGithubClient(reviews);

    const result = await reconcile(repo, client, notify);

    expect(result.inspected).toBe(1);
    expect(result.responded).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(result.errors).toBe(0);

    const after = await repo.getById("ask-1");
    expect(after?.state).toBe("responded");
    expect(after?.response).toBeDefined();
    if (!after?.response) return;
    expect(after.response.responder).toBe("reviewer:service:minsky-reviewer[bot]");

    const payload = after.response.payload as Record<string, unknown>;
    expect(payload.reviewId).toBe(1001);
    expect(payload.reviewBody).toBe(TEST_REVIEW_BODY);
    expect(payload.reviewState).toBe("COMMENTED");
    expect(payload.prNumber).toBe(99);

    expect(notify.bellCalls).toBe(1);
    expect(notify.notifyCalls).toHaveLength(1);
    expect(notify.notifyCalls[0]?.title).toBe("Minsky: review posted");
    expect(notify.notifyCalls[0]?.body).toContain("PR #99");
    expect(notify.notifyCalls[0]?.body).toContain(TEST_REVIEW_BODY);
  });

  test("multiple asks: independently processed, errors don't stop the loop", async () => {
    seedRoutedAsk(repo, "ask-good", "github-pr:o/r/1");
    seedRoutedAsk(repo, "ask-bad", "github-pr:o/r/2");

    const reviews = new Map([
      ["o/r/1", [makeReview(2001)]],
      // ask-bad's PR errors out
    ]);
    // Custom client that throws for PR #2
    const client: GithubReviewClient = {
      async listReviews(owner: string, repo: string, prNumber: number) {
        if (prNumber === 2) throw new Error("Simulated GitHub API failure");
        return reviews.get(`${owner}/${repo}/${prNumber}`) ?? [];
      },
    };

    const result = await reconcile(repo, client, notify);

    expect(result.inspected).toBe(2);
    expect(result.responded).toBe(1);
    expect(result.errors).toBe(1);

    // Good ask still progressed
    const good = await repo.getById("ask-good");
    expect(good?.state).toBe("responded");

    // Bad ask stayed in routed
    const bad = await repo.getById("ask-bad");
    expect(bad?.state).toBe("routed");
  });

  test("idempotence: second run with no new reviews leaves state unchanged", async () => {
    seedRoutedAsk(repo, "ask-1", TEST_PR_REF);
    const reviews = new Map([["owner/repo/99", [makeReview(3001)]]]);
    const client = makeFakeGithubClient(reviews);

    // First run: ask transitions to responded.
    const first = await reconcile(repo, client, notify);
    expect(first.responded).toBe(1);

    // Second run: ask is now in responded state, so it's no longer in
    // routed/suspended; it won't be picked up. inspected should be 0.
    const second = await reconcile(repo, client, notify);
    expect(second.inspected).toBe(0);
    expect(second.responded).toBe(0);

    // Notify was only called once across both runs.
    expect(notify.bellCalls).toBe(1);
    expect(notify.notifyCalls).toHaveLength(1);
  });

  test("ask without a github-pr contextRef is skipped", async () => {
    const ask: Ask = {
      id: "ask-no-pr",
      kind: "quality.review",
      classifierVersion: "v1",
      state: "routed",
      requestor: TEST_REQUESTOR,
      title: "Generic review",
      question: "q",
      contextRefs: [{ kind: "spec", ref: "spec://abc" }],
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    repo._seedAtState(ask);

    const client = makeFakeGithubClient(new Map());

    const result = await reconcile(repo, client, notify);

    expect(result.inspected).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.responded).toBe(0);
    expect(notify.bellCalls).toBe(0);
  });

  test("non-quality.review asks are not reconciled", async () => {
    const ask: Ask = {
      id: "ask-other",
      kind: "direction.decide",
      classifierVersion: "v1",
      state: "routed",
      requestor: TEST_REQUESTOR,
      title: "Pick a framework",
      question: "react or svelte?",
      contextRefs: [{ kind: "github-pr", ref: TEST_PR_REF }],
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    repo._seedAtState(ask);

    const reviews = new Map([["owner/repo/99", [makeReview(4001)]]]);
    const client = makeFakeGithubClient(reviews);

    const result = await reconcile(repo, client, notify);

    expect(result.inspected).toBe(0);
    expect(result.responded).toBe(0);
  });

  test("picks the highest review id when multiple new reviews exist", async () => {
    seedRoutedAsk(repo, "ask-1", TEST_PR_REF);
    const reviews = new Map([
      [
        "owner/repo/99",
        [makeReview(5001, "first"), makeReview(5003, "third"), makeReview(5002, "second")],
      ],
    ]);
    const client = makeFakeGithubClient(reviews);

    await reconcile(repo, client, notify);

    const after = await repo.getById("ask-1");
    expect(after?.state).toBe("responded");
    if (!after?.response) return;
    const payload = after.response.payload as Record<string, unknown>;
    expect(payload.reviewId).toBe(5003);
    expect(payload.reviewBody).toBe("third");
  });

  test("walks an ask seeded in 'detected' through the full lifecycle to 'responded'", async () => {
    // Seed at the earliest pre-response state. Without mt#1069 (router), the
    // reconciler is responsible for walking detected → classified → routed →
    // suspended before recording the response.
    const ask: Ask = {
      id: "ask-detected-1",
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      state: "detected",
      requestor: TEST_REQUESTOR,
      title: "Review PR #99",
      question: "please review",
      contextRefs: [{ kind: "github-pr", ref: TEST_PR_REF }],
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    repo._seedAtState(ask);

    const reviews = new Map([["owner/repo/99", [makeReview(7001, TEST_REVIEW_BODY)]]]);
    const client = makeFakeGithubClient(reviews);

    const result = await reconcile(repo, client, notify);

    expect(result.inspected).toBe(1);
    expect(result.responded).toBe(1);

    const after = await repo.getById("ask-detected-1");
    expect(after?.state).toBe("responded");
    // Lifecycle timestamps were set as the reconciler walked the Ask
    expect(after?.routedAt).toBeDefined();
    expect(after?.suspendedAt).toBeDefined();
    expect(after?.respondedAt).toBeDefined();
    expect(notify.bellCalls).toBe(1);
  });

  test("walks an ask seeded in 'classified' through to 'responded'", async () => {
    const ask: Ask = {
      id: "ask-classified-1",
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      state: "classified",
      requestor: TEST_REQUESTOR,
      title: "Review PR #99",
      question: "please review",
      contextRefs: [{ kind: "github-pr", ref: TEST_PR_REF }],
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    repo._seedAtState(ask);

    const reviews = new Map([["owner/repo/99", [makeReview(7002, TEST_REVIEW_BODY)]]]);
    const client = makeFakeGithubClient(reviews);

    const result = await reconcile(repo, client, notify);

    expect(result.inspected).toBe(1);
    expect(result.responded).toBe(1);

    const after = await repo.getById("ask-classified-1");
    expect(after?.state).toBe("responded");
    expect(after?.routedAt).toBeDefined();
    expect(after?.suspendedAt).toBeDefined();
    expect(after?.respondedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Surrogate-pair safety regression tests (mt#1615)
// ---------------------------------------------------------------------------

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function jsonRoundtrips(s: string): boolean {
  try {
    const encoded = JSON.stringify({ s });
    const decoded = JSON.parse(encoded) as { s: string };
    return decoded.s === s;
  } catch {
    return false;
  }
}

// Mirror of the patched truncate() in reconciler.ts
function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${safeTruncate(str, max, "head")}...`;
}

describe("reconciler truncate — surrogate safety (mt#1615)", () => {
  const EMOJIS = ["🔍", "🚀", "🎯", "🤖"];
  // Reviewer bodies routinely contain emoji (minsky-reviewer[bot] output)
  const MAX_PREVIEW = 100;

  test("reviewer body preview truncated at 100 is surrogate-safe", () => {
    // Simulate a reviewer body where position 100 falls inside an emoji
    const prefix = "a".repeat(99);
    const body = `${prefix}🔍 additional reviewer content`;
    const result = truncate(body, MAX_PREVIEW);
    expect(hasUnpairedSurrogate(result)).toBe(false);
    expect(jsonRoundtrips(result)).toBe(true);
    expect(result.endsWith("...")).toBe(true);
  });

  test("every cut length 0..100 on emoji body produces valid UTF-16", () => {
    const body = EMOJIS.join("").repeat(15); // 120 code units
    for (let n = 0; n <= MAX_PREVIEW; n++) {
      const result = truncate(body, n);
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
    }
  });

  test("short body returned unchanged", () => {
    const short = "LGTM 🚀";
    const result = truncate(short, MAX_PREVIEW);
    expect(result).toBe(short);
    expect(hasUnpairedSurrogate(result)).toBe(false);
  });

  test("all four spec emojis at boundary", () => {
    for (const emoji of EMOJIS) {
      const body = `${"a".repeat(99) + emoji}trailing`;
      const result = truncate(body, MAX_PREVIEW);
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
    }
  });
});
