/**
 * Tests for the pure half of `observability.reviewer-events` (mt#4118).
 *
 * Classification, verdict derivation, bounds and formatting take a row in and
 * return a value — no database, no container. That split is deliberate
 * (`/implement-task` §6 testable-design checkpoint): the SQL needs a live run
 * against production, recorded in the PR body, but the logic that decides
 * whether a row means "the reviewer ran" fails independently of it — and it is
 * the half that would let a bypass merge through if it were wrong.
 *
 * The fixtures are real: every `errorMessage` below is a verbatim string from
 * `reviewer_webhook_events` in production, read 2026-09-02.
 */
import { describe, test, expect } from "bun:test";
import {
  classifyEventRow,
  deriveLadderVerdict,
  buildBounds,
  toEventRow,
  formatReviewerEventsReport,
  REVIEW_TRIGGER_EVENT_TYPES,
  type ReviewerEventRow,
  type ReviewerEventsReport,
} from "./reviewer-events";

/** The mt#3852 submit-path 422, verbatim (edobry/minsky PR #2719, 2026-08-08). */
const MESSAGE_422 =
  'Unprocessable Entity: "Variable $comments of type [DraftPullRequestReviewComment] was ' +
  "provided invalid value for 0.inReplyTo (Field is not defined on " +
  "DraftPullRequestReviewComment), 0.path (Expected value to not be null), 0.position " +
  '(Expected value to not be null)" - https://docs.github.com/rest/pulls/reviews';

/** The mt#4879 pre-submit provider 400, verbatim (edobry/peezombie.me PR #2, 2026-09-01). */
const MESSAGE_400 =
  "400 Input tokens exceed the configured limit of 272000 tokens. Your messages resulted in " +
  "1234592 tokens. Please reduce the length of the messages.";

/**
 * The two literals these fixtures repeat, named once.
 *
 * `custom/no-magic-string-duplication` flags them, and it is right to: the
 * outcome value is the reviewer service's enum spelling, and the verdict is
 * this module's own union member — a typo in either would make a test assert
 * the wrong thing while still passing its own construction.
 */
const OUTCOME_FAILED_AT_REVIEWER = "failed_at_reviewer";
const VERDICT_NOT_A_TRIGGER = "not-a-review-trigger";

function row(overrides: Partial<ReviewerEventRow> = {}): ReviewerEventRow {
  return {
    receivedAt: "2026-09-01T18:14:47Z",
    processedAt: "2026-09-01T18:15:02Z",
    eventType: "pull_request",
    action: "synchronize",
    outcome: OUTCOME_FAILED_AT_REVIEWER,
    repo: "edobry/peezombie.me",
    prNumber: 2,
    headSha: "abc1234",
    errorStage: "reviewer",
    errorMessage: MESSAGE_400,
    verdict: "ran-and-failed",
    ...overrides,
  };
}

describe("classifyEventRow", () => {
  test("a submit-path 422 is ran-and-failed", () => {
    expect(
      classifyEventRow({
        eventType: "pull_request",
        outcome: OUTCOME_FAILED_AT_REVIEWER,
        errorMessage: MESSAGE_422,
      })
    ).toBe("ran-and-failed");
  });

  test("a pre-submit provider 400 is also ran-and-failed", () => {
    expect(
      classifyEventRow({
        eventType: "pull_request",
        outcome: OUTCOME_FAILED_AT_REVIEWER,
        errorMessage: MESSAGE_400,
      })
    ).toBe("ran-and-failed");
  });

  test("concurrent_inflight is declined-to-run, NOT a failure", () => {
    // server.ts collapses runReview's "skipped" and "error" into the same
    // outcome value; only the message separates them, and they have opposite
    // remedies (a new head vs. a service fix).
    expect(
      classifyEventRow({
        eventType: "pull_request",
        outcome: OUTCOME_FAILED_AT_REVIEWER,
        errorMessage: "concurrent_inflight",
      })
    ).toBe("declined-to-run");
  });

  test("dispatched with no terminal outcome is dispatched-never-finished", () => {
    expect(
      classifyEventRow({
        eventType: "pull_request",
        outcome: "reviewer_called",
        errorMessage: null,
      })
    ).toBe("dispatched-never-finished");
  });

  test("a received row on a non-trigger event type is not-a-review-trigger", () => {
    // 6,933 issue_comment and 3,962 check_suite rows sat at `received` over 30
    // days; reading one as a stuck reviewer is the false positive this avoids.
    expect(
      classifyEventRow({ eventType: "check_suite", outcome: "received", errorMessage: null })
    ).toBe(VERDICT_NOT_A_TRIGGER);
  });

  test("a received row on a trigger event type is awaiting-routing", () => {
    for (const eventType of REVIEW_TRIGGER_EVENT_TYPES) {
      expect(classifyEventRow({ eventType, outcome: "received", errorMessage: null })).toBe(
        "awaiting-routing"
      );
    }
  });

  test("skipped and the pre-dispatch failures each get their own verdict", () => {
    expect(
      classifyEventRow({ eventType: "pull_request", outcome: "skipped", errorMessage: null })
    ).toBe("deliberately-skipped");
    expect(
      classifyEventRow({
        eventType: "pull_request",
        outcome: "failed_at_tier_resolve",
        errorMessage: "boom",
      })
    ).toBe("failed-before-dispatch");
  });

  test("an unrecognized outcome never reads as silence", () => {
    // A value added to the enum after this shipped must not fall through to
    // something a caller could mistake for "the reviewer never ran".
    const verdict = classifyEventRow({
      eventType: "pull_request",
      outcome: "some_future_outcome",
      errorMessage: null,
    });
    expect(verdict).toBe("awaiting-routing");
    expect(deriveLadderVerdict([row({ verdict })]).isSilence).toBe(false);
  });
});

describe("deriveLadderVerdict", () => {
  test("zero rows is the only silence verdict", () => {
    const v = deriveLadderVerdict([]);
    expect(v.kind).toBe("no-record");
    expect(v.isSilence).toBe(true);
  });

  test("a failure row is not silence and says so", () => {
    const v = deriveLadderVerdict([row()]);
    expect(v.kind).toBe("ran-and-failed");
    expect(v.isSilence).toBe(false);
    expect(v.detail).toContain("bypass condition (c) does not hold");
  });

  test("rows that never advanced past receipt are a routing stall, not silence", () => {
    const v = deriveLadderVerdict([
      row({
        eventType: "check_suite",
        outcome: "received",
        errorMessage: null,
        verdict: VERDICT_NOT_A_TRIGGER,
      }),
    ]);
    expect(v.kind).toBe("delivered-not-dispatched");
    expect(v.isSilence).toBe(false);
  });

  test("the newest informative row wins over an older success", () => {
    // A review that succeeded three days ago does not license a bypass today.
    const v = deriveLadderVerdict([
      row({ receivedAt: "2026-09-01T18:14:47Z", verdict: "ran-and-failed" }),
      row({ receivedAt: "2026-08-29T10:00:00Z", verdict: "review-submitted" }),
    ]);
    expect(v.kind).toBe("ran-and-failed");
  });

  test("non-informative rows are skipped in favour of an older informative one", () => {
    const v = deriveLadderVerdict([
      row({ receivedAt: "2026-09-01T18:20:00Z", verdict: VERDICT_NOT_A_TRIGGER }),
      row({ receivedAt: "2026-09-01T18:14:47Z", verdict: "ran-and-failed" }),
    ]);
    expect(v.kind).toBe("ran-and-failed");
  });
});

describe("buildBounds", () => {
  test("names the window, the retrigger blind spot, retention, and the empty-message case", () => {
    const bounds = buildBounds("2026-08-26T00:00:00Z");
    expect(bounds).toHaveLength(4);
    expect(bounds.join("\n")).toContain("2026-08-26T00:00:00Z");
    expect(bounds.join("\n")).toContain("retrigger");
    expect(bounds.join("\n")).toContain("MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS");
    expect(bounds.join("\n")).toContain("best-effort");
  });
});

describe("toEventRow", () => {
  test("coerces the jsonb-extracted PR number and classifies in one pass", () => {
    const r = toEventRow({
      received_at: "2026-08-08T18:20:28Z",
      processed_at: null,
      event_type: "pull_request",
      action: "synchronize",
      outcome: OUTCOME_FAILED_AT_REVIEWER,
      repo: "edobry/minsky",
      pr_number: "2719", // jsonb ->> always yields text
      head_sha: "0f00f6dac",
      error_stage: "reviewer",
      error_message: MESSAGE_422,
    });
    expect(r.prNumber).toBe(2719);
    expect(r.processedAt).toBeNull();
    expect(r.verdict).toBe("ran-and-failed");
  });

  test("an empty error message becomes null rather than an empty string", () => {
    // 2 of 143 rows are an octokit HttpError whose .message is empty and whose
    // cause is only in .stack — the row is still a real failure.
    const r = toEventRow({
      received_at: "2026-08-09T00:54:35Z",
      processed_at: null,
      event_type: "pull_request",
      action: "synchronize",
      outcome: OUTCOME_FAILED_AT_REVIEWER,
      repo: "edobry/minsky",
      pr_number: "2735",
      head_sha: null,
      error_stage: "reviewer",
      error_message: "",
    });
    expect(r.errorMessage).toBeNull();
    expect(r.verdict).toBe("ran-and-failed");
  });
});

describe("formatReviewerEventsReport", () => {
  function report(overrides: Partial<ReviewerEventsReport> = {}): ReviewerEventsReport {
    const rows = [row()];
    return {
      filter: { owner: "edobry", repo: "peezombie.me", pr: 2, since: "2026-08-26T00:00:00Z" },
      verdict: deriveLadderVerdict(rows),
      rowCount: rows.length,
      rows,
      repoWideFailures: [
        {
          messagePrefix: "400 Input tokens exceed the configured limit of 272000 tokens.",
          count: 4,
          distinctPrs: 1,
          lastSeen: "2026-09-01T18:14:47Z",
        },
      ],
      bounds: buildBounds("2026-08-26T00:00:00Z"),
      ...overrides,
    };
  }

  test("marks a non-silence verdict explicitly", () => {
    const text = formatReviewerEventsReport(report());
    expect(text).toContain("VERDICT: ran-and-failed");
    expect(text).toContain("(NOT reviewer silence)");
    expect(text).toContain("edobry/peezombie.me PR #2");
  });

  test("renders the failure message and the repo-wide class", () => {
    const text = formatReviewerEventsReport(report());
    expect(text).toContain("400 Input tokens exceed");
    expect(text).toContain("4x across   1 PR(s)");
  });

  test("renders bounds even when rows were found", () => {
    // A caller who only sees the bounds on an empty result learns them at the
    // moment they are least likely to be read.
    expect(formatReviewerEventsReport(report())).toContain("Bounds —");
  });

  test("an empty result is rendered as no-record WITH its bounds, not as silence", () => {
    const empty = report({ rows: [], rowCount: 0, verdict: deriveLadderVerdict([]) });
    const text = formatReviewerEventsReport(empty);
    expect(text).toContain("VERDICT: no-record");
    expect(text).not.toContain("(NOT reviewer silence)");
    expect(text).toContain("read `bounds` first");
    expect(text).toContain("retrigger");
  });
});
