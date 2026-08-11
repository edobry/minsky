import { describe, test, expect } from "bun:test";
import {
  computeDispatchStaleness,
  classifyDispatchRecoveryState,
  buildDispatchRecoveryContinuationPrompt,
  describeDispatchStalenessForMessage,
  DISPATCH_RECOVERY_STALE_MS,
  DISPATCH_PROGRESS_STALE_MS,
  DISPATCH_RECOVERY_CLASSIFICATION_VALUES,
  type DispatchRecoveryPromptInput,
  type DispatchRecoveryClassification,
} from "./dispatch-recovery-classifier";

// Shared classification literals (custom/no-magic-string-duplication) — reused across the
// classify + prompt describe blocks below rather than repeating the raw string.
const CRASHED_NO_OUTPUT: DispatchRecoveryClassification = "crashed-no-output";
const PARTIAL_UNCOMMITTED_NO_HANDOFF: DispatchRecoveryClassification =
  "partial-uncommitted-no-handoff";
const PARTIAL_COMMITTED_HANDOFF_WRITTEN: DispatchRecoveryClassification =
  "partial-committed-handoff-written";
const COMMITTED_NO_PR: DispatchRecoveryClassification = "committed-no-pr";

describe("DISPATCH_RECOVERY_CLASSIFICATION_VALUES membership (mt#3894)", () => {
  test("is exactly the four resumable workspace states", () => {
    // Exact membership, not a `not.toContain` — an enum member added later would slip past a
    // negative assertion, and the question this pins is which outcomes this recovery path
    // claims it can resume from.
    expect([...DISPATCH_RECOVERY_CLASSIFICATION_VALUES].sort()).toEqual([
      COMMITTED_NO_PR,
      CRASHED_NO_OUTPUT,
      PARTIAL_COMMITTED_HANDOFF_WRITTEN,
      PARTIAL_UNCOMMITTED_NO_HANDOFF,
    ]);
  });

  test("excludes `no-workspace` — there is no workspace to resume", () => {
    // Every value above names a state of a SESSION WORKSPACE this path resumes from. A dispatch
    // that never had one cannot be resumed, so offering it as a recovery candidate would send
    // the operator to inspect a workspace that does not exist.
    expect([...DISPATCH_RECOVERY_CLASSIFICATION_VALUES]).not.toContain("no-workspace");
  });
});

describe("computeDispatchStaleness", () => {
  const START = Date.parse("2026-07-17T10:00:00Z");

  test("not stale when a recent commit is within the window", () => {
    const now = START + 10 * 60 * 1000; // 10 min later
    const lastCommit = START + 5 * 60 * 1000; // committed 5 min ago
    const result = computeDispatchStaleness(START, lastCommit, now);
    expect(result.stale).toBe(false);
    expect(result.lastActivityAtMs).toBe(lastCommit);
  });

  test("stale when no activity beyond dispatch start for >= the threshold", () => {
    const now = START + DISPATCH_RECOVERY_STALE_MS;
    const result = computeDispatchStaleness(START, null, now);
    expect(result.stale).toBe(true);
    expect(result.lastActivityAtMs).toBe(START);
    expect(result.staleForMs).toBe(DISPATCH_RECOVERY_STALE_MS);
  });

  test("healthy long-running dispatch with a commit just under the threshold is NOT stale (false-positive-kill guard)", () => {
    const lastCommit = START + 20 * 60 * 1000;
    const now = lastCommit + (DISPATCH_RECOVERY_STALE_MS - 1000);
    const result = computeDispatchStaleness(START, lastCommit, now);
    expect(result.stale).toBe(false);
  });

  test("uses the max of startedAt and lastCommitAtMs even if the commit predates dispatch start (clock skew guard)", () => {
    const lastCommit = START - 1000;
    const now = START + 1000;
    const result = computeDispatchStaleness(START, lastCommit, now);
    expect(result.lastActivityAtMs).toBe(START);
    expect(result.stale).toBe(false);
  });

  test("respects a custom staleMs threshold", () => {
    const now = START + 5000;
    const result = computeDispatchStaleness(START, null, now, 1000);
    expect(result.stale).toBe(true);
  });

  // mt#3086 AT1: "Simulated alive-but-quiet dispatch (recent transcript
  // activity, no commits) -> recover returns healthy." At the pure-function
  // level, "transcript activity" is represented by `lastPresenceActivityAtMs`
  // (the presence-claims-derived proxy — see the function's docstring for
  // why this stands in for the harness transcript JSONL mtime).
  test("alive-but-quiet: recent presence-claim activity, no commits, past the stale window -> NOT stale (mt#3086 AT1)", () => {
    const now = START + DISPATCH_RECOVERY_STALE_MS + 5 * 60 * 1000; // 35 min after dispatch
    const lastPresenceActivityAtMs = now - 2 * 60 * 1000; // an MCP tool call 2 min ago
    const result = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      lastPresenceActivityAtMs
    );
    expect(result.stale).toBe(false);
    expect(result.lastActivityAtMs).toBe(lastPresenceActivityAtMs);
    expect(result.activitySource).toBe("presence");
  });

  test("genuinely dead: stale commit AND stale (or absent) presence activity -> stale, recover unchanged (mt#3086 AT2)", () => {
    const staleLastCommit = START + 1000; // long past, doesn't help
    const stalePresence = START + 2000; // also long past the window
    const now = stalePresence + DISPATCH_RECOVERY_STALE_MS + 1000; // well past the window from BOTH signals
    const result = computeDispatchStaleness(
      START,
      staleLastCommit,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      stalePresence
    );
    expect(result.stale).toBe(true);

    // Absent presence signal entirely (null) behaves identically to today.
    const resultNoPresence = computeDispatchStaleness(
      START,
      staleLastCommit,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      null
    );
    expect(resultNoPresence.stale).toBe(true);
  });

  test("activitySource reports which signal produced lastActivityAtMs", () => {
    const now = START + 10 * 60 * 1000;
    expect(computeDispatchStaleness(START, null, now).activitySource).toBe("dispatch-start");
    expect(computeDispatchStaleness(START, START + 5 * 60 * 1000, now).activitySource).toBe(
      "commit"
    );
    expect(
      computeDispatchStaleness(START, null, now, DISPATCH_RECOVERY_STALE_MS, START + 9 * 60 * 1000)
        .activitySource
    ).toBe("presence");
  });

  test("presence activity older than commit activity does not override the commit signal", () => {
    const now = START + 20 * 60 * 1000;
    const lastCommit = START + 15 * 60 * 1000;
    const olderPresence = START + 1000;
    const result = computeDispatchStaleness(
      START,
      lastCommit,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      olderPresence
    );
    expect(result.lastActivityAtMs).toBe(lastCommit);
    expect(result.activitySource).toBe("commit");
  });

  // mt#3172 PR #2294 R1: pin the tie behavior explicitly — commit and
  // presence sharing the IDENTICAL timestamp must resolve to "commit"
  // (the earlier-checked signal), because the presence check requires
  // STRICTLY exceeding the value the commit check already set (`>`, not
  // `>=`). This is the reference tie behavior the watchdog producer's own
  // staleness computation (src/cockpit/dispatch-watchdog.ts) mirrors.
  test("a commit and presence-claim refresh at the identical timestamp resolve to 'commit' (tie -> earlier-checked signal wins)", () => {
    const now = START + 20 * 60 * 1000;
    const tiedMs = START + 15 * 60 * 1000;
    const result = computeDispatchStaleness(START, tiedMs, now, DISPATCH_RECOVERY_STALE_MS, tiedMs);
    expect(result.lastActivityAtMs).toBe(tiedMs);
    expect(result.activitySource).toBe("commit");
  });

  // ---------------------------------------------------------------------------
  // mt#3193: workspace-mtime signal — closes the non-MCP-tool blind spot
  // (a dispatch working entirely through harness-native Read/Edit/Write/
  // Glob/Grep produces neither a commit nor a presence-claim refresh).
  // ---------------------------------------------------------------------------

  // Acceptance test: "A simulated dispatch whose only activity is non-MCP
  // file writes over a period exceeding the stale window is classified
  // healthy, with activitySource naming the new signal."
  test("non-MCP file-write activity only (no commit, no presence), past the stale window -> NOT stale, activitySource 'workspace-mtime' (mt#3193 AT1)", () => {
    const now = START + DISPATCH_RECOVERY_STALE_MS + 5 * 60 * 1000; // 35 min after dispatch
    const lastWorkspaceMtimeAtMs = now - 2 * 60 * 1000; // a file write 2 min ago
    const result = computeDispatchStaleness(
      START,
      null, // no commit
      now,
      DISPATCH_RECOVERY_STALE_MS,
      null, // no presence-claim activity either
      lastWorkspaceMtimeAtMs
    );
    expect(result.stale).toBe(false);
    expect(result.lastActivityAtMs).toBe(lastWorkspaceMtimeAtMs);
    expect(result.activitySource).toBe("workspace-mtime");
  });

  // Acceptance test: "A simulated dispatch with no activity of any kind
  // past the window is still classified recover." — a null/stale
  // workspace-mtime signal must not turn a genuinely dead dispatch healthy.
  test("genuinely dead: no commit, no presence, no workspace-mtime activity -> stale (mt#3193 AT2)", () => {
    const now = START + DISPATCH_RECOVERY_STALE_MS + 1000;
    const result = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      null,
      null
    );
    expect(result.stale).toBe(true);
    expect(result.activitySource).toBe("dispatch-start");

    // A workspace-mtime signal that is itself long past the window changes
    // nothing either.
    const staleMtime = START + 500;
    const resultStaleMtime = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      null,
      staleMtime
    );
    expect(resultStaleMtime.stale).toBe(true);
  });

  test("workspace-mtime activity older than commit/presence activity does not override the fresher signal", () => {
    const now = START + 20 * 60 * 1000;
    const lastPresence = START + 15 * 60 * 1000;
    const olderMtime = START + 1000;
    const result = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      lastPresence,
      olderMtime
    );
    expect(result.lastActivityAtMs).toBe(lastPresence);
    expect(result.activitySource).toBe("presence");
  });

  // Tie semantics: workspace-mtime is checked LAST, so a tie against presence
  // resolves to "presence" (the earlier-checked signal), matching the
  // existing commit-vs-presence tie rule.
  test("presence and workspace-mtime at the identical timestamp resolve to 'presence' (tie -> earlier-checked signal wins)", () => {
    const now = START + 20 * 60 * 1000;
    const tiedMs = START + 15 * 60 * 1000;
    const result = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      tiedMs,
      tiedMs
    );
    expect(result.lastActivityAtMs).toBe(tiedMs);
    expect(result.activitySource).toBe("presence");
  });

  test("a fresh workspace-mtime signal alone (no commit, no presence) suppresses staleness even when startedAt is old", () => {
    const now = START + 90 * 60 * 1000; // 90 min after dispatch — far past the window
    const freshMtime = now - 1000; // a write 1 second ago
    const result = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      null,
      freshMtime
    );
    expect(result.stale).toBe(false);
    expect(result.activitySource).toBe("workspace-mtime");
  });

  // ---------------------------------------------------------------------------
  // mt#3952: progress bound — presence alone no longer holds `healthy`
  // indefinitely. mt#3812 is the standing instance: presence refreshed every
  // ~10 minutes for 8+ hours while commit and workspace-mtime never moved.
  // ---------------------------------------------------------------------------

  // Spec Acceptance Test 1 / Success-Criteria fixture: presence 5 min old,
  // last commit 8h ago, workspace mtime 8h ago, stale window 30 min ->
  // verdict is NOT healthy, and progressStale/progressSource name the
  // starved signal.
  test("presence fresh but commit AND workspace-mtime both 8h stale -> stale via progress starvation, not activity (mt#3952 AT1)", () => {
    const now = START + 8 * 60 * 60 * 1000; // 8h after dispatch
    const lastCommit = START + 5 * 60 * 1000; // 8h - 5min ago (long past the progress bound)
    const lastWorkspaceMtime = START + 4 * 60 * 1000; // slightly earlier — workspace untouched ~8h
    const lastPresence = now - 5 * 60 * 1000; // presence refreshed 5 min ago (fresh)

    const result = computeDispatchStaleness(
      START,
      lastCommit,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      lastPresence,
      lastWorkspaceMtime
    );

    // The base ACTIVITY check alone would read healthy (presence is fresh),
    // but the overall verdict must be stale because progress is starved.
    expect(result.activitySource).toBe("presence");
    expect(result.staleForMs).toBeLessThan(DISPATCH_RECOVERY_STALE_MS);
    expect(result.progressStale).toBe(true);
    // Tied/near-tied commit and workspace-mtime resolve to "commit" (checked
    // first — same precedence the activity computation documents).
    expect(result.progressSource).toBe("commit");
    expect(result.stale).toBe(true);
  });

  // Spec Acceptance Test 2 / Success-Criteria fixture: presence 5 min old,
  // workspace mtime 5 min old, no commit -> healthy (mt#3086 AT1 preserved).
  // The workspace-mtime signal IS a progress signal, so it satisfies both
  // the activity check (already covered above) and the new progress check.
  test("presence fresh, workspace-mtime fresh, no commit -> healthy under the progress bound too (mt#3086 AT1 preserved / mt#3952 AT2)", () => {
    const now = START + 10 * 60 * 1000;
    const lastPresence = now - 5 * 60 * 1000;
    const lastWorkspaceMtime = now - 5 * 60 * 1000;

    const result = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      lastPresence,
      lastWorkspaceMtime
    );

    expect(result.stale).toBe(false);
    expect(result.progressStale).toBe(false);
    expect(result.progressSource).toBe("workspace-mtime");
  });

  // Spec Acceptance Test 3: no presence, no commit, mtime older than the
  // window -> escalate (unchanged) — the ordinary "no activity at all" path
  // must still reach `stale: true` the same way it did before this task.
  test("no presence, no commit, mtime older than the window -> stale (unchanged, mt#3952 AT3)", () => {
    const now = START + DISPATCH_RECOVERY_STALE_MS + 1000;
    const staleMtime = START + 500;
    const result = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      null,
      staleMtime
    );
    // Unchanged behavior: the base activity check alone already produces
    // `stale: true` here (nothing newer than dispatch start within staleMs)
    // — the new progress check is not even the deciding factor for this
    // fixture, since 30 minutes is well under the 2h progress bound.
    expect(result.stale).toBe(true);
    expect(result.progressSource).toBe("workspace-mtime");
  });

  test("neither commit nor workspace-mtime ever fired -> progressSource 'none', progress clock measured from dispatch start", () => {
    const now = START + DISPATCH_PROGRESS_STALE_MS + 1000;
    const lastPresence = now - 1000; // presence stays fresh throughout
    const result = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      lastPresence,
      null
    );
    expect(result.activitySource).toBe("presence");
    expect(result.progressSource).toBe("none");
    expect(result.progressStaleForMs).toBe(now - START);
    expect(result.progressStale).toBe(true);
    expect(result.stale).toBe(true);
  });

  test("progress bound respects a custom progressStaleMs override", () => {
    const now = START + 10 * 60 * 1000;
    const lastPresence = now - 1000;
    const result = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      lastPresence,
      null,
      5 * 60 * 1000 // 5-minute progress bound
    );
    // 10 minutes since dispatch start with no commit/write, against a 5-minute bound.
    expect(result.progressStale).toBe(true);
    expect(result.stale).toBe(true);
  });

  test("a dispatch progressing normally (regular commits/writes) never trips the progress bound even over a long run", () => {
    // Simulates a long-running healthy dispatch: workspace-mtime refreshed
    // every 20 minutes, well under DISPATCH_PROGRESS_STALE_MS (2h).
    const now = START + 3 * 60 * 60 * 1000; // 3h in
    const lastWorkspaceMtime = now - 20 * 60 * 1000; // last write 20 min ago
    const result = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      null,
      lastWorkspaceMtime
    );
    expect(result.progressStale).toBe(false);
    expect(result.stale).toBe(false);
  });
});

describe("describeDispatchStalenessForMessage (mt#3952)", () => {
  const START = Date.parse("2026-07-17T10:00:00Z");

  test("returns '' when the dispatch is not progress-starved", () => {
    const now = START + 5 * 60 * 1000;
    const staleness = computeDispatchStaleness(START, null, now, DISPATCH_RECOVERY_STALE_MS, now);
    expect(staleness.progressStale).toBe(false);
    expect(describeDispatchStalenessForMessage(staleness)).toBe("");
  });

  test("names 'active but not progressing' when presence is fresh but progress is starved", () => {
    const now = START + 8 * 60 * 60 * 1000;
    const lastCommit = START + 5 * 60 * 1000;
    const staleness = computeDispatchStaleness(
      START,
      lastCommit,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      now - 1000,
      lastCommit
    );
    const message = describeDispatchStalenessForMessage(staleness);
    expect(message).toContain("Active but NOT progressing");
    expect(message).toContain("presence alone is not evidence of progress");
  });

  // PR #2819 R1 BLOCKING: the "active but NOT progressing" framing must NOT fire when the
  // base ACTIVITY check is ALSO already stale — a past commit can leave `progressSource`
  // non-"none" while presence itself is long gone, and the message must not misattribute
  // recency to presence it does not have.
  test("names 'Silent and progress-starved' (not 'Active but NOT progressing') when activity is ALSO stale, even though a past commit exists", () => {
    const now = START + 5 * 60 * 60 * 1000; // 5h after dispatch
    const lastCommit = START + 10 * 60 * 1000; // one commit, ~5h ago — long past BOTH bounds
    const staleness = computeDispatchStaleness(
      START,
      lastCommit,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      null, // no presence activity at all
      null // no workspace-mtime activity either
    );
    expect(staleness.activityStale).toBe(true);
    expect(staleness.progressStale).toBe(true);
    expect(staleness.progressSource).toBe("commit");

    const message = describeDispatchStalenessForMessage(staleness);
    expect(message).toContain("Silent and progress-starved");
    expect(message).not.toContain("Active but NOT progressing");
    expect(message).not.toContain("recent tool-call activity");
  });

  test("names 'progress-starved since dispatch start' when neither commit nor write has ever happened", () => {
    const now = START + DISPATCH_PROGRESS_STALE_MS + 1000;
    const staleness = computeDispatchStaleness(
      START,
      null,
      now,
      DISPATCH_RECOVERY_STALE_MS,
      now - 1000,
      null
    );
    const message = describeDispatchStalenessForMessage(staleness);
    expect(message).toContain("Progress-starved");
    expect(message).toContain("since dispatch start");
  });
});

describe("classifyDispatchRecoveryState", () => {
  test("dirty tree, no handoff -> partial-uncommitted-no-handoff", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 3,
        commitsAheadOfBase: 0,
        handoffExists: false,
        hasOpenPr: false,
      })
    ).toBe(PARTIAL_UNCOMMITTED_NO_HANDOFF);
  });

  test("dirty tree with handoff -> partial-committed-handoff-written", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 1,
        commitsAheadOfBase: 2,
        handoffExists: true,
        hasOpenPr: false,
      })
    ).toBe(PARTIAL_COMMITTED_HANDOFF_WRITTEN);
  });

  test("clean tree, commits ahead -> committed-no-pr", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 0,
        commitsAheadOfBase: 4,
        handoffExists: false,
        hasOpenPr: false,
      })
    ).toBe("committed-no-pr");
  });

  test("clean tree, no commits -> crashed-no-output", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 0,
        commitsAheadOfBase: 0,
        handoffExists: false,
        hasOpenPr: false,
      })
    ).toBe(CRASHED_NO_OUTPUT);
  });

  test("null commitsAheadOfBase (undeterminable) treated as zero commits", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 0,
        commitsAheadOfBase: null,
        handoffExists: false,
        hasOpenPr: false,
      })
    ).toBe(CRASHED_NO_OUTPUT);
  });

  test("dirty tree takes priority over commits-ahead when both are present", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 2,
        commitsAheadOfBase: 5,
        handoffExists: false,
        hasOpenPr: false,
      })
    ).toBe(PARTIAL_UNCOMMITTED_NO_HANDOFF);
  });

  // ---------------------------------------------------------------------------
  // mt#3149: PR-existence liveness signal (SC1/SC2 + Acceptance Test 1/4)
  // ---------------------------------------------------------------------------

  test("mt#3149 SC1: clean tree, ZERO commits ahead of base, but an open PR exists -> committed-no-pr, NOT crashed-no-output", () => {
    // Reproduces the originating incident's exact shape: commitsAheadOfBase reads 0
    // (whether from a stale probe or simply never having been re-run) while a PR is
    // demonstrably open. The PR alone must be enough to avoid crashed-no-output.
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 0,
        commitsAheadOfBase: 0,
        handoffExists: false,
        hasOpenPr: true,
      })
    ).toBe("committed-no-pr");
  });

  test("mt#3149 SC1: clean tree, null (undeterminable) commitsAheadOfBase, but an open PR exists -> committed-no-pr", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 0,
        commitsAheadOfBase: null,
        handoffExists: false,
        hasOpenPr: true,
      })
    ).toBe("committed-no-pr");
  });

  test("mt#3149: dirty tree + open PR -> still a partial-* classification, never crashed-no-output", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 1,
        commitsAheadOfBase: 0,
        handoffExists: false,
        hasOpenPr: true,
      })
    ).toBe(PARTIAL_UNCOMMITTED_NO_HANDOFF);
  });

  // mt#3149 Acceptance Test 4 (HARD CONSTRAINT): the fix must not make the
  // classifier permissive — a genuinely dead dispatch (no PR, no commits, no
  // dirty tree) must still land on crashed-no-output.
  test("mt#3149 AT4 (hard constraint): genuinely dead dispatch (no PR, no commits, clean tree) -> still crashed-no-output", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 0,
        commitsAheadOfBase: 0,
        handoffExists: false,
        hasOpenPr: false,
      })
    ).toBe(CRASHED_NO_OUTPUT);
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 0,
        commitsAheadOfBase: null,
        handoffExists: false,
        hasOpenPr: false,
      })
    ).toBe(CRASHED_NO_OUTPUT);
  });
});

describe("buildDispatchRecoveryContinuationPrompt", () => {
  const base: DispatchRecoveryPromptInput = {
    taskId: "mt#9999",
    sessionId: "session-abc",
    sessionDir: "/sessions/session-abc",
    agentType: "implementer",
    classification: CRASHED_NO_OUTPUT,
    dirtyFileCount: 0,
    commitsAheadOfBase: 0,
    handoffExists: false,
    handoffFirstLines: [],
    prNumber: null,
    prUrl: null,
    latestReviewState: null,
    attemptNumber: 2,
    originalStartedAt: "2026-07-17T10:00:00Z",
  };

  test("is session-bound: names the session id and directory, and instructs NOT to start a new session", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt(base);
    expect(prompt).toContain("session-abc");
    expect(prompt).toContain("/sessions/session-abc");
    expect(prompt).toContain("do NOT start a new session");
  });

  test("names the attempt number and the 2-attempt bound", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt(base);
    expect(prompt).toContain("attempt 2 of 2");
    expect(prompt).toContain("no third auto-resume");
  });

  test("partial-uncommitted-no-handoff guidance mentions committing before continuing", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt({
      ...base,
      classification: PARTIAL_UNCOMMITTED_NO_HANDOFF,
      dirtyFileCount: 3,
    });
    expect(prompt).toContain("do NOT discard them");
  });

  test("partial-committed-handoff-written guidance reproduces the handoff content and points to it", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt({
      ...base,
      classification: PARTIAL_COMMITTED_HANDOFF_WRITTEN,
      handoffExists: true,
      handoffFirstLines: ["Done: X", "Remaining: Y"],
    });
    expect(prompt).toContain("Done: X");
    expect(prompt).toContain("Remaining: Y");
    expect(prompt).toContain("handoff.md");
  });

  test("committed-no-pr with no PR yet instructs creating a PR, not re-implementing", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt({
      ...base,
      classification: "committed-no-pr",
      commitsAheadOfBase: 5,
    });
    expect(prompt).toContain("create the PR");
    expect(prompt).toContain("Do not re-implement");
  });

  test("committed-no-pr with an existing PR instructs driving to convergence, not re-implementing", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt({
      ...base,
      classification: "committed-no-pr",
      commitsAheadOfBase: 5,
      prNumber: 1234,
      prUrl: "https://github.com/edobry/minsky/pull/1234",
      latestReviewState: "CHANGES_REQUESTED",
    });
    expect(prompt).toContain("#1234");
    expect(prompt).toContain("drive it to convergence");
    expect(prompt).toContain("CHANGES_REQUESTED");
  });

  test("crashed-no-output guidance treats it as a fresh start", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt(base);
    expect(prompt).toContain("fresh start");
    expect(prompt).toContain("nothing to recover from the workspace");
  });
});
