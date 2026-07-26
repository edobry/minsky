/**
 * Presence-derivation unit coverage (mt#3201, mt#3130 Phase 2).
 *
 * `derivePresence` is pure with an injected clock, so the whole state space is
 * reachable here without a DB, a daemon, or a live harness.
 */
import { describe, test, expect } from "bun:test";
import {
  derivePresence,
  PRESENCE_STALL_THRESHOLD_MS,
  PRESENCE_QUIET_THRESHOLD_MS,
} from "./presence";
import { PERMISSION_REQUEST_REASON } from "./event-mapping";
import type { ConversationRunStateRecord } from "../storage/schemas/conversation-run-state-schema";

const NOW = new Date("2026-07-25T12:00:00.000Z");

/** A row with every column at its post-migration default; overrides layer on top. */
function makeRow(overrides: Partial<ConversationRunStateRecord> = {}): ConversationRunStateRecord {
  return {
    conversationId: "conv-1",
    lastEventName: "PreToolUse",
    lastEventAt: NOW,
    activity: null,
    toolName: null,
    toolStartedAt: null,
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

/** `ms` milliseconds before NOW. */
function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe("derivePresence", () => {
  describe("UNKNOWN — no telemetry", () => {
    test("a conversation with no run-state row is UNKNOWN, not ENDED and not blank", () => {
      const result = derivePresence(null, NOW);
      expect(result.presence).toBe("UNKNOWN");
      expect(result.basis).toBe("no-row");
      expect(result.quietForMs).toBeNull();
    });
  });

  describe("LIVE / STALLED — the absence-detection boundary", () => {
    test("mid-work within the stall window is LIVE, carrying tool name and elapsed", () => {
      const result = derivePresence(
        makeRow({
          activity: "running",
          toolName: "Bash",
          toolStartedAt: ago(5_000),
          lastEventAt: ago(5_000),
        }),
        NOW
      );
      expect(result.presence).toBe("LIVE");
      expect(result.toolName).toBe("Bash");
      // mt#3130 makes elapsed MANDATORY under LIVE, not optional.
      expect(result.toolElapsedMs).toBe(5_000);
      expect(result.basis).toBe("activity-fresh");
    });

    test("mid-work past the stall window is STALLED, not LIVE — the killed-process correction", () => {
      const result = derivePresence(
        makeRow({
          activity: "running",
          toolName: "Bash",
          toolStartedAt: ago(PRESENCE_STALL_THRESHOLD_MS + 60_000),
          lastEventAt: ago(PRESENCE_STALL_THRESHOLD_MS + 60_000),
        }),
        NOW
      );
      expect(result.presence).toBe("STALLED");
      expect(result.presence).not.toBe("LIVE");
      expect(result.basis).toBe("activity-stale");
      // The in-flight tool is still reported — it is what the conversation was
      // doing when it went quiet, which is the diagnostic value.
      expect(result.toolName).toBe("Bash");
    });

    test("`thinking` follows the same boundary as `running`", () => {
      const fresh = derivePresence(makeRow({ activity: "thinking", lastEventAt: ago(1_000) }), NOW);
      const stale = derivePresence(
        makeRow({ activity: "thinking", lastEventAt: ago(PRESENCE_STALL_THRESHOLD_MS + 1) }),
        NOW
      );
      expect(fresh.presence).toBe("LIVE");
      expect(stale.presence).toBe("STALLED");
    });

    test("the stall threshold is injectable — the same row reads both ways", () => {
      const row = makeRow({ activity: "running", lastEventAt: ago(60_000) });
      expect(derivePresence(row, NOW, { stallThresholdMs: 600_000 }).presence).toBe("LIVE");
      expect(derivePresence(row, NOW, { stallThresholdMs: 30_000 }).presence).toBe("STALLED");
    });
  });

  describe("NEEDS_INPUT — the mandatory reason sub-label", () => {
    test("a PermissionRequest yields reason `permission` plus the tool, with no Ask involved", () => {
      const result = derivePresence(
        makeRow({
          needsInputReason: PERMISSION_REQUEST_REASON,
          needsInputTool: "Write",
          lastEventAt: ago(10_000),
        }),
        NOW
      );
      expect(result.presence).toBe("NEEDS_INPUT");
      expect(result.needsInputReason).toBe("permission");
      expect(result.needsInputTool).toBe("Write");
    });

    test("Notification matchers map to their own sub-labels", () => {
      const idlePrompt = derivePresence(makeRow({ needsInputReason: "idle_prompt" }), NOW);
      const agentNeeds = derivePresence(makeRow({ needsInputReason: "agent_needs_input" }), NOW);
      expect(idlePrompt.needsInputReason).toBe("idle-prompt");
      expect(agentNeeds.needsInputReason).toBe("agent-needs-input");
    });

    test("an unrecognized harness value still yields NEEDS_INPUT with an explicit `unknown` label, never a null sub-label", () => {
      const result = derivePresence(makeRow({ needsInputReason: "some_future_matcher" }), NOW);
      expect(result.presence).toBe("NEEDS_INPUT");
      expect(result.needsInputReason).toBe("unknown");
    });

    test("waiting on a human is NOT subject to the stall window — a long-unanswered prompt stays NEEDS_INPUT", () => {
      const result = derivePresence(
        makeRow({
          needsInputReason: PERMISSION_REQUEST_REASON,
          lastEventAt: ago(PRESENCE_STALL_THRESHOLD_MS * 10),
        }),
        NOW
      );
      expect(result.presence).toBe("NEEDS_INPUT");
      expect(result.presence).not.toBe("STALLED");
      // It IS marked quiet, so the render can say "· quiet 4h".
      expect(result.isQuiet).toBe(true);
    });

    test("needs-input outranks a stale mid-work activity — the wait is the newer observation", () => {
      const result = derivePresence(
        makeRow({
          activity: "running",
          needsInputReason: PERMISSION_REQUEST_REASON,
          lastEventAt: ago(PRESENCE_STALL_THRESHOLD_MS + 1),
        }),
        NOW
      );
      expect(result.presence).toBe("NEEDS_INPUT");
    });
  });

  describe("ENDED — observed only, never inferred from silence", () => {
    test("SessionEnd with nothing observed since is ENDED", () => {
      const endedAt = ago(60_000);
      const result = derivePresence(
        makeRow({ endedHintAt: endedAt, lastEventAt: endedAt, endedHintReason: "logout" }),
        NOW
      );
      expect(result.presence).toBe("ENDED");
      expect(result.basis).toBe("session-end");
    });

    test("an event observed AFTER SessionEnd un-ends the conversation (the resume case)", () => {
      const result = derivePresence(
        makeRow({
          endedHintAt: ago(600_000),
          endedHintReason: "resume",
          activity: "thinking",
          lastEventAt: ago(1_000),
        }),
        NOW
      );
      expect(result.presence).toBe("LIVE");
      expect(result.presence).not.toBe("ENDED");
    });

    test("a long-quiet completed turn is IDLE with a quiet marker — NOT ENDED", () => {
      const week = 7 * 24 * 60 * 60 * 1000;
      const result = derivePresence(makeRow({ activity: "idle", lastEventAt: ago(week) }), NOW);
      // Silence proves nothing about ending, exactly as SessionEnd's absence
      // proves nothing about NOT ending.
      expect(result.presence).toBe("IDLE");
      expect(result.presence).not.toBe("ENDED");
      expect(result.isQuiet).toBe(true);
      expect(result.quietForMs).toBe(week);
    });
  });

  describe("IDLE and the quiet modifier", () => {
    test("a just-completed turn is IDLE and not yet quiet", () => {
      const result = derivePresence(makeRow({ activity: "idle", lastEventAt: ago(1_000) }), NOW);
      expect(result.presence).toBe("IDLE");
      expect(result.isQuiet).toBe(false);
      expect(result.basis).toBe("stopped");
    });

    test("crossing the quiet threshold sets the modifier without changing the value", () => {
      const result = derivePresence(
        makeRow({ activity: "idle", lastEventAt: ago(PRESENCE_QUIET_THRESHOLD_MS + 1_000) }),
        NOW
      );
      expect(result.presence).toBe("IDLE");
      expect(result.isQuiet).toBe(true);
    });

    test("a row whose only events carried no activity signal is IDLE, not UNKNOWN — telemetry exists", () => {
      const result = derivePresence(
        makeRow({ activity: null, lastEventName: "PostCompact", lastEventAt: ago(2_000) }),
        NOW
      );
      expect(result.presence).toBe("IDLE");
      expect(result.presence).not.toBe("UNKNOWN");
    });
  });

  describe("clock-skew hardening", () => {
    test("a future-dated last_event_at clamps quiet duration to 0 rather than going negative", () => {
      const result = derivePresence(
        makeRow({ activity: "idle", lastEventAt: new Date(NOW.getTime() + 5_000) }),
        NOW
      );
      expect(result.quietForMs).toBe(0);
      expect(result.isQuiet).toBe(false);
    });

    test("a future-dated tool_started_at clamps elapsed to 0", () => {
      const result = derivePresence(
        makeRow({
          activity: "running",
          toolStartedAt: new Date(NOW.getTime() + 5_000),
          lastEventAt: NOW,
        }),
        NOW
      );
      expect(result.toolElapsedMs).toBe(0);
    });
  });
});
