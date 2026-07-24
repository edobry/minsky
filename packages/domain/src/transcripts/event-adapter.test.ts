/**
 * Tests for the transcript → semantic-event adapter (mt#3157).
 *
 * Fixtures are sanitized/synthetic — they mirror the real
 * `agent_transcripts.transcript` / `TranscriptMessage[]` shape (assistant
 * lines carry `content` arrays of `tool_use`/`text`/`thinking` blocks; user
 * lines carry `tool_result` blocks matched by `tool_use_id`) without
 * reproducing any real session content.
 */

import { describe, expect, test } from "bun:test";
import {
  adaptTranscriptToEvents,
  computeAdapterCoverage,
  type AdapterContext,
} from "./event-adapter";
import type { TranscriptMessage } from "../provenance/transcript-service";

const PRINCIPAL_CONTEXT: AdapterContext = {
  agentSessionId: "agent-1",
  userTurnActor: { kind: "principal" },
};

/** Registered tool name reused across fixtures (avoids magic-string duplication). */
const READ_FILE_TOOL = "session_read_file";

function assistantMsg(content: unknown[], timestamp: string, uuid?: string): TranscriptMessage {
  return { type: "assistant", role: "assistant", content, timestamp, uuid };
}

function userMsg(content: unknown, timestamp: string, uuid?: string): TranscriptMessage {
  return { type: "user", role: "user", content, timestamp, uuid };
}

describe("adaptTranscriptToEvents — AT1: parallel tool batch", () => {
  test("tool_use blocks on one assistant line share batchId and identical tStart, no synthetic order", () => {
    const transcript: TranscriptMessage[] = [
      userMsg("please read two files", "2026-07-24T10:00:00.000Z"),
      assistantMsg(
        [
          { type: "tool_use", id: "call-a", name: READ_FILE_TOOL, input: { path: "a.ts" } },
          { type: "tool_use", id: "call-b", name: READ_FILE_TOOL, input: { path: "b.ts" } },
        ],
        "2026-07-24T10:00:01.000Z",
        "line-1"
      ),
      userMsg(
        [
          { type: "tool_result", tool_use_id: "call-a", content: "contents of a", is_error: false },
          { type: "tool_result", tool_use_id: "call-b", content: "contents of b", is_error: false },
        ],
        "2026-07-24T10:00:02.000Z"
      ),
    ];

    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const toolEvents = events.filter((e) => e.verb === "read");

    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]?.batchId).toBeDefined();
    expect(toolEvents[0]?.batchId).toBe(toolEvents[1]?.batchId as string);
    expect(toolEvents[0]?.tStart).toBe("2026-07-24T10:00:01.000Z");
    expect(toolEvents[1]?.tStart).toBe(toolEvents[0]?.tStart as string);
    // No field on either event encodes an intra-batch order beyond array position.
    expect(toolEvents[0]).not.toHaveProperty("order");
    expect(toolEvents[0]).not.toHaveProperty("sequence");
  });
});

describe("adaptTranscriptToEvents — AT2: principal + policy actors", () => {
  test("a real user turn emits a principal-actor event", () => {
    const transcript: TranscriptMessage[] = [
      userMsg("please fix the bug in session.ts", "2026-07-24T11:00:00.000Z"),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const ask = events.find((e) => e.verb === "ask");
    expect(ask).toBeDefined();
    expect(ask?.actor.kind).toBe("principal");
  });

  test("a guard-denial tool_result emits a policy-actor, denied-outcome event", () => {
    const transcript: TranscriptMessage[] = [
      userMsg("merge the PR", "2026-07-24T11:05:00.000Z"),
      assistantMsg(
        [{ type: "tool_use", id: "call-merge", name: "session_pr_merge", input: { task: "mt#1" } }],
        "2026-07-24T11:05:01.000Z",
        "line-merge"
      ),
      userMsg(
        [
          {
            type: "tool_result",
            tool_use_id: "call-merge",
            content:
              "Blocked by hook: require-review-before-merge — CHANGES_REQUESTED review present",
            is_error: true,
          },
        ],
        "2026-07-24T11:05:02.000Z"
      ),
    ];

    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const merge = events.find((e) => e.verb === "write" && e.target.realm === "minsky-substrate");
    expect(merge).toBeDefined();
    expect(merge?.actor.kind).toBe("policy");
    expect(merge?.actor.guardName).toBe("require-review-before-merge");
    expect(merge?.outcome).toBe("denied");
  });
});

describe("adaptTranscriptToEvents — AT3: unknown-tool fallback + coverage metric", () => {
  test("a novel tool name maps to the execute fallback with unmapped=true", () => {
    const transcript: TranscriptMessage[] = [
      userMsg("do the thing", "2026-07-24T12:00:00.000Z"),
      assistantMsg(
        [
          {
            type: "tool_use",
            id: "call-x",
            name: "mcp__totally_new_server__zorb_the_flibbertigibbet",
            input: {},
          },
        ],
        "2026-07-24T12:00:01.000Z",
        "line-x"
      ),
      userMsg(
        [{ type: "tool_result", tool_use_id: "call-x", content: "ok", is_error: false }],
        "2026-07-24T12:00:02.000Z"
      ),
    ];

    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const fallback = events.find((e) => e.unmapped === true);
    expect(fallback).toBeDefined();
    expect(fallback?.verb).toBe("execute");
    expect(fallback?.target.realm).toBe("unknown");

    const coverage = computeAdapterCoverage(events);
    expect(coverage.totalToolEvents).toBe(1);
    expect(coverage.nonFallbackToolEvents).toBe(0);
    expect(coverage.coverage).toBe(0);
  });

  test("coverage metric reflects a mix of mapped and unmapped tool calls", () => {
    const transcript: TranscriptMessage[] = [
      assistantMsg(
        [
          { type: "tool_use", id: "c1", name: READ_FILE_TOOL, input: { path: "a.ts" } },
          { type: "tool_use", id: "c2", name: "mcp__weird__unrecognized_tool", input: {} },
        ],
        "2026-07-24T12:10:00.000Z",
        "line-mix"
      ),
      userMsg(
        [
          { type: "tool_result", tool_use_id: "c1", content: "ok", is_error: false },
          { type: "tool_result", tool_use_id: "c2", content: "ok", is_error: false },
        ],
        "2026-07-24T12:10:01.000Z"
      ),
    ];

    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const coverage = computeAdapterCoverage(events);
    expect(coverage.totalToolEvents).toBe(2);
    expect(coverage.nonFallbackToolEvents).toBe(1);
    expect(coverage.coverage).toBe(0.5);
  });

  test("conversational events (speak/think/ask) are excluded from the coverage denominator", () => {
    const transcript: TranscriptMessage[] = [
      userMsg("hello there", "2026-07-24T12:20:00.000Z"),
      assistantMsg(
        [
          { type: "thinking", thinking: "let me consider this" },
          { type: "text", text: "here is my answer" },
        ],
        "2026-07-24T12:20:01.000Z",
        "line-speak"
      ),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    expect(events.some((e) => e.verb === "ask")).toBe(true);
    expect(events.some((e) => e.verb === "speak")).toBe(true);
    expect(events.some((e) => e.verb === "think")).toBe(true);
    const coverage = computeAdapterCoverage(events);
    expect(coverage.totalToolEvents).toBe(0);
    expect(coverage.coverage).toBe(1);
  });
});

describe("adaptTranscriptToEvents — Amendment 2: child-session dispatch-prompt attribution", () => {
  test("a child transcript's dispatch-prompt line does NOT emit a principal event", () => {
    const childContext: AdapterContext = {
      agentSessionId: "child-agent-1",
      userTurnActor: { kind: "agent", agentSessionId: "parent-agent-1" },
    };
    const childTranscript: TranscriptMessage[] = [
      userMsg("You are a subagent. Implement mt#3157 per its spec...", "2026-07-24T13:00:00.000Z"),
    ];

    const events = adaptTranscriptToEvents(childTranscript, childContext);
    const ask = events.find((e) => e.verb === "ask");
    expect(ask).toBeDefined();
    expect(ask?.actor.kind).toBe("agent");
    expect(ask?.actor.agentSessionId).toBe("parent-agent-1");
    expect(events.some((e) => e.actor.kind === "principal")).toBe(false);
  });

  test("the same child transcript's assistant turns are still attributed to the child agent itself", () => {
    const childContext: AdapterContext = {
      agentSessionId: "child-agent-1",
      userTurnActor: { kind: "agent", agentSessionId: "parent-agent-1" },
    };
    const childTranscript: TranscriptMessage[] = [
      userMsg("dispatch prompt", "2026-07-24T13:00:00.000Z"),
      assistantMsg(
        [{ type: "text", text: "acknowledged" }],
        "2026-07-24T13:00:01.000Z",
        "line-ack"
      ),
    ];
    const events = adaptTranscriptToEvents(childTranscript, childContext);
    const speak = events.find((e) => e.verb === "speak");
    expect(speak?.actor.kind).toBe("agent");
    expect(speak?.actor.agentSessionId).toBe("child-agent-1");
  });
});

describe("adaptTranscriptToEvents — synthetic-interrupt marker handling", () => {
  test("a synthetic interrupt marker line does not emit an ask event", () => {
    const transcript: TranscriptMessage[] = [
      userMsg("[Request interrupted by user for tool use]", "2026-07-24T14:00:00.000Z"),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    expect(events).toHaveLength(0);
  });
});
