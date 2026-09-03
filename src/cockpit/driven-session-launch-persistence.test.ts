/**
 * Tests for the durable driven-session persistence additions to
 * driven-session-launch.ts (mt#3038, RFC "Conversation-first drive" Phase
 * 1): createDrivenSessionPersistObserver, loadPersistedDrivenSessions,
 * orchestrateDrivenSessionResume.
 *
 * CRITICAL TESTING CONSTRAINT (inherited from ./driven-session-host.ts's
 * docblock): resume orchestration tests inject a fake `spawnFn` — no test
 * spawns the real `claude` binary.
 *
 * @see ./driven-session-launch.ts
 * @see mt#3038
 */

/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: the boot classifier and resume orchestration probe the REAL filesystem to decide whether a workspace still exists, so a row's cwd fixture has to be a real directory — there is no fs to inject through the code path under test. A per-run mkdtemp dir keeps the "fixed mock path" race the rule guards against from applying. */
import { describe, test, expect, afterAll } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";

import {
  createDrivenSessionPersistObserver,
  describeReconciliationOutcome,
  getBootReconciliationDb,
  loadPersistedDrivenSessions,
  orchestrateDrivenSessionResume,
  orchestrateDrivenSessionAttach,
  reconcilePersistedDrivenSessions,
  type OrchestrateDrivenSessionAttachDeps,
  type ReconciliationOutcome,
} from "./driven-session-launch";
import { getContextInspectorDb } from "./db-providers";
import { DrivenSessionRegistry, startDrivenSession, type ProcessLike } from "./driven-session-host";
import type { DrivenSessionRow } from "@minsky/domain/storage/schemas/driven-sessions-schema";

// ---------------------------------------------------------------------------
// Fake process double (mirrors driven-session-host.test.ts's FakeClaudeProcess)
// ---------------------------------------------------------------------------

class FakeClaudeProcess extends EventEmitter implements ProcessLike {
  readonly pid: number | undefined = 999999;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  kill(): boolean {
    return true;
  }
}

const FAKE_DB = {
  __marker: "fake-db",
} as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;

// mt#3397 — a resumable row's cwd must be a REAL directory: the boot classifier
// and the resume orchestration both probe it, and a made-up path now (correctly)
// classifies the row unrecoverable. MISSING_CWD is the never-created sibling
// used by the tests that assert that classification.
const TEST_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "driven-session-launch-"));
const MISSING_CWD = join(TEST_WORKSPACE_ROOT, "deleted-workspace");

const BASE_ROW: DrivenSessionRow = {
  localId: "local-1",
  harnessSessionId: "harness-1",
  harnessKind: "claude-code",
  transportId: "claude-stream-json",
  harnessConversationId: "harness-1",
  authMode: "subscription",
  cwd: TEST_WORKSPACE_ROOT,
  permissionMode: "bypassPermissions",
  taskId: "mt#3038",
  minskySessionId: "session-1",
  status: "reconnecting",
  unrecoverableReason: null,
  pid: null,
  pidCmdline: null,
  model: null,
  driverGeneration: 0,
  startedAt: new Date("2026-07-22T18:00:00.000Z"),
  updatedAt: new Date("2026-07-22T18:05:00.000Z"),
};

describe("createDrivenSessionPersistObserver", () => {
  test("upserts a row mapping every field from the in-memory record", async () => {
    const upsertCalls: unknown[] = [];
    const observer = createDrivenSessionPersistObserver({
      getDb: async () => FAKE_DB,
      upsert: async (_db, input) => {
        upsertCalls.push(input);
        return "written";
      },
    });

    const { record } = startDrivenSession({
      cwd: TEST_WORKSPACE_ROOT,
      spawnFn: () => new FakeClaudeProcess(),
    });

    observer(record);
    // Fire-and-forget — allow the microtask queue to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upsertCalls.length).toBe(1);
    const call = upsertCalls[0] as Record<string, unknown>;
    expect(call.localId).toBe(record.localId);
    expect(call.cwd).toBe(TEST_WORKSPACE_ROOT);
    expect(call.status).toBe("spawned");
    expect(call.pidCmdline).toContain("claude");
    // mt#4935 — the harness-agnostic fields persist off the live record,
    // never a silently re-derived default.
    expect(call.harnessKind).toBe("claude-code");
    expect(call.transportId).toBe("claude-stream-json");
    expect(call.authMode).toBe("subscription");
  });

  // mt#3040 preservation (interaction fix) — the model isn't a separate
  // DrivenSessionRecord field; it's recovered from argv for persistence.
  test("extracts model from argv (mt#3040) for the persisted row", async () => {
    const upsertCalls: unknown[] = [];
    const observer = createDrivenSessionPersistObserver({
      getDb: async () => FAKE_DB,
      upsert: async (_db, input) => {
        upsertCalls.push(input);
        return "written";
      },
    });
    startDrivenSession({
      cwd: TEST_WORKSPACE_ROOT,
      model: "fable",
      spawnFn: () => new FakeClaudeProcess(),
      onStateChange: observer,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upsertCalls.length).toBe(1);
    expect((upsertCalls[0] as Record<string, unknown>).model).toBe("fable");
  });

  test("persists a null model when none was selected", async () => {
    const upsertCalls: unknown[] = [];
    const observer = createDrivenSessionPersistObserver({
      getDb: async () => FAKE_DB,
      upsert: async (_db, input) => {
        upsertCalls.push(input);
        return "written";
      },
    });
    startDrivenSession({
      cwd: TEST_WORKSPACE_ROOT,
      spawnFn: () => new FakeClaudeProcess(),
      onStateChange: observer,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((upsertCalls[0] as Record<string, unknown>).model).toBeNull();
  });

  test("logs and no-ops (never throws) when persistence is unavailable", async () => {
    const observer = createDrivenSessionPersistObserver({ getDb: async () => null });
    const { record } = startDrivenSession({
      cwd: TEST_WORKSPACE_ROOT,
      spawnFn: () => new FakeClaudeProcess(),
    });
    expect(() => observer(record)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("swallows an upsert failure without throwing", async () => {
    const observer = createDrivenSessionPersistObserver({
      getDb: async () => FAKE_DB,
      upsert: async () => {
        throw new Error("simulated write failure");
      },
    });
    const { record } = startDrivenSession({
      cwd: TEST_WORKSPACE_ROOT,
      spawnFn: () => new FakeClaudeProcess(),
    });
    expect(() => observer(record)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

/**
 * mt#4103 — every boot says what happened, and no await runs unbounded.
 *
 * On 2026-08-12 two of ten daemon boots produced NONE of the four outcomes
 * this function could log. The registry stayed empty for those daemons' whole
 * lives, which is what let an entity thread silently swap its agent (mt#4093).
 * The function is fire-and-forget, so an await that never settles does not
 * fail — it just never finishes, and every log line stays unwritten.
 */
/** An operation that never settles — the stall being simulated. */
const neverSettles = <T>(): Promise<T> => new Promise<T>(() => {});

/**
 * A timeout signal that trips the Nth race and NEVER trips any other.
 *
 * A signal that fires immediately on every race is useless here: the stages
 * run in sequence against one shared seam, so it would always trip
 * `resolve-db` and no later stage could ever be reached. Counting races
 * instead lets a test name the exact await it is stalling — race 1 is
 * `resolve-db`, race 2 is `list-rows`, then PER ROW: the cwd probe, then the
 * session driver probe when the row is resumable and carries a pid (mt#4255), then a
 * verdict write when one is owed.
 *
 * Deterministic and instant in both directions: the tripped race resolves on
 * a microtask, and the others never resolve, so the real operation wins them
 * without any wall-clock wait.
 *
 * Module-scoped (mt#4255) rather than local to the mt#4103 block: the
 * session driver-retirement tests below stall the same seam, and a second copy would
 * be a second thing to keep in step with the race ordering above.
 */
function tripRace(n: number): (ms: number) => Promise<{ timedOut: true }> {
  let races = 0;
  return () => {
    races += 1;
    return races === n
      ? Promise.resolve({ timedOut: true } as const)
      : neverSettles<{ timedOut: true }>();
  };
}

describe("boot reconciliation observability + bounds (mt#4103)", () => {
  describe("describeReconciliationOutcome", () => {
    test("a clean load reports the count at info", () => {
      const { level, message } = describeReconciliationOutcome({
        kind: "loaded",
        count: 20,
        retired: 0,
        degraded: [],
      });
      expect(level).toBe("info");
      expect(message).toContain("loaded 20 persisted session(s)");
      // Retiring nothing is the ordinary case, so the line must read exactly as
      // it did before mt#4255 added the clause.
      expect(message).not.toContain("retired");
    });

    test("SC7 — a load that retired rows says so in the same line", () => {
      // The counter is only worth having if an operator sees it. A boot that
      // silently retires rows and reports a shrinking `count` looks like rows
      // going missing.
      const { level, message } = describeReconciliationOutcome({
        kind: "loaded",
        count: 2,
        retired: 23,
        degraded: [],
      });
      expect(level).toBe("info");
      expect(message).toContain("loaded 2 persisted session(s)");
      expect(message).toContain("retired 23 whose recorded session driver was gone");
    });

    test("SC7 — retiring EVERY row is a loaded line, not the empty line", () => {
      // `count: 0` here means "there were rows and they are all retired", which
      // is a different fact from `empty`'s "there were no rows". Collapsing them
      // is the mt#4103 defect, one layer down.
      const { message } = describeReconciliationOutcome({
        kind: "loaded",
        count: 0,
        retired: 4,
        degraded: [],
      });
      expect(message).toContain("loaded 0 persisted session(s)");
      expect(message).toContain("retired 4");
      expect(message).not.toContain("no non-terminal sessions to load");
    });

    test("ZERO rows is its own line, not silence", () => {
      // The whole defect in one assertion. Before this, `rows.length === 0`
      // logged nothing, so "nothing to load" and "never finished" were the
      // same observation — and the incident could only be found by noticing an
      // absence across ten boots.
      const { level, message } = describeReconciliationOutcome({ kind: "empty" });
      expect(level).toBe("info");
      expect(message).toContain("no non-terminal sessions to load");
      expect(message).toContain("registry starts empty");
    });

    test("a load with degraded rows warns and names the stages, deduped", () => {
      const { level, message } = describeReconciliationOutcome({
        kind: "loaded",
        count: 5,
        retired: 0,
        degraded: ["cwd-probe", "cwd-probe", "persist-verdict"],
      });
      // WARN, not info: the count alone would read as a clean load while the
      // registry is actually incomplete.
      expect(level).toBe("warn");
      expect(message).toContain("3 row(s) degraded");
      // Deduped — three degradations across two stages names two stages.
      expect(message).toContain("cwd-probe, persist-verdict");
    });

    test("a stall names the STAGE and the bound, not just 'timed out'", () => {
      const { level, message } = describeReconciliationOutcome({
        kind: "timed-out",
        stage: "cwd-probe",
        timeoutMs: 2000,
      });
      expect(level).toBe("warn");
      // The stage is the diagnostic: `resolve-db` points at the pool,
      // `cwd-probe` at a wedged filesystem path. "Reconciliation timed out"
      // would send an operator looking in the wrong place.
      expect(message).toContain('stage "cwd-probe"');
      expect(message).toContain("2000ms");
      expect(message).toContain("registry starts empty");
    });

    test("every outcome kind produces a line — none is silent", () => {
      // The guarantee the caller depends on: it calls `log[level](message)`
      // unconditionally, so a kind that produced an empty message would be a
      // silent boot again.
      const everyKind: ReconciliationOutcome[] = [
        { kind: "loaded", count: 1, retired: 0, degraded: [] },
        // The retiring variant is its own entry: it takes a different branch
        // inside the `loaded` case, so the no-silent-kind guarantee has to
        // cover it too (mt#4255).
        { kind: "loaded", count: 0, retired: 1, degraded: ["sessionDriver-probe"] },
        { kind: "empty" },
        { kind: "no-persistence" },
        { kind: "timed-out", stage: "list-rows", timeoutMs: 15000 },
        { kind: "failed", message: "connection refused" },
      ];
      for (const outcome of everyKind) {
        const { level, message } = describeReconciliationOutcome(outcome);
        expect(message.length).toBeGreaterThan(0);
        expect(["info", "warn"]).toContain(level);
      }
    });
  });

  test("AT1 — a handle that never resolves settles as a resolve-db stall", async () => {
    const outcome = await reconcilePersistedDrivenSessions({
      getDb: () => neverSettles(),
      timeoutSignal: tripRace(1),
      stageTimeoutMs: 15_000,
    });
    expect(outcome).toEqual({ kind: "timed-out", stage: "resolve-db", timeoutMs: 15_000 });
  });

  test("a SELECT that never resolves settles as a list-rows stall", async () => {
    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: () => neverSettles(),
      timeoutSignal: tripRace(2),
      stageTimeoutMs: 15_000,
    });
    expect(outcome).toEqual({ kind: "timed-out", stage: "list-rows", timeoutMs: 15_000 });
  });

  test("AT2 — zero rows is reported as `empty`, distinct from a stall", async () => {
    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [],
      registry: new DrivenSessionRegistry(),
    });
    // Distinct KIND, not a zero-count load — the two produce different lines.
    expect(outcome).toEqual({ kind: "empty" });
  });

  test("AT4 — one wedged cwd probe degrades that row, not the run", async () => {
    const registry = new DrivenSessionRegistry();
    const WEDGED_CWD = join(TEST_WORKSPACE_ROOT, "on-a-hung-mount");
    const rowA: DrivenSessionRow = { ...BASE_ROW, localId: "wedged", cwd: WEDGED_CWD };
    const rowB: DrivenSessionRow = { ...BASE_ROW, localId: "healthy" };

    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [rowA, rowB],
      registry,
      // The wedged mount: only THIS row's `stat` never answers. The other row
      // probes normally, which is what makes the assertion below meaningful —
      // a run that stalled everything would also "still register both" if the
      // loop simply skipped the probe.
      probeCwd: async (cwd: string) =>
        cwd === WEDGED_CWD ? await neverSettles<"present">() : "present",
      // Race 1 is resolve-db, race 2 is list-rows, race 3 is the FIRST row's
      // cwd probe — so only that one row is stalled. The second row's probe
      // (race 4) gets a never-tripping signal, and would resolve normally if
      // its probe answered.
      timeoutSignal: tripRace(3),
      rowTimeoutMs: 2_000,
    });

    // The run still completed, and BOTH rows are in the registry — one wedged
    // workspace path must not cost the whole reconciliation, which is the
    // failure mode that leaves a thread with no record to resume from.
    expect(outcome.kind).toBe("loaded");
    if (outcome.kind === "loaded") {
      expect(outcome.count).toBe(2);
      expect(outcome.degraded).toContain("cwd-probe");
    }
    expect(registry.get("wedged")).toBeDefined();
    expect(registry.get("healthy")).toBeDefined();
    // Failing OPEN: a probe that could not answer must not retire the
    // conversation. `unknown` is the same verdict a permission/IO error gives.
    expect(registry.get("wedged")?.status).toBe("reconnecting");
  });

  test("a thrown error is reported, not swallowed into a silent zero", async () => {
    const thrown = "connection refused";
    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => {
        throw new Error(thrown);
      },
    });
    expect(outcome).toEqual({ kind: "failed", message: thrown });
  });

  test("AT3 — boot reconciliation does NOT borrow the latching shared getter", async () => {
    // The wiring assertion. `getContextInspectorDb` caches a null probe for the
    // process lifetime, so a DB blip at boot would disable reconciliation for
    // the daemon's whole life — the exact condition present on 2026-08-12.
    // `cacheNegative: false`'s retry-until-success behavior is covered by
    // db-providers.test.ts; what THIS pins is that this caller uses its own
    // handle rather than the shared one.
    expect(getBootReconciliationDb).not.toBe(getContextInspectorDb);
  });

  test("the loader reports 0 for every non-loaded outcome", async () => {
    // `loadPersistedDrivenSessions` returns a count, and a stall must not be
    // reported as a successful zero-row load to its caller either.
    const stalled = await loadPersistedDrivenSessions({
      getDb: () => neverSettles(),
      timeoutSignal: tripRace(1),
    });
    expect(stalled).toBe(0);

    const loaded = await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [BASE_ROW],
      registry: new DrivenSessionRegistry(),
    });
    expect(loaded).toBe(1);
  });
});

describe("loadPersistedDrivenSessions", () => {
  test("registers a resumable row as 'reconnecting'", async () => {
    const registry = new DrivenSessionRegistry();
    const count = await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [BASE_ROW],
      registry,
    });
    expect(count).toBe(1);
    const record = registry.get("local-1");
    expect(record?.status).toBe("reconnecting");
    expect(record?.harnessSessionId).toBe("harness-1");
  });

  test("registers a never-linked row as 'unrecoverable'", async () => {
    const registry = new DrivenSessionRegistry();
    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [{ ...BASE_ROW, harnessSessionId: null }],
      registry,
    });
    const record = registry.get("local-1");
    expect(record?.status).toBe("unrecoverable");
    expect(record?.unrecoverableReason).toContain("spawn-died-before-init");
  });

  test("returns 0 without throwing when persistence is unavailable", async () => {
    const registry = new DrivenSessionRegistry();
    const count = await loadPersistedDrivenSessions({ getDb: async () => null, registry });
    expect(count).toBe(0);
  });

  test("returns 0 without throwing when the query fails", async () => {
    const registry = new DrivenSessionRegistry();
    const count = await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => {
        throw new Error("simulated query failure");
      },
      registry,
    });
    expect(count).toBe(0);
  });

  // mt#3269: the verdict above was computed in memory and thrown away, so a row
  // that can NEVER be resumed was re-classified from scratch at every boot and
  // re-registered forever. Persisting it is what makes the next boot skip it.
  test("PERSISTS the unrecoverable verdict so the next boot does not re-read the row", async () => {
    const registry = new DrivenSessionRegistry();
    const persisted: { localId: string; status: string; reason: string | null }[] = [];

    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [{ ...BASE_ROW, harnessSessionId: null }],
      registry,
      persistTerminalVerdict: async (_db, input) => {
        persisted.push({
          localId: input.localId,
          status: input.status,
          reason: input.unrecoverableReason ?? null,
        });
        return "written";
      },
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe("unrecoverable");
    expect(persisted[0]?.reason).toContain("spawn-died-before-init");
  });

  // PR #2383 R1 (BLOCKING): the store upserts with `onConflictDoUpdate({ set: values })`,
  // so any field this write defaults instead of carrying through OVERWRITES the
  // stored one. The first draft passed `model: null` and silently destroyed it.
  test("preserves every other persisted field — it records a verdict, not a rewrite", async () => {
    const registry = new DrivenSessionRegistry();
    const row = {
      ...BASE_ROW,
      harnessSessionId: null,
      model: "fable",
      pid: 4242,
      pidCmdline: "claude -p --input-format stream-json",
      driverGeneration: 3,
    };
    const writes: Record<string, unknown>[] = [];

    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [row],
      registry,
      persistTerminalVerdict: async (_db, input) => {
        writes.push(input as unknown as Record<string, unknown>);
        return "written";
      },
    });

    const written = writes[0];
    if (!written) throw new Error("expected exactly one verdict write");
    expect(written["model"]).toBe("fable");
    expect(written["pid"]).toBe(4242);
    expect(written["pidCmdline"]).toBe("claude -p --input-format stream-json");
    expect(written["driverGeneration"]).toBe(3);
    expect(written["cwd"]).toBe(row.cwd);
    // ...while the two fields the write exists to change did change.
    expect(written["status"]).toBe("unrecoverable");
  });

  test("does NOT persist a verdict for a resumable row — it stays available to resume", async () => {
    // The deliberate carve-out (spec §Scope): deciding when a RESUMABLE row is
    // too stale to keep offering is a policy question this task does not answer.
    const registry = new DrivenSessionRegistry();
    const persisted: string[] = [];

    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [BASE_ROW],
      registry,
      persistTerminalVerdict: async (_db, input) => {
        persisted.push(input.localId);
        return "written";
      },
    });

    expect(persisted).toHaveLength(0);
    expect(registry.get("local-1")?.status).toBe("reconnecting");
  });

  test("is idempotent across boots: the second boot reads nothing for a persisted row", async () => {
    // Simulates the real database: the query excludes terminal statuses, so once
    // the verdict is written the row drops out of the next boot's result set.
    const rows = [{ ...BASE_ROW, harnessSessionId: null }];
    const terminal = new Set<string>();

    const boot = () =>
      loadPersistedDrivenSessions({
        getDb: async () => FAKE_DB,
        listNonTerminal: async () => rows.filter((r) => !terminal.has(r.localId)),
        registry: new DrivenSessionRegistry(),
        persistTerminalVerdict: async (_db, input) => {
          terminal.add(input.localId);
          return "written";
        },
      });

    expect(await boot()).toBe(1);
    expect(await boot()).toBe(0);
  });

  test("a failed verdict-persist does not break boot", async () => {
    // Boot reconciliation is best-effort by construction — a persistence hiccup
    // must not stop the daemon from registering what it did read.
    const registry = new DrivenSessionRegistry();
    const count = await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [{ ...BASE_ROW, harnessSessionId: null }],
      registry,
      persistTerminalVerdict: async () => {
        throw new Error("simulated upsert failure");
      },
    });

    expect(count).toBe(1);
    expect(registry.get("local-1")?.status).toBe("unrecoverable");
  });
});

describe("orchestrateDrivenSessionResume", () => {
  test("returns not-found when persistence is unavailable", async () => {
    const outcome = await orchestrateDrivenSessionResume("local-1", { getDb: async () => null });
    expect(outcome).toEqual({ outcome: "not-found" });
  });

  test("returns not-found when no persisted row exists", async () => {
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => null,
    });
    expect(outcome).toEqual({ outcome: "not-found" });
  });

  test("returns unrecoverable when the row never linked a harness session id", async () => {
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({ ...BASE_ROW, harnessSessionId: null }),
    });
    expect(outcome.outcome).toBe("unrecoverable");
    // mt#4093: nothing to name. A caller that has to tell the operator WHICH
    // conversation it is replacing must be able to tell this case apart from
    // the one below — here there is no earlier exchange to have lost.
    if (outcome.outcome === "unrecoverable") {
      expect(outcome.harnessSessionId).toBeUndefined();
    }
  });

  test("returns unrecoverable when the row is already marked unrecoverable", async () => {
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({
        ...BASE_ROW,
        status: "unrecoverable",
        unrecoverableReason: "deleted cwd",
      }),
    });
    // mt#4093 added `harnessSessionId` — the conversation that cannot be
    // resumed. It is carried HERE because this is the last layer that can see
    // it: the caller's fresh spawn upserts `driven_sessions` on this localId
    // and overwrites the column.
    expect(outcome).toEqual({
      outcome: "unrecoverable",
      reason: "deleted cwd",
      harnessSessionId: "harness-1",
    });
  });

  test("returns locked when another process already holds the resume lock", async () => {
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => BASE_ROW,
      withResumeLock: async () => ({ acquired: false }),
    });
    expect(outcome).toEqual({ outcome: "locked" });
  });

  test("resumes and returns the new record when the lock is acquired", async () => {
    const registry = new DrivenSessionRegistry();
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => BASE_ROW,
      withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
      registry,
      spawnFn: () => new FakeClaudeProcess(),
    });
    expect(outcome.outcome).toBe("resumed");
    if (outcome.outcome === "resumed") {
      expect(outcome.record.localId).toBe("local-1");
      expect(outcome.record.harnessSessionId).toBe("harness-1");
      expect(outcome.record.driverGeneration).toBe(1);
      expect(registry.get("local-1")).toBe(outcome.record);
    }
  });

  // Reviewer round 1 (PR #2179) BLOCKING finding — R1 delta #4's orphan-PID
  // cleanup was implemented (process-identity.ts) but never WIRED into the
  // resume path. Fixed: orchestrateDrivenSessionResume calls it, inside the
  // lock, before resumeDrivenSession.
  test("calls the orphan-cleanup kill for the persisted pid before resuming", async () => {
    const registry = new DrivenSessionRegistry();
    const killCalls: unknown[] = [];
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({ ...BASE_ROW, pid: 42424 }),
      withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
      registry,
      spawnFn: () => new FakeClaudeProcess(),
      killOrphan: async (pid, expectedCmdSubstring, signal) => {
        killCalls.push({ pid, expectedCmdSubstring, signal });
        return true;
      },
    });
    expect(outcome.outcome).toBe("resumed");
    expect(killCalls).toEqual([{ pid: 42424, expectedCmdSubstring: "claude", signal: "SIGKILL" }]);
  });

  // Reviewer round 2 (PR #2179) non-blocking — prefer the persisted full
  // command line (a stricter identity check) over the bare binary name.
  test("prefers the persisted pidCmdline over the bare binary name for identity", async () => {
    const registry = new DrivenSessionRegistry();
    const killCalls: unknown[] = [];
    await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({
        ...BASE_ROW,
        pid: 42424,
        pidCmdline: "claude -p --resume harness-1 --dangerously-skip-permissions",
      }),
      withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
      registry,
      spawnFn: () => new FakeClaudeProcess(),
      killOrphan: async (pid, expectedCmdSubstring, signal) => {
        killCalls.push({ pid, expectedCmdSubstring, signal });
        return true;
      },
    });
    expect(killCalls).toEqual([
      {
        pid: 42424,
        expectedCmdSubstring: "claude -p --resume harness-1 --dangerously-skip-permissions",
        signal: "SIGKILL",
      },
    ]);
  });

  test("skips the orphan-cleanup kill when no pid was persisted", async () => {
    const registry = new DrivenSessionRegistry();
    let killCalled = false;
    await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({ ...BASE_ROW, pid: null }),
      withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
      registry,
      spawnFn: () => new FakeClaudeProcess(),
      killOrphan: async () => {
        killCalled = true;
        return true;
      },
    });
    expect(killCalled).toBe(false);
  });

  test("proceeds with the resume even when the orphan-cleanup kill attempt throws", async () => {
    const registry = new DrivenSessionRegistry();
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({ ...BASE_ROW, pid: 42424 }),
      withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
      registry,
      spawnFn: () => new FakeClaudeProcess(),
      killOrphan: async () => {
        throw new Error("simulated ps failure");
      },
    });
    expect(outcome.outcome).toBe("resumed");
  });
});

// ---------------------------------------------------------------------------
// Deleted-workspace classification (mt#3397)
// ---------------------------------------------------------------------------

describe("deleted workspace cwd (mt#3397)", () => {
  const DELETED_ROW = { ...BASE_ROW, cwd: MISSING_CWD };

  // Acceptance test 3.
  test("boot reconciliation classifies a linked row with a deleted cwd as unrecoverable", async () => {
    const registry = new DrivenSessionRegistry();

    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      // harnessSessionId is NON-null — under the pre-mt#3397 classifier this row
      // was "reconnecting", and every resume of it crashed.
      listNonTerminal: async () => [DELETED_ROW],
      registry,
      persistTerminalVerdict: async () => "written",
    });

    const record = registry.get("local-1");
    expect(record?.status).toBe("unrecoverable");
    expect(record?.unrecoverableReason).toContain(MISSING_CWD);
    expect(record?.unrecoverableReason).toContain("deleted cwd");
  });

  // Acceptance test 2.
  test("boot reconciliation PERSISTS the deleted-cwd verdict so it is not re-derived forever", async () => {
    const persisted: { status: string; reason: string | null }[] = [];

    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [DELETED_ROW],
      registry: new DrivenSessionRegistry(),
      persistTerminalVerdict: async (_db, input) => {
        persisted.push({
          status: input.status,
          reason: input.unrecoverableReason ?? null,
        });
        return "written";
      },
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe("unrecoverable");
    expect(persisted[0]?.reason).toContain(MISSING_CWD);
  });

  test("orchestrateDrivenSessionResume refuses the resume and never spawns", async () => {
    const spawns: string[] = [];

    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => DELETED_ROW,
      persistTerminalVerdict: async () => "written",
      spawnFn: (command) => {
        spawns.push(command);
        return new FakeClaudeProcess();
      },
      registry: new DrivenSessionRegistry(),
    });

    expect(outcome.outcome).toBe("unrecoverable");
    expect(outcome.outcome === "unrecoverable" && outcome.reason).toContain(MISSING_CWD);
    expect(spawns).toHaveLength(0);
  });

  test("orchestrateDrivenSessionResume writes the verdict back, and never takes the resume lock", async () => {
    const persisted: string[] = [];
    let lockTaken = false;

    await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => DELETED_ROW,
      persistTerminalVerdict: async (_db, input) => {
        persisted.push(input.unrecoverableReason ?? "");
        return "written";
      },
      // Refusing BEFORE the lock is the point: a session that cannot come back
      // must not serialize other daemons behind a lock to find that out.
      withResumeLock: async () => {
        lockTaken = true;
        return { acquired: false };
      },
      registry: new DrivenSessionRegistry(),
    });

    expect(lockTaken).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toContain(MISSING_CWD);
  });

  test("a row whose cwd still exists is unaffected — it resumes as before", async () => {
    const spawns: string[] = [];

    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => BASE_ROW,
      withResumeLock: async (_db, _key, fn) => ({ acquired: true, result: await fn() }),
      spawnFn: (command) => {
        spawns.push(command);
        return new FakeClaudeProcess();
      },
      registry: new DrivenSessionRegistry(),
    });

    expect(outcome.outcome).toBe("resumed");
    expect(spawns).toHaveLength(1);
  });
});

/**
 * mt#3095 — attach: putting a session driver on a conversation Minsky did NOT spawn.
 *
 * The behaviour under test is mostly a REFUSAL policy, and its failure mode is
 * silent (a wrong admit forks a transcript with no error), so the refusal cases
 * are covered at least as heavily as the success case. `locateConversation`,
 * `readPresence`, and (mt#4869) `classifyHolder` are injected throughout — no
 * test touches `~/.claude` or a real database, and none spawns the real
 * `claude` binary or a real `ps`.
 */
describe("orchestrateDrivenSessionAttach (mt#3095)", () => {
  const CONVERSATION = "conv-abc-123";
  const LOCATED = { jsonlPath: "/tmp/fake/conv-abc-123.jsonl", cwd: "/tmp/fake-cwd" };
  const NOT_HELD = { liveness: "not_running" as const, holder: null, basis: "test: not held" };

  // Annotated so the seam signatures are contextually typed from the real
  // interface rather than inferred from these literals — an un-annotated fake
  // can drift from the production signature and still pass at runtime, which is
  // exactly what bun test would not have caught here.
  const admitDeps = (): OrchestrateDrivenSessionAttachDeps => ({
    getDb: async () => FAKE_DB,
    locateConversation: async () => LOCATED,
    readPresence: async () => "IDLE",
    classifyHolder: async () => NOT_HELD,
    withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
    registry: new DrivenSessionRegistry(),
    spawnFn: () => new FakeClaudeProcess(),
    newLocalId: () => "sessionDriver-1",
  });

  test("attaches an idle conversation and registers it under BOTH ids", async () => {
    const registry = new DrivenSessionRegistry();
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      registry,
    });

    expect(outcome.outcome).toBe("attached");
    if (outcome.outcome !== "attached") throw new Error("unreachable");
    expect(outcome.record.harnessSessionId).toBe(CONVERSATION);
    expect(outcome.record.cwd).toBe(LOCATED.cwd);
    // SC2: the whole point of passing harnessSessionId up front — the record is
    // addressable by CONVERSATION id with no id-space change anywhere else.
    expect(registry.get(CONVERSATION)).toBe(outcome.record);
    // ...and still by its session driver id, because that is the registry's PK.
    expect(registry.get("sessionDriver-1")).toBe(outcome.record);
  });

  test("an attached foreign conversation carries no task/workspace binding", async () => {
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, admitDeps());
    if (outcome.outcome !== "attached") throw new Error("expected attached");
    // Guessing a binding would mis-attribute this conversation's cost rows and
    // driven_spawn links to a task that never ran the work.
    expect(outcome.record.taskId).toBeNull();
    expect(outcome.record.minskySessionId).toBeNull();
  });

  test("ENDED also attaches — an observed SessionEnd means nothing holds the file", async () => {
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      readPresence: async () => "ENDED" as const,
    });
    expect(outcome.outcome).toBe("attached");
  });

  test.each([
    ["LIVE", "live-writer"],
    ["NEEDS_INPUT", "awaiting-human"],
    ["STALLED", "possibly-wedged"],
    ["UNKNOWN", "no-telemetry"],
  ] as const)("refuses a %s conversation with reason %s", async (presence, reason) => {
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      readPresence: async () => presence,
    });
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toBe(reason);
    expect(outcome.presence).toBe(presence);
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  test("a refusal never spawns a process", async () => {
    let spawned = 0;
    await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      readPresence: async () => "LIVE" as const,
      spawnFn: () => {
        spawned += 1;
        return new FakeClaudeProcess();
      },
    });
    expect(spawned).toBe(0);
  });

  test("a refusal never takes the resume lock — the gate precedes it", async () => {
    let lockTaken = 0;
    await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      readPresence: async () => "LIVE" as const,
      withResumeLock: async (_db, _c, fn) => {
        lockTaken += 1;
        return { acquired: true, result: await fn() };
      },
    });
    expect(lockTaken).toBe(0);
  });

  // The DB is where presence telemetry lives, so losing it means losing the
  // ability to tell whether anything is writing. Failing OPEN here would let a
  // transient outage license exactly the fork this path exists to prevent.
  test("no database refuses as no-telemetry rather than attaching", async () => {
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      getDb: async () => null,
    });
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toBe("no-telemetry");
  });

  // PR #2466 R1 — ordering. Which answer a caller gets for an unknown id must
  // not depend on database availability: "no such conversation" is a different
  // fact from "you may not have it right now", and the refusal names a
  // fork risk that cannot exist for a conversation with no transcript.
  test("no-transcript wins over the no-database refusal", async () => {
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      getDb: async () => null,
      locateConversation: async () => null,
    });
    expect(outcome).toEqual({ outcome: "no-transcript" });
  });

  test("an unknown conversation never reaches the presence read", async () => {
    let presenceReads = 0;
    await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      locateConversation: async () => null,
      readPresence: async () => {
        presenceReads += 1;
        return "IDLE";
      },
    });
    expect(presenceReads).toBe(0);
  });

  test("returns no-transcript when the conversation is not on disk", async () => {
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      locateConversation: async () => null,
    });
    expect(outcome).toEqual({ outcome: "no-transcript" });
  });

  test("returns no-transcript when the transcript has no recoverable cwd", async () => {
    // `claude --resume` has nowhere to run without a cwd — this is "cannot
    // attach at all", distinct from the "not right now" refusals above.
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      locateConversation: async () => ({ jsonlPath: LOCATED.jsonlPath, cwd: undefined }),
    });
    expect(outcome).toEqual({ outcome: "no-transcript" });
  });

  test("returns locked when another cockpit session driver holds the conversation", async () => {
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      withResumeLock: async () => ({ acquired: false }),
    });
    expect(outcome).toEqual({ outcome: "locked" });
  });

  test("the lock is keyed on the CONVERSATION id, not the session driver id", async () => {
    // Keying on the session driver id would give each attach its own namespace and
    // never exclude anything — the lock would be decorative.
    const keys: string[] = [];
    await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      withResumeLock: async (_db, conversationId, fn) => {
        keys.push(conversationId);
        return { acquired: true, result: await fn() };
      },
    });
    expect(keys).toEqual([CONVERSATION]);
  });

  // ── mt#4869: the roster gate ──────────────────────────────────────────────

  test("a live roster holder refuses with live-elsewhere, holder carried, even though presence admits", async () => {
    const holder = {
      surface: "terminal" as const,
      name: "roster-probe",
      pid: 4242,
      idleForMs: 9000,
    };
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      readPresence: async () => "IDLE" as const, // would otherwise admit
      classifyHolder: async () => ({ liveness: "running" as const, holder, basis: "test" }),
    });
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toBe("live-elsewhere");
    expect(outcome.holder).toEqual(holder);
  });

  test("an unreadable roster refuses with roster-unknown", async () => {
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      classifyHolder: async () => ({
        liveness: "unknown" as const,
        holder: null,
        basis: "test: roster unreadable",
      }),
    });
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toBe("roster-unknown");
    expect(outcome.message).toMatch(/roster/i);
  });

  test("the roster is consulted even with no database, ahead of the no-telemetry refusal", async () => {
    let rosterReads = 0;
    const holder = { surface: "claude-desktop" as const, name: null, pid: 99, idleForMs: null };
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      getDb: async () => null,
      classifyHolder: async () => {
        rosterReads += 1;
        return { liveness: "running" as const, holder, basis: "test" };
      },
    });
    expect(rosterReads).toBe(1);
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome !== "refused") throw new Error("unreachable");
    // The roster's live-elsewhere refusal wins over the no-DB no-telemetry one —
    // both are refusals, but the roster identified an actual holder.
    expect(outcome.reason).toBe("live-elsewhere");
    expect(outcome.holder).toEqual(holder);
  });

  test("a not_running roster falls through to the presence-based decision unchanged", async () => {
    const outcome = await orchestrateDrivenSessionAttach(CONVERSATION, {
      ...admitDeps(),
      readPresence: async () => "IDLE" as const,
      classifyHolder: async () => NOT_HELD,
    });
    expect(outcome.outcome).toBe("attached");
  });
});

// ---------------------------------------------------------------------------
// mt#4255 — driver-gone retirement at boot
// ---------------------------------------------------------------------------

describe("boot reconciliation retires a row whose session driver is gone (mt#4255)", () => {
  /**
   * A row that reaches the new third test: transcript intact, real cwd, and a
   * recorded pid/cmdline pair. `BASE_ROW` has `pid: null` on purpose, which is
   * why every pre-existing test above is untouched by this branch.
   */
  const LIVE_SHAPED_ROW: DrivenSessionRow = {
    ...BASE_ROW,
    status: "running",
    pid: 4242,
    pidCmdline: "claude -p --input-format stream-json --output-format stream-json",
  };

  /** Collects what was written back, so a verdict can be asserted on columns. */
  function captureWrites() {
    const writes: Record<string, unknown>[] = [];
    return {
      writes,
      persistTerminalVerdict: (async (_db, input) => {
        writes.push(input as unknown as Record<string, unknown>);
        return "written";
      }) as NonNullable<
        Parameters<typeof reconcilePersistedDrivenSessions>[0]["persistTerminalVerdict"]
      >,
    };
  }

  test("AT1 — a dead pid is persisted `exited`, not registered, and counted", async () => {
    const registry = new DrivenSessionRegistry();
    const { writes, persistTerminalVerdict } = captureWrites();

    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [LIVE_SHAPED_ROW],
      registry,
      persistTerminalVerdict,
      probeSessionDriver: async () => "gone",
    });

    expect(outcome.kind).toBe("loaded");
    if (outcome.kind !== "loaded") throw new Error("unreachable");
    expect(outcome.retired).toBe(1);
    // Not registered — this is what makes the phantom disappear on THIS boot
    // rather than the next one.
    expect(outcome.count).toBe(0);
    expect(registry.get("local-1")).toBeUndefined();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.status).toBe("exited");
  });

  test("AT2 — a live session driver that still MATCHES is left alone (the dual-daemon case)", async () => {
    // The test that a sweep marking everything terminal would fail. The
    // sanctioned dev loop runs a second daemon beside the tray one; its boot
    // reads the first daemon's rows and must not retire live children.
    const registry = new DrivenSessionRegistry();
    const { writes, persistTerminalVerdict } = captureWrites();

    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [LIVE_SHAPED_ROW],
      registry,
      persistTerminalVerdict,
      probeSessionDriver: async () => "ours",
    });

    if (outcome.kind !== "loaded") throw new Error("unreachable");
    expect(outcome.retired).toBe(0);
    expect(outcome.count).toBe(1);
    expect(registry.get("local-1")?.status).toBe("reconnecting");
    expect(writes).toHaveLength(0);
  });

  test("AT3 — a pid ALIVE but reused by an unrelated process is retired", async () => {
    // Observed on prod 2026-08-18: of 23 non-terminal rows, 22 pids were dead
    // and one was alive as an unrelated desktop app that had inherited the
    // number over an 18-day gap. A bare liveness check calls that row live
    // forever; only the recorded command line separates the two.
    const registry = new DrivenSessionRegistry();
    const { writes, persistTerminalVerdict } = captureWrites();

    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [LIVE_SHAPED_ROW],
      registry,
      persistTerminalVerdict,
      probeSessionDriver: async () => "not-ours",
    });

    if (outcome.kind !== "loaded") throw new Error("unreachable");
    expect(outcome.retired).toBe(1);
    expect(registry.get("local-1")).toBeUndefined();
    expect(writes[0]?.status).toBe("exited");
  });

  test("AT4 — a row with no recorded pid is never probed and never retired", async () => {
    const registry = new DrivenSessionRegistry();
    const { writes, persistTerminalVerdict } = captureWrites();
    let probed = 0;

    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [{ ...LIVE_SHAPED_ROW, pid: null }],
      registry,
      persistTerminalVerdict,
      probeSessionDriver: async () => {
        probed += 1;
        return "gone";
      },
    });

    if (outcome.kind !== "loaded") throw new Error("unreachable");
    expect(probed).toBe(0);
    expect(outcome.retired).toBe(0);
    expect(registry.get("local-1")?.status).toBe("reconnecting");
    expect(writes).toHaveLength(0);
  });

  test("AT5a — an `unknown` verdict fails OPEN: the row stays reconnecting", async () => {
    // The distinction the pre-existing `verifyProcessIdentity` cannot express.
    // It returns `false` for BOTH "no such process" and "`ps` could not
    // answer", so a sweep built on it would retire the whole table the first
    // time `ps` misbehaved.
    const registry = new DrivenSessionRegistry();
    const { writes, persistTerminalVerdict } = captureWrites();

    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [LIVE_SHAPED_ROW],
      registry,
      persistTerminalVerdict,
      probeSessionDriver: async () => "unknown",
    });

    if (outcome.kind !== "loaded") throw new Error("unreachable");
    expect(outcome.retired).toBe(0);
    expect(registry.get("local-1")?.status).toBe("reconnecting");
    expect(writes).toHaveLength(0);
  });

  test("AT5b — a probe that exceeds its bound fails OPEN and names the stage", async () => {
    const registry = new DrivenSessionRegistry();
    const { writes, persistTerminalVerdict } = captureWrites();

    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [LIVE_SHAPED_ROW],
      registry,
      persistTerminalVerdict,
      probeSessionDriver: () => neverSettles<"gone">(),
      rowTimeoutMs: 5_000,
      // Race 4, per `tripRace`'s ordering: 1 `resolve-db`, 2 `list-rows`, 3 the
      // row's cwd probe, 4 its session driver probe. Tripping 3 instead stalls the
      // cwd probe, which fails open to "not missing" and leaves the row
      // resumable — so the session driver probe still runs, against a signal that
      // will now never trip and an operation that never settles. The test then
      // hangs rather than failing, which is how this index was found.
      timeoutSignal: tripRace(4),
    });

    if (outcome.kind !== "loaded") throw new Error("unreachable");
    expect(outcome.retired).toBe(0);
    expect(outcome.degraded).toContain("sessionDriver-probe");
    // Degraded is not retired: a probe that could not answer leaves the row
    // exactly as it was.
    expect(registry.get("local-1")?.status).toBe("reconnecting");
    expect(writes).toHaveLength(0);
  });

  test("AT6 — the second run over the same table retires nothing", async () => {
    // Idempotence, asserted through the mechanism that provides it rather than
    // by re-running against a mutable fake: the write sets a terminal status,
    // and `listNonTerminalDrivenSessions` excludes terminal rows in SQL — so
    // the retired row is not in the next boot's read at all.
    const table = new Map<string, DrivenSessionRow>([["local-1", LIVE_SHAPED_ROW]]);
    const deps = {
      getDb: async () => FAKE_DB,
      listNonTerminal: async () =>
        [...table.values()].filter(
          (r) => !["exited", "crashed", "unrecoverable"].includes(r.status)
        ),
      persistTerminalVerdict: (async (_db, input) => {
        const existing = table.get(input.localId as string);
        if (existing) table.set(input.localId as string, { ...existing, status: input.status });
        return "written";
      }) as NonNullable<
        Parameters<typeof reconcilePersistedDrivenSessions>[0]["persistTerminalVerdict"]
      >,
      probeSessionDriver: async () => "gone" as const,
    };

    const first = await reconcilePersistedDrivenSessions({
      ...deps,
      registry: new DrivenSessionRegistry(),
    });
    if (first.kind !== "loaded") throw new Error("unreachable");
    expect(first.retired).toBe(1);

    const second = await reconcilePersistedDrivenSessions({
      ...deps,
      registry: new DrivenSessionRegistry(),
    });
    // No rows left to read at all — the strongest form of "changes nothing".
    expect(second.kind).toBe("empty");
  });

  test("R1 — a persist that FAILS is not counted retired, and the row is registered", async () => {
    // PR #3126 R1 (BLOCKING). The write is best-effort and swallows its own
    // error, so before this the loop counted the row `retired` and skipped
    // registering it regardless — putting "retired N" in the operator's one
    // boot line for a row the database still held non-terminal and would re-read
    // on the very next boot. Both halves are now gated on a confirmed write.
    const registry = new DrivenSessionRegistry();

    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [LIVE_SHAPED_ROW],
      registry,
      persistTerminalVerdict: async () => {
        throw new Error("simulated upsert failure");
      },
      probeSessionDriver: async () => "gone",
    });

    if (outcome.kind !== "loaded") throw new Error("unreachable");
    // The claim the operator reads must match what is durably true.
    expect(outcome.retired).toBe(0);
    expect(outcome.degraded).toContain("persist-verdict");
    // Registered, because persistence still holds it non-terminal — hiding it
    // would desynchronize the registry from the row set the next boot reads.
    expect(outcome.count).toBe(1);
    expect(registry.get("local-1")?.status).toBe("reconnecting");
  });

  test("R1 — a persist that TIMES OUT is not counted retired either", async () => {
    const registry = new DrivenSessionRegistry();

    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [LIVE_SHAPED_ROW],
      registry,
      persistTerminalVerdict: () => neverSettles<"written">(),
      probeSessionDriver: async () => "gone",
      rowTimeoutMs: 5_000,
      // Race 5: 1 resolve-db, 2 list-rows, 3 cwd probe, 4 session driver probe,
      // 5 the verdict write.
      timeoutSignal: tripRace(5),
    });

    if (outcome.kind !== "loaded") throw new Error("unreachable");
    expect(outcome.retired).toBe(0);
    expect(outcome.degraded).toContain("persist-verdict");
    expect(registry.get("local-1")?.status).toBe("reconnecting");
  });

  test("a MIXED batch splits correctly between count and retired", async () => {
    // Every other test here runs one row, where `count = rows.length - retired`
    // is right for either value and an off-by-one is invisible. This is the
    // member of the class those cannot reach: three rows, one retired, and both
    // halves of the arithmetic asserted against the registry that actually
    // holds them.
    const registry = new DrivenSessionRegistry();
    const { persistTerminalVerdict } = captureWrites();
    const rows: DrivenSessionRow[] = [
      { ...LIVE_SHAPED_ROW, localId: "alive-1", pid: 1 },
      { ...LIVE_SHAPED_ROW, localId: "dead-1", pid: 2 },
      { ...LIVE_SHAPED_ROW, localId: "alive-2", pid: 3, status: "spawned" },
    ];

    const outcome = await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => rows,
      registry,
      persistTerminalVerdict,
      probeSessionDriver: async (pid) => (pid === 2 ? "gone" : "ours"),
    });

    if (outcome.kind !== "loaded") throw new Error("unreachable");
    expect(outcome.retired).toBe(1);
    expect(outcome.count).toBe(2);
    // The count is a claim about the registry — check the registry, not just
    // the number that claims to describe it.
    expect(registry.list()).toHaveLength(2);
    expect(registry.get("dead-1")).toBeUndefined();
    expect(registry.get("alive-1")?.status).toBe("reconnecting");
    // `spawned` and `running` are both non-terminal and take the identical
    // path — the branch never reads `status`.
    expect(registry.get("alive-2")?.status).toBe("reconnecting");
  });

  test("the write records a verdict, not a rewrite — and preserves its own evidence", async () => {
    // Same PR #2383 R1 constraint the unrecoverable write is held to: the store
    // upserts with `onConflictDoUpdate({ set: values })`, so a defaulted field
    // OVERWRITES the stored one. `pid`/`pidCmdline` matter twice over here —
    // they are the EVIDENCE for this verdict, so erasing them would leave a
    // future reader nothing to check.
    const registry = new DrivenSessionRegistry();
    const { writes, persistTerminalVerdict } = captureWrites();

    await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [{ ...LIVE_SHAPED_ROW, model: "fable", driverGeneration: 3 }],
      registry,
      persistTerminalVerdict,
      probeSessionDriver: async () => "gone",
    });

    const write = writes[0];
    expect(write?.model).toBe("fable");
    expect(write?.driverGeneration).toBe(3);
    expect(write?.pid).toBe(4242);
    expect(write?.pidCmdline).toContain("claude");
    expect(write?.harnessSessionId).toBe("harness-1");
    // `unrecoverableReason` is an assertion about the CONVERSATION, and this
    // verdict makes none — the conversation stays resumable. Writing an
    // session driver-layer reason into that column would tell the next reader it was
    // condemned.
    expect(write?.unrecoverableReason).toBeNull();
  });

  test("an unrecoverable row is still unrecoverable — the session driver probe never runs for it", async () => {
    // Ordering guard: the conversation-layer verdict wins, and a row with no
    // transcript must not be downgraded to a mere `exited` just because its pid
    // also happens to be dead.
    const registry = new DrivenSessionRegistry();
    const { writes, persistTerminalVerdict } = captureWrites();
    let probed = 0;

    await reconcilePersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [{ ...LIVE_SHAPED_ROW, harnessSessionId: null }],
      registry,
      persistTerminalVerdict,
      probeSessionDriver: async () => {
        probed += 1;
        return "gone";
      },
    });

    expect(probed).toBe(0);
    expect(writes[0]?.status).toBe("unrecoverable");
    expect(registry.get("local-1")?.status).toBe("unrecoverable");
  });
});

// PR #2452 R1 (non-blocking): remove the per-run temp dir so repeated runs do
// not accumulate orphaned directories under the system temp root.
afterAll(() => {
  rmSync(TEST_WORKSPACE_ROOT, { recursive: true, force: true });
});
