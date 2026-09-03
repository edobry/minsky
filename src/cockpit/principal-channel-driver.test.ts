/**
 * Tests for the driven-session driver (mt#3228).
 *
 * Uses the same injected-`spawnFn` discipline as driven-session-host.test.ts —
 * no test spawns a real `claude`. The cases worth having are the ones about
 * conversation CONTINUITY, since that is the session driver's whole reason to exist.
 */

/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: the host preflights its spawn cwd against the REAL filesystem, so the session driver's cwd fixture has to be a real directory — there is no fs to inject through the code path under test. A per-run mkdtemp dir keeps the "fixed mock path" race the rule guards against from applying. */
import { describe, expect, test, afterAll } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import {
  DrivenSessionRegistry,
  ClaudeStreamJsonTransport,
  type DrivenSessionRecord,
  type ProcessLike,
  type SpawnFn,
  type SpawnOptions,
} from "./driven-session-host";
import {
  createDrivenSessionDriver,
  createTopicDriverRegistry,
  partialAssistantText,
  resultText,
  PRINCIPAL_CHANNEL_LOCAL_ID,
  type DrivenSessionDriverOptions,
} from "./principal-channel-driver";
import type { ChannelDriver } from "./principal-channel-poller";

// mt#3397 — the host preflights the spawn cwd, so this has to be a REAL
// directory or every spawn below would take the missing-cwd branch instead.
const CWD = mkdtempSync(join(tmpdir(), "principal-channel-"));
const BLOCKED_Q = "what is blocked?";

class FakeClaudeProcess extends EventEmitter implements ProcessLike {
  readonly pid: number | undefined = 424242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  /** Everything written to stdin, accumulated (the stream is in flowing mode). */
  written = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      this.written += String(chunk);
    });
  }

  kill(): boolean {
    return true;
  }

  emitLine(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  /**
   * Emit the `init` event — the child saying "I am up".
   *
   * The host records `harnessSessionId` from this. Wired to fire only ON INPUT
   * (see `fakeSpawn`), because that is what the real binary does — and a fake
   * that emitted it unprompted is exactly what let mt#3234 ship a deadlock:
   * the code waited for init before writing, the real child waits for a write
   * before init, and no test could see it (mt#3238).
   */
  emitInit(sessionId = "fake-harness-session"): void {
    this.emitLine({ type: "system", subtype: "init", session_id: sessionId });
  }

  /** Emit the terminal `result` event that ends one turn. */
  finishTurn(text: string): void {
    this.emitLine({ type: "result", subtype: "success", result: text });
  }

  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

interface SpawnCapture {
  args: string[];
  options: SpawnOptions;
  proc: FakeClaudeProcess;
}

/**
 * Build a spawnFn whose children behave like the real binary.
 *
 * The load-bearing detail (mt#3238): a child emits `init` only AFTER it
 * receives input on stdin. `claude -p --input-format stream-json` works that
 * way, and the previous fake did not — it emitted on a timer regardless of
 * input, which made a deadlocked ordering (wait for init, then write) look
 * correct in every test while failing every real message.
 *
 * `neverReady: true` produces a child that takes input and still never reports
 * init — the mt#3234 incident, where a conversation sat `running` with a null
 * harness id while messages routed into it vanished.
 */
function fakeSpawn(opts: { neverReady?: boolean } = {}): {
  spawnFn: SpawnFn;
  calls: SpawnCapture[];
} {
  const calls: SpawnCapture[] = [];
  const spawnFn: SpawnFn = (_command, args, options) => {
    const proc = new FakeClaudeProcess();
    const index = calls.length + 1;
    calls.push({ args, options, proc });
    if (!opts.neverReady) {
      proc.stdin.once("data", () => {
        // Async, mirroring a real child's startup latency after the write.
        setTimeout(() => proc.emitInit(`harness-${index}`), 1);
      });
    }
    return proc;
  };
  return { spawnFn, calls };
}

function makeSessionDriver(
  overrides: {
    respondToAsk?: (ref: string, text: string) => Promise<string>;
    turnTimeoutMs?: number;
    readyTimeoutMs?: number;
    permissionMode?: "default" | "bypassPermissions";
    neverReady?: boolean;
    onStateChange?: (record: DrivenSessionRecord) => void;
    orchestrateResume?: DrivenSessionDriverOptions["orchestrateResume"];
  } = {}
) {
  const { spawnFn, calls } = fakeSpawn(
    overrides.neverReady === undefined ? {} : { neverReady: overrides.neverReady }
  );
  const registry = new DrivenSessionRegistry();
  const sessionDriver = createDrivenSessionDriver({
    cwd: CWD,
    registry,
    spawnFn,
    respondToAsk: overrides.respondToAsk ?? (async (ref, text) => `answered ${ref}: ${text}`),
    // Short by default: every test here drives a fake, so a real-world budget
    // would only buy slow failures.
    readyTimeoutMs: overrides.readyTimeoutMs ?? 500,
    readyPollMs: 1,
    ...(overrides.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: overrides.turnTimeoutMs }),
    ...(overrides.permissionMode === undefined ? {} : { permissionMode: overrides.permissionMode }),
    ...(overrides.onStateChange === undefined ? {} : { onStateChange: overrides.onStateChange }),
    // Default to "nothing persisted" so the existing tests keep exercising the
    // fresh-spawn path without reaching a real database (mt#3254's guard would
    // refuse that anyway).
    orchestrateResume: overrides.orchestrateResume ?? (async () => ({ outcome: "not-found" })),
  });
  return { sessionDriver, calls, registry };
}

/** Reads a capture's process, failing loudly rather than with a non-null assertion. */
function mustProc(calls: SpawnCapture[], index = 0): FakeClaudeProcess {
  const capture = calls[index];
  if (!capture) throw new Error(`expected a spawn at index ${index}`);
  return capture.proc;
}

/**
 * A record standing in for one a resume-respawn would return — already linked
 * to a harness session, so the session driver treats it as live and does not wait
 * for `init`.
 */
function buildResumedRecord(): DrivenSessionRecord {
  const proc = new FakeClaudeProcess();
  return {
    localId: PRINCIPAL_CHANNEL_LOCAL_ID,
    cwd: CWD,
    permissionMode: "bypassPermissions",
    argv: [],
    startedAt: new Date().toISOString(),
    taskId: null,
    minskySessionId: null,
    status: "running",
    unrecoverableReason: null,
    harnessSessionId: "harness-resumed",
    // mt#4935 — harness-agnostic drive-record fields; today's only real
    // values, matching what a genuine resume would carry forward.
    harnessKind: "claude-code",
    transportId: "claude-stream-json",
    harnessConversationId: "harness-resumed",
    authMode: "subscription",
    pid: 4242,
    exitCode: null,
    exitSignal: null,
    crashError: null,
    stopRequested: false,
    driverGeneration: 1,
    proc,
    // mt#4934 PR #3594 R1 — sendDrivenSessionInput now routes through
    // record.transport rather than a global singleton, so this hand-built
    // fixture needs one too; a real ClaudeStreamJsonTransport instance
    // writes to `proc.stdin` exactly like production, which is what
    // `resumed.proc.written` (via FakeClaudeProcess) asserts against.
    transport: new ClaudeStreamJsonTransport(),
    eventLog: [],
    costHistory: [],
    subscribers: new Set(),
  } as unknown as DrivenSessionRecord;
}

/**
 * Wait until `predicate` holds, rather than sleeping a guessed interval.
 *
 * The suite previously slept a fixed 25ms and hoped the spawn had become ready
 * and the input written by then (PR #2329 R1 flagged the fragility). Polling a
 * condition removes the guess: it returns as soon as the state is true, and
 * fails with a named reason instead of a confusing downstream assertion.
 */
async function waitUntil(predicate: () => boolean, what: string, attempts = 2000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/**
 * Wait until input has been written to the child, optionally containing `needle`.
 *
 * Matches on CONTENT rather than growth: the write usually lands before this is
 * called, so waiting for the buffer to grow would wait for a second write that
 * never comes.
 */
async function waitForWrite(proc: FakeClaudeProcess, needle?: string): Promise<string> {
  await waitUntil(
    () => proc.written.length > 0 && (needle === undefined || proc.written.includes(needle)),
    `input${needle === undefined ? "" : ` containing "${needle}"`} to be written to the child`
  );
  return proc.written;
}

/** Wait until a spawn has been recorded. */
const waitForSpawn = (calls: SpawnCapture[], n: number): Promise<void> =>
  waitUntil(() => calls.length >= n, `${n} spawn(s)`);

describe("createDrivenSessionDriver — conversing", () => {
  test("spawns a conversation on the first message and returns the turn's text", async () => {
    const { sessionDriver, calls } = makeSessionDriver();

    const reply = sessionDriver.converse(BLOCKED_Q);
    await waitForSpawn(calls, 1);
    expect(await waitForWrite(calls[0]?.proc as FakeClaudeProcess)).toContain(BLOCKED_Q);

    calls[0]?.proc.finishTurn("nothing is blocked");
    expect(await reply).toBe("nothing is blocked");
  });

  test("REUSES the conversation across messages", async () => {
    // The whole point: "focus on that one" only resolves against what was
    // just said, so a second message must not get a fresh session.
    const { sessionDriver, calls } = makeSessionDriver();

    const first = sessionDriver.converse("list the tasks");
    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);
    calls[0]?.proc.finishTurn("three tasks");
    await first;

    const second = sessionDriver.converse("focus on the second one");
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess, "focus on the second one");
    calls[0]?.proc.finishTurn("focusing");
    await second;

    expect(calls).toHaveLength(1);
  });

  test("starts a new conversation transparently after the old one exits", async () => {
    // The principal should never have to know a process died.
    const { sessionDriver, calls } = makeSessionDriver();

    const first = sessionDriver.converse("hi");
    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);
    calls[0]?.proc.finishTurn("hello");
    await first;

    calls[0]?.proc.exit(1);

    const second = sessionDriver.converse("still there?");
    await waitForSpawn(calls, 2);
    await waitForWrite(calls[1]?.proc as FakeClaudeProcess);
    calls[1]?.proc.finishTurn("yes");
    expect(await second).toBe("yes");
  });

  test("spawns with the requested permission mode", async () => {
    const { sessionDriver, calls } = makeSessionDriver({ permissionMode: "default" });
    void sessionDriver.converse("hi");
    await waitForSpawn(calls, 1);
    expect(calls[0]?.args).not.toContain("--dangerously-skip-permissions");
  });

  test("defaults to the same permission mode as every other driven session", async () => {
    const { sessionDriver, calls } = makeSessionDriver();
    void sessionDriver.converse("hi");
    await waitForSpawn(calls, 1);
    expect(calls[0]?.args).toContain("--dangerously-skip-permissions");
  });

  test("runs in the configured working directory", async () => {
    const { sessionDriver, calls } = makeSessionDriver();
    void sessionDriver.converse("hi");
    await waitForSpawn(calls, 1);
    expect(calls[0]?.options.cwd).toBe(CWD);
  });

  test("answers rather than hanging when a turn overruns", async () => {
    const { sessionDriver } = makeSessionDriver({ turnTimeoutMs: 10 });
    const reply = await sessionDriver.converse("something slow");
    expect(reply).toContain("longer than expected");
  });
});

describe("createDrivenSessionDriver — control verbs", () => {
  test("interrupt reports that nothing is running when idle", async () => {
    const { sessionDriver } = makeSessionDriver();
    expect(await sessionDriver.interrupt()).toContain("Nothing is running");
  });

  test("interrupt drops the conversation so the next message starts fresh", async () => {
    const { sessionDriver, calls } = makeSessionDriver();
    const first = sessionDriver.converse("hi");
    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);
    calls[0]?.proc.finishTurn("hello");
    await first;

    await sessionDriver.interrupt();
    void sessionDriver.converse("again");
    await waitForSpawn(calls, 2);
    expect(calls).toHaveLength(2);
  });

  test("reset drops the conversation even when idle", async () => {
    const { sessionDriver, calls } = makeSessionDriver();
    expect(await sessionDriver.reset()).toContain("Starting fresh");
    void sessionDriver.converse("hi");
    await waitForSpawn(calls, 1);
    expect(calls).toHaveLength(1);
  });

  test("answerAsk delegates without touching a conversation", async () => {
    const { sessionDriver, calls } = makeSessionDriver({
      respondToAsk: async (ref, text) => `ok ${ref}/${text}`,
    });
    expect(await sessionDriver.answerAsk("abc", "yes")).toBe("ok abc/yes");
    expect(calls).toHaveLength(0);
  });
});

describe("resultText", () => {
  test("returns the turn's text", () => {
    expect(resultText({ type: "result", result: "the answer" })).toBe("the answer");
  });

  test("reports a failed turn rather than going silent", () => {
    // The principal needs to know it failed and why, not receive nothing.
    expect(resultText({ type: "result", subtype: "error_max_turns", is_error: true })).toContain(
      "error_max_turns"
    );
  });

  test("falls back to a placeholder for an empty successful turn", () => {
    expect(resultText({ type: "result", subtype: "success", result: "  " })).toContain("no text");
  });
});

// mt#3243 — Telegram's reply affordance has to survive into the turn.
describe("createDrivenSessionDriver — reply context", () => {
  /** Reads the first spawn's process without a non-null assertion. */
  const firstProc = (calls: SpawnCapture[]): FakeClaudeProcess => {
    const capture = calls[0];
    if (!capture) throw new Error("expected at least one spawn");
    return capture.proc;
  };

  const FOLLOW_UP = "focus on that one";
  const QUOTED = "mt#3243 is the next task";

  test("puts the quoted text in front of the agent, alongside the new message", async () => {
    const { sessionDriver, calls } = makeSessionDriver();

    void sessionDriver.converse(FOLLOW_UP, { replyToText: QUOTED });
    await waitForSpawn(calls, 1);
    const written = await waitForWrite(firstProc(calls), FOLLOW_UP);

    // Both halves must reach the child: the quote is what "that one" resolves
    // against, and the new message is the actual instruction.
    expect(written).toContain(QUOTED);
    expect(written).toContain(FOLLOW_UP);
  });

  test("works on a FRESH conversation — it does not depend on the agent remembering", async () => {
    // Success Criterion 4: a reply carries its own context, so a conversation
    // that has never seen the quoted message can still resolve it.
    const { sessionDriver, calls } = makeSessionDriver();

    void sessionDriver.converse("what did you mean?", {
      replyToText: "the guard goes at the resolver",
    });
    await waitForSpawn(calls, 1);
    const written = await waitForWrite(firstProc(calls), "what did you mean?");

    expect(written).toContain("the guard goes at the resolver");
    expect(calls.length).toBe(1); // first turn of a brand-new conversation
  });

  test("sends the message unchanged when there is no reply target", async () => {
    const { sessionDriver, calls } = makeSessionDriver();

    void sessionDriver.converse("plain message");
    await waitForSpawn(calls, 1);
    const written = await waitForWrite(firstProc(calls), "plain message");

    const payload = JSON.parse(written.trim()) as {
      message: { content: { type: string; text: string }[] };
    };
    expect(payload.message.content[0]?.text).toBe("plain message");
  });
});

// mt#3243 — the conversation is the durable entity; the child process is not.
describe("createDrivenSessionDriver — resume across a restart", () => {
  test("wires the persistence observers, so the conversation is recorded at all", async () => {
    // Before this, the session driver passed NO observers — driven_sessions had zero
    // rows for the channel, so there was never anything to resume FROM.
    const stateChanges: string[] = [];
    const { sessionDriver, calls } = makeSessionDriver({
      onStateChange: (record) => stateChanges.push(record.status),
    });

    void sessionDriver.converse("hello");
    await waitForSpawn(calls, 1);
    await waitForWrite(mustProc(calls), "hello");

    expect(stateChanges.length).toBeGreaterThan(0);
  });

  test("spawns with the fixed channel localId, so one row is upserted for the whole life", async () => {
    const { sessionDriver, registry } = makeSessionDriver();

    void sessionDriver.converse("hello");
    await waitUntil(
      () => registry.get(PRINCIPAL_CHANNEL_LOCAL_ID) !== undefined,
      "the standing conversation to be registered under the fixed id"
    );

    expect(registry.get(PRINCIPAL_CHANNEL_LOCAL_ID)).toBeDefined();
  });

  test("RESUMES a persisted conversation instead of spawning a blank one", async () => {
    const resumed = buildResumedRecord();
    const { sessionDriver, calls } = makeSessionDriver({
      orchestrateResume: async () => ({ outcome: "resumed", record: resumed }),
    });

    void sessionDriver.converse("what were we discussing?");
    await waitUntil(
      () => (resumed.proc as unknown as FakeClaudeProcess).written.length > 0,
      "input written to the RESUMED child"
    );

    // The whole point: no fresh spawn happened.
    expect(calls.length).toBe(0);
  });

  test("falls back to a fresh spawn when there is nothing to resume", async () => {
    const { sessionDriver, calls } = makeSessionDriver({
      orchestrateResume: async () => ({ outcome: "not-found" }),
    });

    void sessionDriver.converse("hello");
    await waitForSpawn(calls, 1);
    await waitForWrite(mustProc(calls), "hello");

    expect(calls.length).toBe(1);
  });

  test("an unrecoverable persisted row also falls back rather than failing the message", async () => {
    const { sessionDriver, calls } = makeSessionDriver({
      orchestrateResume: async () => ({
        outcome: "unrecoverable",
        reason: "spawn-died-before-init",
      }),
    });

    void sessionDriver.converse("hello");
    await waitForSpawn(calls, 1);
    await waitForWrite(mustProc(calls), "hello");

    expect(calls.length).toBe(1);
  });

  test("a LOCKED resume does not spawn a second session driver for the same conversation", async () => {
    // The cross-process advisory lock exists because two `claude --resume` on
    // one conversation silently fork its transcript DAG. Spawning a fresh
    // child here would sidestep the lock and produce exactly that.
    const { sessionDriver, calls } = makeSessionDriver({
      orchestrateResume: async () => ({ outcome: "locked" }),
    });

    await expect(sessionDriver.converse("hello")).rejects.toThrow(/another/i);
    expect(calls.length).toBe(0);
  });

  // PR #2352 R1: the reviewer asked whether spawning with null bindings could
  // silently DETACH a task-bound conversation on a failed resume. It cannot —
  // the channel is untasked by construction, not incidentally. This test makes
  // that an enforced invariant rather than a property of the current wiring, so
  // adding a task binding later has to be a deliberate change with a failing
  // test in front of it.
  test("the channel conversation is untasked BY DESIGN, not incidentally", async () => {
    const { sessionDriver, registry } = makeSessionDriver();

    void sessionDriver.converse("hello");
    await waitUntil(
      () => registry.get(PRINCIPAL_CHANNEL_LOCAL_ID) !== undefined,
      "the standing conversation to be registered"
    );

    const record = registry.get(PRINCIPAL_CHANNEL_LOCAL_ID);
    // The principal's standing conversation is not a task's workspace: it is
    // the counterpart on their phone, and binding it to whichever task happened
    // to be open would mis-attribute its cost rows and substrate links.
    expect(record?.taskId).toBeNull();
    expect(record?.minskySessionId).toBeNull();
  });
});

describe("createDrivenSessionDriver — readiness (mt#3234)", () => {
  test("a conversation that never starts is reported, not silently swallowed", async () => {
    // The live incident: the child spawned, never emitted init, and every
    // message routed into it vanished for twenty minutes.
    const { sessionDriver } = makeSessionDriver({ neverReady: true, readyTimeoutMs: 100 });

    await expect(sessionDriver.converse(BLOCKED_Q)).rejects.toThrow(/did not finish starting/);
  });

  test("a failed start is abandoned, so the NEXT message spawns fresh", async () => {
    // Otherwise the dead session is reused forever and the channel never
    // recovers on its own.
    const { sessionDriver, calls } = makeSessionDriver({ neverReady: true, readyTimeoutMs: 100 });

    await expect(sessionDriver.converse("first")).rejects.toThrow();
    await expect(sessionDriver.converse("second")).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  test("input is written BEFORE readiness — the write is what causes init", async () => {
    // The inverse of what mt#3234 asserted, and the reason it deadlocked
    // (mt#3238): `claude -p --input-format stream-json` emits `init` only after
    // it receives input, so gating the write on init means neither ever
    // happens. Measured live: input withheld -> no init, ever; input written
    // -> init at 3006ms.
    const { sessionDriver, calls } = makeSessionDriver({ neverReady: true, readyTimeoutMs: 200 });
    const pending = sessionDriver.converse(BLOCKED_Q);

    await waitForSpawn(calls, 1);
    const spawned = calls[0]?.proc as FakeClaudeProcess;
    // The write lands even though this child will never report ready.
    expect(await waitForWrite(spawned)).toContain(BLOCKED_Q);

    // Readiness is still verified — after the write — so a child that never
    // comes up is abandoned rather than swallowing every future message.
    await expect(pending).rejects.toThrow(/did not finish starting/);
  });

  test("a ready conversation is reused without waiting again", async () => {
    const { sessionDriver, calls } = makeSessionDriver();

    const first = sessionDriver.converse("one");
    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);
    calls[0]?.proc.finishTurn("a");
    await first;

    const second = sessionDriver.converse("two");
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess, "two");
    calls[0]?.proc.finishTurn("b");
    expect(await second).toBe("b");
    expect(calls).toHaveLength(1);
  });

  test("concurrent callers share one conversation AND one result — documented, not supported", async () => {
    // Pins the concurrency contract in the module header (PR #2330 R1): a
    // standing conversation is a single sequential turn-taker. Overlapping
    // callers subscribe to the same stream, so both resolve on the first
    // `result` and the second receives the first's answer. Per-caller
    // correlation would need the child to tag results with their input, which
    // stream-json does not do. The poller upholds the contract by handling
    // messages strictly sequentially; this test exists so the limitation is
    // explicit rather than discovered.
    const { sessionDriver, calls } = makeSessionDriver();

    const a = sessionDriver.converse("one");
    const b = sessionDriver.converse("two");
    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);

    expect(calls).toHaveLength(1);
    calls[0]?.proc.finishTurn("first answer");
    expect(await a).toBe("first answer");
    expect(await b).toBe("first answer");
  });
});

describe("awaitSessionReady outcomes (PR #2330 R1)", () => {
  test("a child that exits before init is reported as exited, not as a timeout", async () => {
    // Different remedies: a crash points at the spawn (binary, cwd, flags), a
    // timeout at startup cost. Collapsing both sends whoever reads it on a
    // phone looking in the wrong place.
    const { sessionDriver, calls } = makeSessionDriver({ neverReady: true, readyTimeoutMs: 5000 });
    const pending = sessionDriver.converse(BLOCKED_Q);

    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);
    calls[0]?.proc.exit(1);

    await expect(pending).rejects.toThrow(/exited before it finished starting/);
  });

  test("a child that stays silent is reported as a timeout", async () => {
    const { sessionDriver } = makeSessionDriver({ neverReady: true, readyTimeoutMs: 100 });
    await expect(sessionDriver.converse(BLOCKED_Q)).rejects.toThrow(
      /did not finish starting within/
    );
  });
});

/**
 * Per-topic session driver registry (mt#3505, parent mt#3500).
 *
 * Phase 1 generalizes the channel from one standing conversation to one
 * conversation PER TOPIC while preserving the module's own "one caller at a
 * time" contract per conversation. `createDrivenSessionDriver` already
 * parametrizes over `localId` (originally added so a live probe would not
 * collide with the running channel's own row); this registry is what lets
 * the launch-time composition root reuse ONE session driver instance per topic
 * across calls, rather than constructing a fresh closure (and therefore a
 * fresh `standingLocalId`/in-flight guard) on every message — which would
 * silently break the "concurrent callers share one conversation" guarantee
 * for a topic that receives two messages back to back.
 */
describe("createTopicDriverRegistry (mt#3505)", () => {
  test("returns the SAME instance for the same localId across calls", () => {
    const registry = createTopicDriverRegistry();
    let factoryCalls = 0;
    const factory = (): ChannelDriver => {
      factoryCalls += 1;
      return {
        converse: async (text) => text,
        interrupt: async () => "stopped",
        reset: async () => "fresh",
        answerAsk: async () => "answered",
      };
    };

    const first = registry.getOrCreate("entity-thread:telegram-topic:1:100", factory);
    const second = registry.getOrCreate("entity-thread:telegram-topic:1:100", factory);

    expect(second).toBe(first);
    expect(factoryCalls).toBe(1);
  });

  test("returns DIFFERENT instances for different localIds", () => {
    const registry = createTopicDriverRegistry();
    const makeStub = (): ChannelDriver => ({
      converse: async (text) => text,
      interrupt: async () => "stopped",
      reset: async () => "fresh",
      answerAsk: async () => "answered",
    });

    const a = registry.getOrCreate("telegram-topic:1:100", makeStub);
    const b = registry.getOrCreate("telegram-topic:1:200", makeStub);

    expect(a).not.toBe(b);
  });

  test("get() returns undefined for a localId never created", () => {
    const registry = createTopicDriverRegistry();
    expect(registry.get("telegram-topic:1:999")).toBeUndefined();
  });

  test("get() returns the cached instance after getOrCreate", () => {
    const registry = createTopicDriverRegistry();
    const localId = ["telegram-topic", "1", "100"].join(":");
    const created = registry.getOrCreate(localId, () => ({
      converse: async (text) => text,
      interrupt: async () => "stopped",
      reset: async () => "fresh",
      answerAsk: async () => "answered",
    }));
    expect(registry.get(localId)).toBe(created);
  });
});

/**
 * The streamed-partials extractor (mt#3542).
 *
 * The whole streaming feature rests on reading ONE event shape correctly, so
 * these pin the shape rather than the plumbing: a wrong `type` check here means
 * the placeholder silently never updates, with nothing failing anywhere.
 */
describe("partialAssistantText", () => {
  const BLOCK_DELTA = "content_block_delta";

  function delta(kind: string, body: Record<string, unknown>): Record<string, unknown> {
    return { type: "stream_event", event: { type: kind, index: 0, delta: body } };
  }

  test("reads the text out of a content_block_delta", () => {
    expect(partialAssistantText(delta(BLOCK_DELTA, { type: "text_delta", text: "Hel" }))).toBe(
      "Hel"
    );
  });

  test("ignores thinking and tool-call deltas", () => {
    // Out of scope for v1 (mt#3542 §Out of scope) — and streaming a tool call's
    // half-built JSON into a chat reply would be noise, not progress.
    expect(
      partialAssistantText(delta(BLOCK_DELTA, { type: "thinking_delta", thinking: "hm" }))
    ).toBeNull();
    expect(
      partialAssistantText(delta(BLOCK_DELTA, { type: "input_json_delta", partial_json: '{"a' }))
    ).toBeNull();
  });

  test("ignores non-stream_event payloads and other sub-events", () => {
    expect(partialAssistantText({ type: "result", result: "done" })).toBeNull();
    expect(partialAssistantText({ type: "assistant", message: {} })).toBeNull();
    expect(partialAssistantText(delta("content_block_start", {}))).toBeNull();
  });

  test("tolerates malformed frames rather than throwing", () => {
    // These come off a subprocess's stdout — the parser must not be the thing
    // that kills a turn.
    expect(partialAssistantText({ type: "stream_event" })).toBeNull();
    expect(partialAssistantText({ type: "stream_event", event: null })).toBeNull();
    expect(partialAssistantText({ type: "stream_event", event: { type: BLOCK_DELTA } })).toBeNull();
    expect(partialAssistantText(delta(BLOCK_DELTA, { type: "text_delta" }))).toBeNull();
    expect(partialAssistantText(delta(BLOCK_DELTA, { type: "text_delta", text: 42 }))).toBeNull();
  });

  test("treats an empty text delta as nothing to report", () => {
    expect(partialAssistantText(delta(BLOCK_DELTA, { type: "text_delta", text: "" }))).toBeNull();
  });
});

// PR #2452 R1 (non-blocking): remove the per-run temp dir so repeated runs do
// not accumulate orphaned directories under the system temp root.
afterAll(() => {
  rmSync(CWD, { recursive: true, force: true });
});
