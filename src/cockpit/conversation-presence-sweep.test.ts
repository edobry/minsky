/**
 * Absence-detection sweep coverage (mt#3201, mt#3130 Phase 2).
 *
 * The transition logic is pure over injected IO, so the seed rule, the
 * change-detection rule, and the fail-open NOTIFY path are all reachable
 * without a database.
 */
import { describe, test, expect } from "bun:test";
import {
  createPresenceSweepState,
  runPresenceSweepTick,
  CHANNEL_CONVERSATION_PRESENCE_CHANGED,
  type PresenceSweepDeps,
} from "./conversation-presence-sweep";
import { PRESENCE_STALL_THRESHOLD_MS } from "@minsky/domain/conversation-run-state/presence";
import {
  startConversationPresenceSweeper,
  getSweepLivenessSnapshot,
  _resetSweepLivenessRegistryForTest,
} from "./sweepers";
import type { ConversationRunStateRecord } from "@minsky/domain/storage/schemas/conversation-run-state-schema";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function makeRow(overrides: Partial<ConversationRunStateRecord> = {}): ConversationRunStateRecord {
  return {
    conversationId: "conv-1",
    lastEventName: "PreToolUse",
    lastEventAt: new Date(NOW.getTime() - PRESENCE_STALL_THRESHOLD_MS - 60_000),
    activity: "running",
    toolName: "Bash",
    toolStartedAt: new Date(NOW.getTime() - PRESENCE_STALL_THRESHOLD_MS - 60_000),
    promptId: null,
    needsInputReason: null,
    needsInputTool: null,
    needsInputAt: null,
    lastErrorType: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    lastCompactionTrigger: null,
    lastCompactionAt: null,
    lastCompactionEndedAt: null,
    endedHintAt: null,
    endedHintReason: null,
    cwd: null,
    projectId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ConversationRunStateRecord;
}

/** Deps with a recording emitter; `rows` can be swapped between ticks. */
function makeDeps(rows: ConversationRunStateRecord[]): {
  deps: PresenceSweepDeps;
  emitted: Array<{ channel: string; payload: string }>;
  setRows: (next: ConversationRunStateRecord[]) => void;
} {
  let current = rows;
  const emitted: Array<{ channel: string; payload: string }> = [];
  return {
    emitted,
    setRows: (next) => {
      current = next;
    },
    deps: {
      listQuietSince: async () => current,
      emit: async (channel, payload) => {
        emitted.push({ channel, payload });
      },
      now: () => NOW,
    },
  };
}

describe("runPresenceSweepTick", () => {
  test("the first tick seeds silently — a cold start does not fire a burst for long-quiet conversations", async () => {
    const state = createPresenceSweepState();
    const { deps, emitted } = makeDeps([makeRow()]);

    const transitions = await runPresenceSweepTick(state, deps);

    expect(transitions).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    // The state IS recorded, so the NEXT change is detectable.
    expect(state.seeded).toBe(true);
    expect(state.lastKnown.get("conv-1")).toBe("STALLED");
  });

  test("a conversation entering the quiet window after seeding emits STALLED", async () => {
    const state = createPresenceSweepState();
    const { deps, emitted, setRows } = makeDeps([]);

    await runPresenceSweepTick(state, deps); // seed with nothing tracked
    setRows([makeRow()]);
    const transitions = await runPresenceSweepTick(state, deps);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      conversationId: "conv-1",
      from: null,
      to: "STALLED",
    });
    expect(emitted).toHaveLength(1);
    const first = emitted[0];
    expect(first).toBeDefined();
    expect(first?.channel).toBe(CHANNEL_CONVERSATION_PRESENCE_CHANGED);
    expect(JSON.parse(first?.payload ?? "{}")).toMatchObject({ to: "STALLED" });
  });

  test("an unchanged presence does not re-emit on every tick", async () => {
    const state = createPresenceSweepState();
    const { deps, emitted, setRows } = makeDeps([]);

    await runPresenceSweepTick(state, deps);
    setRows([makeRow()]);
    await runPresenceSweepTick(state, deps); // emits once
    await runPresenceSweepTick(state, deps); // same state — silent
    await runPresenceSweepTick(state, deps);

    expect(emitted).toHaveLength(1);
  });

  test("a genuine change emits with the previous value in `from`", async () => {
    const state = createPresenceSweepState();
    const { deps, emitted, setRows } = makeDeps([]);

    await runPresenceSweepTick(state, deps);
    setRows([makeRow()]); // STALLED (mid-work, quiet)
    await runPresenceSweepTick(state, deps);

    // Same conversation, now quiet after a completed turn.
    setRows([makeRow({ activity: "idle", toolName: null, toolStartedAt: null })]);
    const transitions = await runPresenceSweepTick(state, deps);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "STALLED", to: "IDLE" });
    expect(emitted).toHaveLength(2);
  });

  test("a resumed conversation is pruned from the tracked set rather than remembered as stale", async () => {
    const state = createPresenceSweepState();
    const { deps, setRows } = makeDeps([]);

    await runPresenceSweepTick(state, deps);
    setRows([makeRow()]);
    await runPresenceSweepTick(state, deps);
    expect(state.lastKnown.has("conv-1")).toBe(true);

    // It resumed: no longer in the quiet window, so absent from the scan.
    setRows([]);
    await runPresenceSweepTick(state, deps);

    expect(state.lastKnown.has("conv-1")).toBe(false);
    expect(state.lastKnown.size).toBe(0);
  });

  test("a NOTIFY failure is swallowed — the tick still reports its transitions", async () => {
    const state = createPresenceSweepState();
    const { deps, setRows } = makeDeps([]);
    const failing: PresenceSweepDeps = {
      ...deps,
      emit: async () => {
        throw new Error("pg_notify unavailable — exercises the fail-open path");
      },
    };

    await runPresenceSweepTick(state, failing);
    setRows([makeRow()]);
    const transitions = await runPresenceSweepTick(state, failing);

    // The push is an enhancement; the read endpoint is the contract. A dead
    // NOTIFY must not abort the tick.
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.to).toBe("STALLED");
  });

  test("a needs-input conversation is reported NEEDS_INPUT, not STALLED, even far past the window", async () => {
    const state = createPresenceSweepState();
    const { deps, setRows } = makeDeps([]);

    await runPresenceSweepTick(state, deps);
    setRows([
      makeRow({
        needsInputReason: "permission_request",
        lastEventAt: new Date(NOW.getTime() - PRESENCE_STALL_THRESHOLD_MS * 5),
      }),
    ]);
    const transitions = await runPresenceSweepTick(state, deps);

    expect(transitions[0]?.to).toBe("NEEDS_INPUT");
  });
});

describe("startConversationPresenceSweeper registration (AT9)", () => {
  test("registers in the sweep-liveness registry that backs GET /api/sweeps, with an advancing lastAttemptAt", async () => {
    _resetSweepLivenessRegistryForTest();
    // Long interval: the boot tick fires immediately (createIntervalSweeper's
    // contract), which is what stamps lastAttemptAt — no timer wait needed,
    // and no second tick during the test.
    const stop = startConversationPresenceSweeper(60 * 60 * 1000);
    try {
      // The boot tick is dispatched as a microtask; let it settle. Its DOMAIN
      // work fails open here (no persistence in-process) — which is exactly
      // the point: lastAttemptAt is stamped at the TOP of runTick, before any
      // guard, so a sweep whose work cannot run is still visibly ATTEMPTING.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const snapshot = getSweepLivenessSnapshot();
      const entry = snapshot.find((s) => s.name === "conversation presence");
      expect(entry).toBeDefined();
      expect(entry?.lastAttemptAt).not.toBeNull();
    } finally {
      stop();
    }

    // stop() deregisters it from the public snapshot, so a stopped daemon does
    // not leave a phantom sweep on /api/sweeps.
    expect(
      getSweepLivenessSnapshot().find((s) => s.name === "conversation presence")
    ).toBeUndefined();
  });
});
