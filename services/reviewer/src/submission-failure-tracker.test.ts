/**
 * Tests for the submission-failure tracker / circuit breaker (mt#2350).
 *
 * Pure classification logic is tested directly (SC-4a: a 422 is classified
 * non-retryable). The DB helpers are tested with a minimal in-memory fake that
 * implements only the subset each function calls; best-effort helpers are
 * asserted to swallow DB errors.
 */

import { describe, test, expect } from "bun:test";
import {
  classifySubmissionError,
  shouldOpenCircuit,
  submissionFailureKey,
  recordSubmissionFailure,
  clearSubmissionFailures,
  listOpenCircuitsForPRs,
  markCircuitAlerted,
  CIRCUIT_BREAKER_THRESHOLD,
} from "./submission-failure-tracker";
import type { ReviewerDb } from "./db/client";

/** The non-retryable error class label (shared across assertions/fixtures). */
const NON_RETRYABLE_4XX = "non_retryable_4xx";

// ---------------------------------------------------------------------------
// classifySubmissionError
// ---------------------------------------------------------------------------

/** Octokit-style RequestError carrying a numeric `status`. */
function httpError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  err.name = "HttpError";
  return err;
}

describe("classifySubmissionError", () => {
  test("422 'Line could not be resolved' → non-retryable (SC-4a)", () => {
    const c = classifySubmissionError(
      httpError(422, 'Unprocessable Entity: "Line could not be resolved"')
    );
    expect(c).not.toBeNull();
    expect(c?.retryable).toBe(false);
    expect(c?.status).toBe(422);
    expect(c?.class).toBe(NON_RETRYABLE_4XX);
    expect(c?.message).toContain("Line could not be resolved");
  });

  test("other 4xx (404, 403) → non-retryable", () => {
    expect(classifySubmissionError(httpError(404, "Not Found"))?.retryable).toBe(false);
    expect(classifySubmissionError(httpError(403, "Forbidden"))?.retryable).toBe(false);
  });

  test("408 and 429 → retryable (transient)", () => {
    expect(classifySubmissionError(httpError(408, "Request Timeout"))?.retryable).toBe(true);
    expect(classifySubmissionError(httpError(429, "Too Many Requests"))?.retryable).toBe(true);
  });

  test("5xx → retryable", () => {
    expect(classifySubmissionError(httpError(500, "Server Error"))?.retryable).toBe(true);
    expect(classifySubmissionError(httpError(503, "Unavailable"))?.retryable).toBe(true);
  });

  test("error without a numeric status → null (don't trip the breaker)", () => {
    expect(classifySubmissionError(new Error("ECONNRESET"))).toBeNull();
    expect(classifySubmissionError("a string")).toBeNull();
    expect(classifySubmissionError(null)).toBeNull();
  });

  test("status nested under response.status is read", () => {
    const err = new Error("wrapped") as Error & { response: { status: number } };
    err.response = { status: 422 };
    expect(classifySubmissionError(err)?.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldOpenCircuit / submissionFailureKey
// ---------------------------------------------------------------------------

describe("shouldOpenCircuit", () => {
  test("opens at the threshold, not before", () => {
    expect(shouldOpenCircuit(CIRCUIT_BREAKER_THRESHOLD - 1)).toBe(false);
    expect(shouldOpenCircuit(CIRCUIT_BREAKER_THRESHOLD)).toBe(true);
    expect(shouldOpenCircuit(CIRCUIT_BREAKER_THRESHOLD + 1)).toBe(true);
  });

  test("threshold is 2 (grounded in observed ~2 cycles/HEAD cadence)", () => {
    expect(CIRCUIT_BREAKER_THRESHOLD).toBe(2);
  });
});

describe("submissionFailureKey", () => {
  test("matches the inflight markerKey format", () => {
    expect(submissionFailureKey("edobry", "minsky", 1602, "abc")).toBe("edobry/minsky#1602@abc");
  });
});

// ---------------------------------------------------------------------------
// listOpenCircuitsForPRs — fake select() chain
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  errorClass: string;
  lastStatus: number | null;
  consecutiveCount: number;
  circuitOpen: boolean;
  alerted: boolean;
}

/** Fake db whose select()...from()...where() resolves to the supplied rows. */
function selectFakeDb(rows: FakeRow[]): ReviewerDb {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as ReviewerDb;
}

describe("listOpenCircuitsForPRs", () => {
  test("returns only requested PRs whose head_sha matches an open circuit", async () => {
    const rows: FakeRow[] = [
      {
        id: "row-1",
        owner: "edobry",
        repo: "minsky",
        prNumber: 1602,
        headSha: "head-A",
        errorClass: NON_RETRYABLE_4XX,
        lastStatus: 422,
        consecutiveCount: 2,
        circuitOpen: true,
        alerted: false,
      },
    ];
    const db = selectFakeDb(rows);

    const result = await listOpenCircuitsForPRs(db, [
      { owner: "edobry", repo: "minsky", prNumber: 1602, headSha: "head-A" },
      { owner: "edobry", repo: "minsky", prNumber: 1700, headSha: "head-Z" },
    ]);

    expect(result.size).toBe(1);
    const open = result.get(submissionFailureKey("edobry", "minsky", 1602, "head-A"));
    expect(open?.id).toBe("row-1");
    expect(open?.consecutiveCount).toBe(2);
  });

  test("an open circuit on a DIFFERENT head_sha does not match the current head", async () => {
    const rows: FakeRow[] = [
      {
        id: "row-stale",
        owner: "edobry",
        repo: "minsky",
        prNumber: 1602,
        headSha: "head-OLD",
        errorClass: NON_RETRYABLE_4XX,
        lastStatus: 422,
        consecutiveCount: 5,
        circuitOpen: true,
        alerted: true,
      },
    ];
    const db = selectFakeDb(rows);

    const result = await listOpenCircuitsForPRs(db, [
      { owner: "edobry", repo: "minsky", prNumber: 1602, headSha: "head-NEW" },
    ]);
    expect(result.size).toBe(0);
  });

  test("empty PR list short-circuits to an empty map", async () => {
    const db = selectFakeDb([]);
    const result = await listOpenCircuitsForPRs(db, []);
    expect(result.size).toBe(0);
  });

  test("DB error fails open (empty map, no throw)", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.reject(new Error("db down")),
        }),
      }),
    } as unknown as ReviewerDb;
    const result = await listOpenCircuitsForPRs(db, [
      { owner: "edobry", repo: "minsky", prNumber: 1, headSha: "h" },
    ]);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// best-effort helpers swallow DB errors
// ---------------------------------------------------------------------------

/** Fake db whose execute() always throws. */
function throwingExecuteDb(): ReviewerDb {
  return {
    execute: () => Promise.reject(new Error("execute boom")),
  } as unknown as ReviewerDb;
}

describe("best-effort persistence (never throws)", () => {
  const coords = { owner: "edobry", repo: "minsky", prNumber: 1, headSha: "h" };

  test("recordSubmissionFailure swallows DB errors", async () => {
    const db = throwingExecuteDb();
    await expect(
      recordSubmissionFailure(db, {
        ...coords,
        errorClass: NON_RETRYABLE_4XX,
        status: 422,
        message: "x",
      })
    ).resolves.toBeUndefined();
  });

  test("clearSubmissionFailures swallows DB errors", async () => {
    await expect(clearSubmissionFailures(throwingExecuteDb(), coords)).resolves.toBeUndefined();
  });

  test("markCircuitAlerted swallows DB errors", async () => {
    await expect(markCircuitAlerted(throwingExecuteDb(), "row-1")).resolves.toBeUndefined();
  });

  test("recordSubmissionFailure issues an upsert when execute works", async () => {
    let executed = false;
    const db = {
      execute: () => {
        executed = true;
        return Promise.resolve([]);
      },
    } as unknown as ReviewerDb;
    await recordSubmissionFailure(db, {
      ...coords,
      errorClass: NON_RETRYABLE_4XX,
      status: 422,
      message: "Line could not be resolved",
    });
    expect(executed).toBe(true);
  });
});
