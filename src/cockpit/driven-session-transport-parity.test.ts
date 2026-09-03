/**
 * Parity test (mt#4934, Success Criteria item 4): replays the committed
 * pre-refactor fixture (src/cockpit/__fixtures__/) through the POST-refactor
 * supervisor (this module now delegates to `ClaudeStreamJsonTransport`) and
 * diffs the result against the golden capture — which was produced by
 * running the SAME fixture through `git show HEAD:src/cockpit/driven-session-host.ts`
 * at the commit immediately before this split (see that commit's message for
 * the exact capture methodology).
 *
 * What "byte-identical" means here: every field EXCEPT two wall-clock
 * timestamps (`DrivenSessionCostSummary.observedAt` and the synthetic
 * `minsky_operator_input` event's `timestamp`) — both are `new
 * Date().toISOString()` calls with no fixture-controlled input, so their
 * literal string necessarily differs between the original capture run and
 * this run. `normalize()` below replaces both with a fixed sentinel before
 * comparing; everything else (event ORDER, event COUNT, every other field of
 * every payload, the cost history, every observer callback and the record
 * snapshot it saw, the stdin write, the final argv) is compared exactly.
 *
 * No `claude` binary is spawned — a fake `ProcessLike` double replays the
 * fixture's canned lines, per this module's own testing-constraint docblock.
 */
/* eslint-disable custom/no-real-fs-in-tests -- mirrors driven-session-host.test.ts's own TEST_WORKSPACE_ROOT pattern: probeSpawnCwd's mt#3397 preflight does a real statSync, so the cwd under test must be a REAL directory, not an injectable mock */
import { describe, test, expect } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  startDrivenSession,
  sendDrivenSessionInput,
  stopDrivenSession,
  type ProcessLike,
  type SpawnOptions,
} from "./driven-session-host";
import fixture from "./__fixtures__/driven-session-transport-parity.fixture.json";
import golden from "./__fixtures__/driven-session-transport-parity.golden.json";

class FakeClaudeProcess extends EventEmitter implements ProcessLike {
  readonly pid: number | undefined = 777777;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  stdinWrites: string[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: unknown) => {
      this.stdinWrites.push(typeof chunk === "string" ? chunk : String(chunk));
    });
  }

  kill(): boolean {
    return true;
  }

  emitLine(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  emitRaw(text: string): void {
    this.stdout.write(text);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

const TIMESTAMP_SENTINEL = "<normalized-timestamp>";

/** Replace the two wall-clock fields (see module docblock) with a fixed
 * sentinel, recursively, so the rest of the structure compares exactly. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === "observedAt" || key === "timestamp" ? TIMESTAMP_SENTINEL : normalize(v);
    }
    return out;
  }
  return value;
}

interface ObserverCallRecord {
  hook: "onHarnessSessionLinked" | "onResultSummary" | "onStateChange";
  snapshot: Record<string, unknown>;
}

function snapshotRecord(record: {
  localId: string;
  harnessSessionId: string | null;
  status: string;
  unrecoverableReason: string | null;
  exitCode: number | null;
  exitSignal: unknown;
  crashError: string | null;
  driverGeneration: number;
  costHistory: unknown[];
}): Record<string, unknown> {
  return {
    localId: record.localId,
    harnessSessionId: record.harnessSessionId,
    status: record.status,
    unrecoverableReason: record.unrecoverableReason,
    exitCode: record.exitCode,
    exitSignal: record.exitSignal,
    crashError: record.crashError,
    driverGeneration: record.driverGeneration,
    costHistoryLength: record.costHistory.length,
  };
}

describe("driven-session transport parity (mt#4934 SC4)", () => {
  test("post-refactor supervisor reproduces the pre-refactor eventLog, cost history, and observer calls", async () => {
    const observerLog: ObserverCallRecord[] = [];
    const resultSummaries: unknown[] = [];
    let fakeProc: FakeClaudeProcess | undefined;

    const spawnFn = (_command: string, _args: string[], _opts: SpawnOptions): ProcessLike => {
      fakeProc = new FakeClaudeProcess();
      return fakeProc;
    };

    const cwd = mkdtempSync(join(tmpdir(), "driven-session-parity-"));

    const { record } = startDrivenSession({
      cwd,
      permissionMode: fixture.startOptions.permissionMode as "bypassPermissions",
      taskId: fixture.startOptions.taskId,
      minskySessionId: fixture.startOptions.minskySessionId,
      projectId: fixture.startOptions.projectId,
      model: fixture.startOptions.model,
      localId: fixture.startOptions.localId,
      spawnFn,
      mcpConfig: fixture.startOptions.mcpConfig,
      onHarnessSessionLinked: (r) => {
        observerLog.push({ hook: "onHarnessSessionLinked", snapshot: snapshotRecord(r) });
      },
      onResultSummary: (r, summary) => {
        resultSummaries.push(summary);
        observerLog.push({ hook: "onResultSummary", snapshot: snapshotRecord(r) });
      },
      onStateChange: (r) => {
        observerLog.push({ hook: "onStateChange", snapshot: snapshotRecord(r) });
      },
    });

    expect(fakeProc).toBeDefined();
    const proc = fakeProc as FakeClaudeProcess;

    for (const line of fixture.turn1Lines) proc.emitLine(line);
    proc.emitRaw(fixture.malformedRawLine);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const delivered = sendDrivenSessionInput(record, fixture.operatorTurn2Text);

    for (const line of fixture.turn2Lines) proc.emitLine(line);
    await new Promise((resolve) => setTimeout(resolve, 10));

    stopDrivenSession(record);
    proc.exit(fixture.finalExit.code, fixture.finalExit.signal as NodeJS.Signals | null);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const actual = {
      fixtureVersion: 1,
      capturedFrom: golden.capturedFrom, // provenance label, not a parity signal
      inputDelivered: delivered,
      stdinWrites: proc.stdinWrites,
      finalRecord: snapshotRecord(record),
      finalArgv: record.argv,
      finalPid: record.pid,
      eventLog: record.eventLog.map((e) => ({ seq: e.seq, payload: e.payload })),
      costHistory: record.costHistory,
      observerLog,
      resultSummaries,
    };

    expect(normalize(actual)).toEqual(normalize(golden));
  });
});
