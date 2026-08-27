/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp transcript files exercise the real seed/tail/process path; fs.watch integration is covered by scripts/smoke-transcript-watcher.ts */
/**
 * Tests for the testable core of the cockpit transcript watcher (mt#2320):
 * `seedExisting` + `processFile` gating, registry updates, and the per-path
 * in-flight guard — with an injected ingest spy (no DB, no fs.watch).
 *
 * The fs.watch event wiring + real ingest are verified end-to-end by
 * `scripts/smoke-transcript-watcher.ts` (env-gated on DATABASE_URL).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TranscriptWatcher } from "./transcript-watcher";
import { TranscriptWatcherTracker } from "./transcript-watcher-tracker";

const userLine = (text: string, ts: string) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    cwd: "/c",
    timestamp: ts,
  });

async function writeLines(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.length ? `${lines.join("\n")}\n` : "");
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("TranscriptWatcher core (mt#2320)", () => {
  let root: string;
  let tracker: TranscriptWatcherTracker;
  let ingestCalls: string[];
  let ingestReturn: number;
  let gate: Deferred | null;

  const makeWatcher = () =>
    new TranscriptWatcher({
      claudeProjectsDir: root,
      tracker,
      ingestFile: async (path: string) => {
        ingestCalls.push(path);
        if (gate) await gate.promise;
        return ingestReturn;
      },
    });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "transcript-watcher-"));
    tracker = TranscriptWatcherTracker.resetForTest();
    ingestCalls = [];
    ingestReturn = 1;
    gate = null;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("seedExisting registers existing transcripts (incl. subagents) and seeds offsets to EOF", async () => {
    const rootSession = join(root, "proj-a", "sess-1.jsonl");
    const subSession = join(root, "proj-a", "sess-1", "subagents", "agent-x.jsonl");
    await writeLines(rootSession, [userLine("hi", "2026-06-18T00:00:00.000Z")]);
    await writeLines(subSession, [userLine("sub", "2026-06-18T00:00:00.000Z")]);

    const watcher = makeWatcher();
    const count = await watcher.seedExisting();
    expect(count).toBe(2);

    const sessions = tracker.getActiveSessions();
    expect(sessions.map((s) => s.agentSessionId).sort()).toEqual(["agent-x", "sess-1"]);
    expect(sessions.find((s) => s.agentSessionId === "agent-x")?.isSubagent).toBe(true);
    expect(tracker.getSummary().filesWatched).toBe(2);

    // Offset seeded to EOF → an unchanged file does NOT trigger ingest.
    await watcher.processFile(rootSession);
    expect(ingestCalls).toEqual([]);
  });

  test("processFile ingests when new content is appended after seeding", async () => {
    const session = join(root, "proj-a", "sess-1.jsonl");
    await writeLines(session, [userLine("first", "2026-06-18T00:00:00.000Z")]);

    const watcher = makeWatcher();
    await watcher.seedExisting();

    await appendFile(session, `${userLine("second", "2026-06-18T00:00:01.000Z")}\n`);
    ingestReturn = 1;
    await watcher.processFile(session);

    expect(ingestCalls).toEqual([session]);
    const entry = tracker.getActiveSessions().find((s) => s.agentSessionId === "sess-1");
    expect(entry?.lastIngestAt).not.toBeNull();
    expect(entry?.lastTurnsIngested).toBe(1);
  });

  test("processFile ingests a brand-new (unseeded) file from the start and registers it", async () => {
    const session = join(root, "proj-a", "new-session.jsonl");
    await writeLines(session, [userLine("hello", "2026-06-18T00:00:00.000Z")]);

    const watcher = makeWatcher();
    await watcher.processFile(session);

    expect(ingestCalls).toEqual([session]);
    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).toContain("new-session");
  });

  test("processFile skips ingest when only an incomplete (newline-less) line is present", async () => {
    const session = join(root, "proj-a", "partial.jsonl");
    await mkdir(dirname(session), { recursive: true });
    await writeFile(session, '{"type":"user","message":'); // no trailing newline

    const watcher = makeWatcher();
    await watcher.processFile(session);

    expect(ingestCalls).toEqual([]);
    // Still registered (we observed an event for it).
    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).toContain("partial");
  });

  test("processFile on a vanished file removes it from the registry and does not ingest", async () => {
    const session = join(root, "proj-a", "ghost.jsonl");
    await writeLines(session, [userLine("x", "2026-06-18T00:00:00.000Z")]);
    const watcher = makeWatcher();
    await watcher.seedExisting();
    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).toContain("ghost");

    await rm(session);
    await watcher.processFile(session);

    expect(ingestCalls).toEqual([]);
    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).not.toContain("ghost");
  });

  test("per-path in-flight guard ingests once under concurrent processing", async () => {
    const session = join(root, "proj-a", "busy.jsonl");
    await writeLines(session, [userLine("a", "2026-06-18T00:00:00.000Z")]);
    const watcher = makeWatcher();

    gate = deferred();
    const p1 = watcher.processFile(session); // enters, adds in-flight, awaits ingest gate
    const p2 = watcher.processFile(session); // sees in-flight → no-op
    gate.resolve();
    await Promise.all([p1, p2]);

    expect(ingestCalls).toEqual([session]);
  });
});

describe("TranscriptWatcher DB handle across a pool recycle (mt#4480)", () => {
  /**
   * The watcher cached its DB handle for the life of the process. A pool
   * recycle (mt#3638) ENDS the old `Sql` instance and postgres-js then rejects
   * every query on a handle derived from it with `CONNECTION_ENDED` forever, so
   * one recycle silently killed the PRIMARY transcript-capture path and left
   * freshness to the 30-minute sweep backstop. Measured on a live daemon before
   * the fix: 47 ingests triggered, 16 succeeded, 31 errored, with `lastIngestAt`
   * 75 minutes stale while `lastErrorAt` was current.
   */
  test("re-resolves the handle after the persistence epoch moves", async () => {
    const first = { id: "before-recycle" } as unknown as Parameters<typeof Object.freeze>[0];
    const second = { id: "after-recycle" } as unknown as Parameters<typeof Object.freeze>[0];

    let epoch = 0;
    const handedOut: unknown[] = [];
    const watcher = new TranscriptWatcher({
      claudeProjectsDir: "/nonexistent",
      tracker: TranscriptWatcherTracker.resetForTest(),
      getEpoch: () => epoch,
      getDb: async () => {
        const db = epoch === 0 ? first : second;
        handedOut.push(db);
        return db as never;
      },
    });

    const resolve = (watcher as unknown as { resolveDb: () => Promise<unknown> }).resolveDb.bind(
      watcher
    );

    expect(await resolve()).toBe(first);
    // Cached within one epoch: the resolver is not called again.
    expect(await resolve()).toBe(first);
    expect(handedOut).toHaveLength(1);

    // The recycle.
    epoch = 1;

    expect(await resolve()).toBe(second);
    expect(handedOut).toHaveLength(2);
  });

  test("a null handle is not cached, so a not-yet-ready container is retried", async () => {
    let ready = false;
    const live = { id: "live" };
    const watcher = new TranscriptWatcher({
      claudeProjectsDir: "/nonexistent",
      tracker: TranscriptWatcherTracker.resetForTest(),
      getEpoch: () => 0,
      getDb: async () => (ready ? (live as never) : null),
    });

    const resolve = (watcher as unknown as { resolveDb: () => Promise<unknown> }).resolveDb.bind(
      watcher
    );

    expect(await resolve()).toBeNull();
    ready = true;
    expect(await resolve()).toBe(live);
  });
});

describe("TranscriptWatcher bounded ingest and in-flight visibility (mt#4492)", () => {
  let root: string;
  let tracker: TranscriptWatcherTracker;
  let ingestCalls: string[];
  let gate: Deferred | null;
  let clockMs: number;
  /**
   * Entry-counting seam: resolves once N ingests have been ENTERED.
   *
   * Needed because `processFile` is async and parks at its first await
   * (`fileExists`) — so an unawaited call has not reached the ingest, and
   * asserting straight after it observes a watcher that has done nothing yet.
   * Awaiting this makes "N ingests are now in flight" a fact rather than a
   * number of microtasks guessed at, and it counts rather than latching so the
   * concurrent case can wait for both.
   */
  let entriesSeen: number;
  let entriesWanted: number;
  let entriesDeferred: Deferred | null;

  const onIngestEntry = () => {
    entriesSeen++;
    if (entriesDeferred && entriesSeen >= entriesWanted) entriesDeferred.resolve();
  };
  const waitForEntries = (n: number): Promise<void> => {
    if (entriesSeen >= n) return Promise.resolve();
    entriesWanted = n;
    entriesDeferred = deferred();
    return entriesDeferred.promise;
  };

  /** A timeout arm that wins the race immediately — no real 90s wait. */
  const instantTimeout = async () => ({ timedOut: true }) as const;

  const makeWatcher = (over: { timeoutSignal?: () => Promise<{ timedOut: true }> } = {}) =>
    new TranscriptWatcher({
      claudeProjectsDir: root,
      tracker,
      now: () => clockMs,
      ingestFile: async (path: string) => {
        ingestCalls.push(path);
        onIngestEntry();
        if (gate) await gate.promise;
        return 1;
      },
      ...over,
    });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "transcript-watcher-bound-"));
    tracker = TranscriptWatcherTracker.resetForTest();
    ingestCalls = [];
    gate = null;
    entriesSeen = 0;
    entriesWanted = 0;
    entriesDeferred = null;
    clockMs = 1_000_000;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * The defect this task exists for, at its narrowest.
   *
   * NEGATIVE CONTROL: on the pre-fix tree the in-flight guard's `return`
   * preceded `recordSessionEvent`, so the second event stamped nothing and this
   * assertion fails. Removing the registry entry between the two calls is the
   * deterministic proxy for that: it makes "the second event stamped liveness"
   * observable without racing two `Date.now()` reads a millisecond apart.
   *
   * Why it matters in production: the stamp feeds `lastEventAt`, and
   * `getLiveSessions` drops any entry outside a 2-minute window. So a path whose
   * ingest hung stopped refreshing its stamp and simply vanished from the live
   * list — the conversation looked idle precisely because it was stuck.
   */
  test("an event arriving while an ingest is in flight still stamps liveness", async () => {
    const session = join(root, "proj-a", "busy.jsonl");
    await writeLines(session, [userLine("a", "2026-08-24T00:00:00.000Z")]);
    const watcher = makeWatcher();

    gate = deferred();
    const first = watcher.processFile(session); // enters, holds inFlight, awaits the gate
    await waitForEntries(1); // the ingest is genuinely in flight now
    // Drop the entry the first call registered, so the next assertion can only
    // pass if the SECOND call re-registers it from the in-flight guard branch.
    tracker.removeSession("busy");
    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).not.toContain("busy");

    await watcher.processFile(session); // hits the in-flight guard

    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).toContain("busy");
    // The ingest itself is still correctly skipped — exactly one call.
    expect(ingestCalls).toEqual([session]);

    gate.resolve();
    await first;
  });

  test("an in-flight ingest reports a derived age on /api/health", async () => {
    const session = join(root, "proj-a", "slow.jsonl");
    await writeLines(session, [userLine("a", "2026-08-24T00:00:00.000Z")]);
    const watcher = makeWatcher();

    gate = deferred();
    const pending = watcher.processFile(session);
    await waitForEntries(1);

    // Read the summary 5s after the ingest started, with both clocks injected —
    // the age is the assertion, so it is derived, not slept for.
    const during = tracker.getSummary(clockMs + 5_000);
    expect(during.ingestsInFlight).toBe(1);
    expect(during.oldestIngestInFlightAgeMs).toBe(5_000);

    gate.resolve();
    await pending;

    const after = tracker.getSummary(clockMs + 5_000);
    expect(after.ingestsInFlight).toBe(0);
    expect(after.oldestIngestInFlightAgeMs).toBeNull();
  });

  test("an ingest that never settles is abandoned at the bound and releases the path", async () => {
    const session = join(root, "proj-a", "wedged.jsonl");
    await writeLines(session, [userLine("a", "2026-08-24T00:00:00.000Z")]);
    // Never resolves on its own — the injected timeout is the only way out.
    gate = deferred();
    const watcher = makeWatcher({ timeoutSignal: instantTimeout });

    await watcher.processFile(session);

    const s = tracker.getSummary(clockMs);
    expect(s.ingestsAbandoned).toBe(1);
    // Released, not leaked: the path is no longer reported in flight, so the
    // next event can retry it rather than bouncing off a permanently-held guard.
    expect(s.ingestsInFlight).toBe(0);
    // NOT counted as an error — the abandoned operation may still succeed late,
    // and would then record its own success from inside the ingest.
    expect(s.ingestErrors).toBe(0);
    expect(s.ingestPausedUntil).toBeNull();

    gate.resolve();
  });

  /**
   * PR #3282 R1 (BLOCKING). The tracker's in-flight map was keyed by
   * `agentSessionId`, which is only the jsonl BASENAME — so two files under
   * different project directories collapsed onto one entry: the second start
   * overwrote the first's timestamp and the first settle deleted the shared
   * entry while the other was still running. Both the count and the OLDEST age
   * were wrong, which is precisely the observability this task adds.
   *
   * NEGATIVE CONTROL: keyed by session id, `ingestsInFlight` reads 1 here, not
   * 2, and the age reflects the younger start.
   */
  test("two concurrent ingests sharing a session id are counted separately", async () => {
    // Same basename under different project dirs → same agentSessionId ("dup"),
    // different paths, so the per-path in-flight guard admits both.
    const a = join(root, "proj-a", "dup.jsonl");
    const b = join(root, "proj-b", "dup.jsonl");
    await writeLines(a, [userLine("a", "2026-08-24T00:00:00.000Z")]);
    await writeLines(b, [userLine("b", "2026-08-24T00:00:00.000Z")]);
    const watcher = makeWatcher();

    gate = deferred();
    const p1 = watcher.processFile(a);
    await waitForEntries(1);
    // Advance the clock between the two starts so the reported age can only be
    // right if the OLDER start survived.
    clockMs += 30_000;
    const p2 = watcher.processFile(b);
    await waitForEntries(2);

    const during = tracker.getSummary(clockMs + 1_000);
    expect(during.ingestsInFlight).toBe(2);
    // Oldest = the first start, 31s ago — not the second's 1s.
    expect(during.oldestIngestInFlightAgeMs).toBe(31_000);

    gate.resolve();
    await Promise.all([p1, p2]);
    expect(tracker.getSummary(clockMs).ingestsInFlight).toBe(0);
  });

  /**
   * PR #3282 R1 (BLOCKING). The watcher clears its pause lazily, on the next
   * event — correct for GATING, wrong for the health surface, which would keep
   * reporting an expired pause indefinitely if no further event arrived. A
   * field that misreports its own state is the defect class this task removes,
   * so the surface derives it at read time.
   *
   * NEGATIVE CONTROL: echoing the stored timestamp, the third read below still
   * returns the ISO string rather than null.
   */
  test("ingestPausedUntil goes null at read time once the window elapses, with no further events", () => {
    const pausedUntil = clockMs + 5 * 60_000;
    tracker.setIngestPausedUntil(pausedUntil);

    expect(tracker.getSummary(clockMs).ingestPausedUntil).toBe(new Date(pausedUntil).toISOString());
    // One ms before the horizon: still paused.
    expect(tracker.getSummary(pausedUntil - 1).ingestPausedUntil).not.toBeNull();
    // At and past the horizon: null, without any event having occurred.
    expect(tracker.getSummary(pausedUntil).ingestPausedUntil).toBeNull();
    expect(tracker.getSummary(pausedUntil + 60_000).ingestPausedUntil).toBeNull();
  });

  /**
   * mt#4502. `noteAbandonedIngest` re-armed the pause on EVERY abandon past the
   * threshold. During a pause `processFile` returns before starting any ingest,
   * so no success can reset the streak — while ingests started BEFORE the pause
   * keep timing out, each pushing the horizon a further window out. Measured on
   * the live daemon: 15:13:44Z → 15:14:19Z → 15:14:24Z → 15:14:48Z with
   * `ingestsTriggered`/`ingestsSucceeded` frozen, ending only when the last
   * straggler drained — which is not a bound.
   *
   * NEGATIVE CONTROL: re-arming unconditionally, the final horizon moves by the
   * 60s the clock advances below.
   */
  test("an abandon while already paused does not extend the pause window", async () => {
    const files = ["z", "a", "b", "c"].map((n) => join(root, "proj-a", `${n}.jsonl`));
    for (const f of files) await writeLines(f, [userLine("x", "2026-08-24T00:00:00.000Z")]);

    // A timeout arm whose firing this test controls, one gate per ingest, so a
    // straggler can be made to time out AFTER the pause is already armed.
    const gates: Deferred[] = [];
    const gatedTimeout = async () => {
      const d = deferred();
      gates.push(d);
      await d.promise;
      return { timedOut: true } as const;
    };

    gate = deferred(); // ingests never settle on their own
    const watcher = makeWatcher({ timeoutSignal: gatedTimeout });

    // `z` starts first and stays in flight — the pre-pause straggler.
    const zPending = watcher.processFile(files[0] as string);
    await waitForEntries(1);

    // a, b, c each abandon in turn, tripping the threshold.
    for (let i = 1; i <= 3; i++) {
      const p = watcher.processFile(files[i] as string);
      await waitForEntries(i + 1);
      gates[i]?.resolve();
      await p;
    }

    const armed = tracker.getSummary(clockMs).ingestPausedUntil;
    expect(armed).not.toBeNull();
    expect(tracker.getSummary(clockMs).ingestsAbandoned).toBe(3);

    // Time passes, then the straggler finally times out — still inside the pause.
    clockMs += 60_000;
    gates[0]?.resolve();
    await zPending;

    const after = tracker.getSummary(clockMs);
    expect(after.ingestsAbandoned).toBe(4); // still counted
    expect(after.ingestPausedUntil).toBe(armed); // but NOT extended
  });

  /**
   * The streak must reset on a SETTLED ingest, or a busy stretch interleaved
   * with successes eventually pauses a perfectly healthy watcher.
   *
   * `instantTimeout` cannot express this: `raceAgainstTimeout` adds a `.then`
   * to the operation arm, so an immediately-resolving timeout always wins by a
   * microtask and even an intended success abandons. The gated arm is what
   * makes "the ingest won the race" constructible.
   */
  test("a settled ingest resets the abandon streak, so a busy stretch cannot pause", async () => {
    const files = ["a", "b", "s", "c", "d"].map((n) => join(root, "proj-a", `${n}.jsonl`));
    for (const f of files) await writeLines(f, [userLine("x", "2026-08-24T00:00:00.000Z")]);

    const gates: Deferred[] = [];
    const gatedTimeout = async () => {
      const d = deferred();
      gates.push(d);
      await d.promise;
      return { timedOut: true } as const;
    };
    const watcher = makeWatcher({ timeoutSignal: gatedTimeout });

    /** Run one file to an ABANDON by firing its timeout gate. */
    const abandonOne = async (file: string, nthEntry: number) => {
      gate = deferred(); // this ingest never settles on its own
      const p = watcher.processFile(file);
      await waitForEntries(nthEntry);
      gates[nthEntry - 1]?.resolve();
      await p;
    };

    // Two abandons — one short of the threshold.
    await abandonOne(files[0] as string, 1);
    await abandonOne(files[1] as string, 2);
    expect(tracker.getSummary(clockMs).ingestsAbandoned).toBe(2);

    // One ingest that genuinely settles: clear the ingest gate so it resolves,
    // and never fire its timeout gate, so the operation arm wins the race.
    gate = null;
    await watcher.processFile(files[2] as string);
    expect(tracker.getSummary(clockMs).ingestsAbandoned).toBe(2);

    // Two more abandons. Without the reset these would be the 3rd and 4th
    // CONSECUTIVE and would pause; with it they are the 1st and 2nd.
    await abandonOne(files[3] as string, 4);
    await abandonOne(files[4] as string, 5);

    const s = tracker.getSummary(clockMs);
    expect(s.ingestsAbandoned).toBe(4);
    expect(s.ingestPausedUntil).toBeNull();
  });

  /**
   * PR #3284 R1 (BLOCKING). `isIngestPaused()` lazily clears an expired pause
   * AND resets the streak as a side effect. Testing the threshold before that
   * read meant an abandon arriving just past expiry was judged against the
   * streak the expiry had already cleared, and re-armed the pause immediately —
   * so a single straggler could keep a healthy watcher paused indefinitely, one
   * window at a time. Same latch as mt#4502, one branch over.
   *
   * NEGATIVE CONTROL: counting before reading, the final assertion sees a fresh
   * horizon instead of null.
   */
  test("an abandon arriving after the pause expired starts a fresh streak, it does not re-arm", async () => {
    // The abandon must reach `noteAbandonedIngest` WITHOUT a fresh `processFile`
    // ahead of it — a `processFile` calls `isIngestPaused()` itself and would
    // clear the expired pause (and the streak) before the ingest ever runs, so
    // routing the abandon through one cannot exercise this branch. A straggler
    // started before the pause and timing out after it expires is the only way
    // in, and is exactly the production shape.
    const files = ["z", "a", "b", "c"].map((n) => join(root, "proj-a", `${n}.jsonl`));
    for (const f of files) await writeLines(f, [userLine("x", "2026-08-24T00:00:00.000Z")]);

    const gates: Deferred[] = [];
    const gatedTimeout = async () => {
      const d = deferred();
      gates.push(d);
      await d.promise;
      return { timedOut: true } as const;
    };
    gate = deferred();
    const watcher = makeWatcher({ timeoutSignal: gatedTimeout });

    const zPending = watcher.processFile(files[0] as string);
    await waitForEntries(1);

    for (let i = 1; i <= 3; i++) {
      const p = watcher.processFile(files[i] as string);
      await waitForEntries(i + 1);
      gates[i]?.resolve();
      await p;
    }
    expect(tracker.getSummary(clockMs).ingestPausedUntil).not.toBeNull();

    // The window elapses with no `processFile` in between, so nothing has
    // cleared the streak — it is still at the threshold.
    clockMs += 5 * 60_000 + 1;

    // Now the straggler times out. It is the FIRST abandon of a new window, not
    // the fourth of the old one.
    gates[0]?.resolve();
    await zPending;

    const s = tracker.getSummary(clockMs);
    expect(s.ingestsAbandoned).toBe(4);
    expect(s.ingestPausedUntil).toBeNull();
  });

  test("consecutive abandons pause the ingest path, and the pause lifts on its own", async () => {
    const files = ["a", "b", "c", "d"].map((n) => join(root, "proj-a", `${n}.jsonl`));
    for (const f of files) await writeLines(f, [userLine("x", "2026-08-24T00:00:00.000Z")]);
    gate = deferred();
    const watcher = makeWatcher({ timeoutSignal: instantTimeout });

    // Three abandons trips the threshold.
    for (const f of files.slice(0, 3)) await watcher.processFile(f);

    const paused = tracker.getSummary(clockMs);
    expect(paused.ingestsAbandoned).toBe(3);
    expect(paused.ingestPausedUntil).not.toBeNull();
    expect(ingestCalls).toHaveLength(3);

    // While paused: the event still stamps liveness, but no ingest is attempted.
    await watcher.processFile(files[3] as string);
    expect(ingestCalls).toHaveLength(3);
    expect(tracker.getActiveSessions().map((s) => s.agentSessionId)).toContain("d");

    // Once the window elapses the path resumes without any external prod.
    clockMs += 5 * 60_000 + 1;
    await watcher.processFile(files[3] as string);
    expect(ingestCalls).toHaveLength(4);
    expect(tracker.getSummary(clockMs).ingestPausedUntil).toBeNull();

    gate.resolve();
  });
});
