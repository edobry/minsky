/**
 * End-to-end coverage of `runReview`'s PROSE-path sanitize wiring (mt#1263).
 *
 * ## What this is NOT
 *
 * It is not a test of `sanitizeReviewBody` — `sanitize.test.ts` owns that with 17
 * cases — nor of `decidePostSanitizeOutcome`, which `review-worker.test.ts` owns
 * with 6. mt#1263's `## Out of scope` names both explicitly. The gap those two
 * leave is the WIRING BETWEEN them, which no test reached: that
 * `annotateReviewBody` is handed `sanitized.body` and not the raw `output.text`,
 * that the errored path forces `COMMENT` and returns no `review` field, and that
 * `reviewer.cot_leak_detected` fires only when sanitize actually did something.
 * Swapping `sanitized.body` for `output.text` in `review-worker.ts` is a
 * one-token refactor slip that leaves every pre-existing test green.
 *
 * ## Why seams rather than module patching
 *
 * ADR-036 §2 rule 2: a seam addable in one production file with no exported-type
 * change is required, and patching is banned at such a site. `runReview` already
 * takes `deps: RunReviewDeps = {}`; mt#1263 added four optional fields to it
 * (`reviewerCaller`, `bodySanitizer`, `reviewSubmitter`, `guardedSubmitter`) on
 * top of the three mt#4895 shipped for the marker path. This supersedes closed
 * PR #774, which used `mock.module` plus an `eslint.config.js` carve-out from
 * `custom/no-global-module-mocks`.
 *
 * `bodySanitizer` is what lets each case CHOOSE its `SanitizeResult` instead of
 * reverse-engineering a leaked body that produces one — the original mt#1263
 * success criterion asked for exactly that seam.
 *
 * ## The two confounds these assertions have to discriminate
 *
 * **1. Reaching the prose path at all.** The sanitize wiring under test lives on
 * the non-output-tools branch. `outputToolsActive = toolsActive && config.provider
 * === "openai"`, so `CONFIG.provider` is `"anthropic"` — an OpenAI config routes
 * to the output-tools path and its separate, log-only `scratchSanitized` check,
 * and none of these assertions would run.
 *
 * **2. Which text the event was computed from.** Asserting the submitted BODY
 * alone leaves the event unpinned, so the raw and sanitized texts are built to
 * parse to DIFFERENT events: `RAW_MODEL_TEXT` ends in `APPROVE`, `STRIPPED_BODY`
 * ends in `REQUEST_CHANGES`. `parseReviewEvent` reads the last 400 chars, so a
 * wiring that fed it `output.text` would yield `APPROVE` and every stripped-case
 * event assertion below would fail. The PR author must also not be the reviewer
 * (`isSelfReview` short-circuits `parseReviewEvent` to `COMMENT`, which would
 * collapse the discriminator) — hence a distinct `PR_AUTHOR`.
 */

import { describe, test, expect } from "bun:test";
import { runReview, type RunReviewDeps } from "./review-worker";
import type { ReviewerConfig } from "./config";
import type { ReviewerDb } from "./db/client";
import type { PullRequestContext, SubmittedReview } from "./github-client";
import type { ReviewOutput } from "./providers";
import type { SanitizeResult } from "./sanitize";
import { captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";

const COT_LEAK_EVENT = "reviewer.cot_leak_detected";
const SUBMIT_ERROR_NOTICE_FAILED_EVENT = "reviewer.submit_error_notice_failed";

/** Distinct from the reviewer identity below, so `isSelfReview` is false. */
const PR_AUTHOR = "a-human-contributor";
const REVIEWER_LOGIN = "minsky-reviewer[bot]";

/**
 * The model's raw output. Ends in `APPROVE` and contains no `REQUEST_CHANGES`,
 * so any wiring that computes the event from THIS text yields `APPROVE`.
 */
const RAW_MODEL_TEXT = [
  "Okay, let me look at the diff. I should check the imports first.",
  "Actually wait — let me re-read the helper. Right, that's fine.",
  "",
  "## Findings",
  "",
  "Nothing blocking here.",
  "",
  "APPROVE",
].join("\n");

/** A fragment present ONLY in the raw text, used to prove it was not submitted. */
const SCRATCH_FRAGMENT = "Okay, let me look at the diff";

/**
 * What the sanitizer yields on the `stripped` action. Ends in `REQUEST_CHANGES`,
 * so the event pins that the decision read THIS text rather than the raw one.
 */
const STRIPPED_BODY = [
  "## Findings",
  "",
  "1. [BLOCKING] `foo()` drops the error on the rejection path.",
  "",
  "REQUEST_CHANGES",
].join("\n");

/** What the sanitizer yields on the `errored` action: the service-error notice. */
const ERRORED_BODY = [
  "**Reviewer service error**",
  "",
  "The model returned chain-of-thought with no recoverable review body.",
].join("\n");

const CONFIG: ReviewerConfig = {
  appId: 1,
  privateKey: "not-a-real-private-key",
  installationId: 1,
  webhookSecret: "not-a-real-webhook-secret",
  // Non-OpenAI on purpose — see confound 1 in the header. This is what routes
  // execution onto the prose path where the sanitize wiring lives.
  provider: "anthropic",
  providerApiKey: "not-a-real-api-key",
  providerModel: "claude-sonnet-5",
  tier2Enabled: false,
  mcpUrl: undefined,
  mcpToken: undefined,
  port: 0,
  logLevel: "error",
  modelTimeoutMs: 1_000,
  githubTimeoutMs: 1_000,
};

/**
 * Tier 3 in the body → `resolveTier` returns 3 → `decideRouting` returns
 * `shouldReview: true`. Without this the routing skip fires long before the
 * model call and the sanitize wiring is never reached.
 */
const PR_CONTEXT: PullRequestContext = {
  number: 1263,
  title: "A PR whose review body leaks model scratch",
  body: "<!-- minsky:tier=3 -->",
  owner: "edobry",
  repo: "minsky",
  headOwner: "edobry",
  headRepo: "minsky",
  isForkedPR: false,
  branchName: "task/mt-1263",
  baseBranch: "main",
  diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
  headSha: "1263abc4d5e6f708192a3b4c5d6e7f8091a2b3c4",
  filesChanged: ["a.ts"],
  fileEntries: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 1 }],
  changedFilesCount: 1,
};

const MODEL_OUTPUT: ReviewOutput = {
  text: RAW_MODEL_TEXT,
  provider: "anthropic",
  model: "claude-sonnet-5",
  toolCalls: [],
};

const SUBMITTED: SubmittedReview = {
  id: 987654321,
  htmlUrl: "https://github.com/edobry/minsky/pull/1263#pullrequestreview-987654321",
};

function sanitizeResult(
  action: SanitizeResult["action"],
  body: string,
  reason: string
): SanitizeResult {
  return {
    action,
    body,
    meta: {
      originalLength: RAW_MODEL_TEXT.length,
      cleanedLength: body.length,
      reason,
    },
  };
}

/**
 * The subset of `ReviewerDb` the in-flight marker touches. Always GRANTS, since
 * a denied marker returns the `concurrent_inflight` skip before the model call —
 * that branch is mt#4895's, covered in `runreview-concurrent-inflight.test.ts`.
 */
function makeGrantingDb(): ReviewerDb {
  let executeCalls = 0;
  return {
    execute: async () => {
      executeCalls += 1;
      // Call 1 is the acquire INSERT ... RETURNING id; a row means acquired.
      // Anything after it is the release DELETE, which returns nothing.
      return executeCalls === 1 ? [{ id: "marker-row-1" }] : [];
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  } as unknown as ReviewerDb;
}

interface SubmissionRecorder {
  /** Bodies passed to the REVIEWED-path submitter (`submitReviewWithGuards`). */
  guarded: Array<{ event: string; body: string }>;
  /** Bodies passed to the ERRORED-path submitter (`submitReview`). */
  plain: Array<{ event: string; body: string }>;
}

/**
 * Every collaborator between `runReview`'s entry and the sanitize wiring, stubbed
 * so the path is reachable with no network and no model call. Anything not listed
 * here is already inert without a seam: `resolveTaskSpec` and the short-id lookups
 * no-op when their lookups are absent, `fetchReviewThreads` degrades to `[]` inside
 * its own try/catch, and the metric/timing/emit tails are `deps.db`-gated.
 */
function baseDeps(
  sanitized: SanitizeResult,
  recorder: SubmissionRecorder,
  extra: RunReviewDeps = {}
): RunReviewDeps {
  return {
    db: makeGrantingDb(),
    octokitFactory: async () => ({}) as Awaited<ReturnType<RunReviewDeps["octokitFactory"] & {}>>,
    prContextFetcher: async () => PR_CONTEXT,
    appIdentityFetcher: async () => ({ login: REVIEWER_LOGIN }),
    priorReviewFetcher: async () => [],
    reviewerCaller: async () => MODEL_OUTPUT,
    bodySanitizer: () => sanitized,
    reviewSubmitter: async (_octokit, _owner, _repo, _pr, event, body) => {
      recorder.plain.push({ event, body });
      return SUBMITTED;
    },
    guardedSubmitter: async (input) => {
      recorder.guarded.push({ event: input.event, body: input.body });
      return SUBMITTED;
    },
    // Tails that would otherwise reach GitHub / the MCP event bus.
    checkRunPublisher: async () => undefined,
    timingRecorder: async () => {},
    metricsRecorder: async () => {},
    eventEmitter: async () => {},
    ...extra,
  };
}

function newRecorder(): SubmissionRecorder {
  return { guarded: [], plain: [] };
}

/**
 * Assert exactly one submission was recorded and return it.
 *
 * The explicit throw is what keeps the assertions below non-vacuous: reading
 * `entries[0]` yields `T | undefined` under `noUncheckedIndexedAccess` (which
 * `services/reviewer`'s tsconfig enables), and an `expect(undefined).not.toContain(...)`
 * would pass for the wrong reason. A `!` would silence the type error instead of
 * answering it, and trips `@typescript-eslint/no-non-null-assertion` under this
 * repo's `--max-warnings=0` gate.
 */
function onlySubmission(entries: ReadonlyArray<{ event: string; body: string }>): {
  event: string;
  body: string;
} {
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  if (entry === undefined) {
    throw new Error("expected exactly one recorded submission; got none");
  }
  return entry;
}

async function runWithCapture(deps: RunReviewDeps) {
  const captured = captureConsoleLogs();
  try {
    const result = await runReview(
      CONFIG,
      "edobry",
      "minsky",
      PR_CONTEXT.number,
      PR_AUTHOR,
      "delivery-mt1263",
      PR_CONTEXT.headSha,
      deps
    );
    return { result, logs: captured.logs };
  } finally {
    captured.restore();
  }
}

describe("runReview — prose-path sanitize wiring (mt#1263)", () => {
  describe("sanitize action: stripped", () => {
    test("submits sanitized.body — not output.text — and derives the event from it", async () => {
      const recorder = newRecorder();
      const { result } = await runWithCapture(
        baseDeps(sanitizeResult("stripped", STRIPPED_BODY, "blank-line-run"), recorder)
      );

      // The reviewed path goes through the guarded submitter, not the plain one.
      expect(recorder.plain).toHaveLength(0);

      const submitted = onlySubmission(recorder.guarded);
      // The body is `annotateReviewBody(sanitized.body, ...)` — header + sanitized
      // body — so assert the sanitized text is present and the stripped scratch
      // prefix is NOT. This pair is what the mutation control below flips.
      expect(submitted.body).toContain(STRIPPED_BODY);
      expect(submitted.body).not.toContain(SCRATCH_FRAGMENT);

      // Pins WHICH text the event was computed from: the raw output ends in
      // APPROVE, the sanitized body in REQUEST_CHANGES (confound 2 in the header).
      expect(submitted.event).toBe("REQUEST_CHANGES");

      expect(result.status).toBe("reviewed");
      expect(result.reason).toContain("[cot-leakage: stripped]");
      // A stripped review IS posted, so the review field is populated — the
      // complement of the errored case below.
      expect(result.review).toEqual(SUBMITTED);
    });

    test("emits reviewer.cot_leak_detected carrying the sanitize action and lengths", async () => {
      const recorder = newRecorder();
      const sanitized = sanitizeResult("stripped", STRIPPED_BODY, "blank-line-run");
      const { logs } = await runWithCapture(baseDeps(sanitized, recorder));

      const logged = findLogEvent(logs, COT_LEAK_EVENT);
      expect(logged).not.toBeNull();
      expect(logged?.["action"]).toBe("stripped");
      expect(logged?.["reason"]).toBe("blank-line-run");
      expect(logged?.["originalLength"]).toBe(sanitized.meta.originalLength);
      expect(logged?.["cleanedLength"]).toBe(sanitized.meta.cleanedLength);
      expect(logged?.["sha"]).toBe(PR_CONTEXT.headSha);
    });
  });

  describe("sanitize action: errored", () => {
    test("posts the error notice as COMMENT and returns status=error with NO review", async () => {
      const recorder = newRecorder();
      const { result } = await runWithCapture(
        baseDeps(sanitizeResult("errored", ERRORED_BODY, "whole-body-scratch"), recorder)
      );

      // The errored path deliberately uses the PLAIN submitter inside a try/catch,
      // not the guarded one — that split is part of the wiring under test.
      expect(recorder.guarded).toHaveLength(0);

      const submitted = onlySubmission(recorder.plain);
      expect(submitted.body).toContain(ERRORED_BODY);
      expect(submitted.body).not.toContain(SCRATCH_FRAGMENT);

      // Forced to COMMENT by decidePostSanitizeOutcome. Non-trivial here: the raw
      // output ends in APPROVE, so a wiring reading output.text would not produce
      // this value.
      expect(submitted.event).toBe("COMMENT");

      expect(result.status).toBe("error");
      // Downstream consumers treat status=error as "no review confirmed posted",
      // so the field must stay absent even though a notice WAS posted.
      expect(result.review).toBeUndefined();
    });

    test("a submitReview failure does not propagate — it is logged and the error status still returns", async () => {
      const recorder = newRecorder();
      const submitFailure = new Error("GitHub 422: pull request is closed");
      const { result, logs } = await runWithCapture(
        baseDeps(sanitizeResult("errored", ERRORED_BODY, "whole-body-scratch"), recorder, {
          reviewSubmitter: async () => {
            throw submitFailure;
          },
        })
      );

      // The primary CoT-leak outcome survives the secondary posting failure.
      expect(result.status).toBe("error");
      expect(result.review).toBeUndefined();

      // And the secondary failure leaves a trace rather than vanishing (mt#1370).
      const logged = findLogEvent(logs, SUBMIT_ERROR_NOTICE_FAILED_EVENT);
      expect(logged).not.toBeNull();
    });
  });

  describe("sanitize action: passthrough", () => {
    test("submits the raw output text and emits no cot_leak_detected log", async () => {
      const recorder = newRecorder();
      const { result, logs } = await runWithCapture(
        baseDeps(sanitizeResult("passthrough", RAW_MODEL_TEXT, "clean"), recorder)
      );

      expect(recorder.plain).toHaveLength(0);

      const submitted = onlySubmission(recorder.guarded);
      // On passthrough `sanitized.body` IS `output.text`, so the scratch fragment
      // is expected to be present here — the inverse of the stripped case.
      expect(submitted.body).toContain(RAW_MODEL_TEXT);
      expect(submitted.event).toBe("APPROVE");

      expect(result.status).toBe("reviewed");
      expect(result.reason).not.toContain("[cot-leakage");

      // The guard is action-gated: nothing was stripped, so nothing is logged.
      expect(findLogEvent(logs, COT_LEAK_EVENT)).toBeNull();
    });
  });

  // ── How far past the sanitize wiring this harness actually reaches ──────────
  //
  // mt#1263's spec asks whether this harness is reusable enough to unblock
  // mt#2725's open question — whether the PRODUCTION path calls
  // `persistConvergenceMetric`, which `review-worker.test.ts`'s
  // `persistConvergenceMetric (mt#2725)` block can only verify in isolation.
  // Asserting it here answers that with evidence rather than inference, and
  // bounds the answer: this proves the PROSE path reaches the finalize tail.
  // The half mt#2725's comment actually names is the OUTPUT-TOOLS path, which
  // needs `provider: "openai"` and a `reviewerCaller` returning `toolCalls` —
  // reachable through these same seams, but not exercised here.
  test("the harness drives execution through the finalize tail, not just the submit", async () => {
    const recorder = newRecorder();
    const metricWrites: Array<{ verdict?: unknown; newBlockerCount?: unknown }> = [];

    await runWithCapture(
      baseDeps(sanitizeResult("stripped", STRIPPED_BODY, "blank-line-run"), recorder, {
        metricsRecorder: async (_db, input) => {
          metricWrites.push(input);
        },
      })
    );

    // `persistConvergenceMetric` (review-finalize.ts) is `deps.db`-gated and then
    // delegates to `deps.metricsRecorder`. One write means execution got past the
    // submit, through `finalizeReviewSuccess`, and into the shared metric tail
    // mt#2731 extracted.
    expect(metricWrites).toHaveLength(1);
    // The verdict is derived from the same `outcome.event` the submit used, so
    // this also re-pins the event against a second observer.
    expect(metricWrites[0]?.verdict).toBe("request_changes");
    expect(metricWrites[0]?.newBlockerCount).toBe(1);
  });
});
