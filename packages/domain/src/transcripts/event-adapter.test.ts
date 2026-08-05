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
import { turnLineToBlock } from "./session-context-snapshot";
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

describe("adaptTranscriptToEvents — mt#3262 AT1: sourceRef.turnIndex round-trips with the snapshot's turnIndex", () => {
  test("every event's sourceRef.turnIndex indexes the SAME transcript line assembleSessionContextSnapshot resolves via turnLineToBlock", () => {
    const transcript: TranscriptMessage[] = [
      userMsg("please read a file", "2026-07-28T10:00:00.000Z", "line-0"),
      assistantMsg(
        [
          { type: "thinking", thinking: "I should read it" },
          { type: "text", text: "Reading now." },
          { type: "tool_use", id: "call-a", name: READ_FILE_TOOL, input: { path: "a.ts" } },
        ],
        "2026-07-28T10:00:01.000Z",
        "line-1"
      ),
      userMsg(
        [{ type: "tool_result", tool_use_id: "call-a", content: "contents of a", is_error: false }],
        "2026-07-28T10:00:02.000Z",
        "line-2"
      ),
    ];

    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    expect(events.length).toBeGreaterThan(0);

    // Irrelevant to the identity assertion below — turnLineToBlock's block-id
    // prefix only, not the turnIndex it stamps.
    const AGENT_SESSION_ID = "agent-1";

    for (const event of events) {
      const ref = event.sourceRef;
      expect(ref).toBeDefined();
      const turnIndex = ref?.turnIndex as number;
      const sourceLine = transcript[turnIndex];
      expect(sourceLine).toBeDefined();

      // The SAME conversion `assembleSessionContextSnapshot` applies at the
      // SAME array index (`turnArray.forEach((entry, idx) =>
      // turnLineToBlock(agentSessionId, idx, entry))`,
      // session-context-snapshot.ts), over the SAME array `getTranscript()`
      // returns verbatim. If this identity does NOT hold, the adapter's loop
      // index and the snapshot's turnIndex have diverged and the join key
      // this task's design rests on is broken.
      const block = turnLineToBlock(AGENT_SESSION_ID, turnIndex, sourceLine);
      expect(block).not.toBeNull();
      expect(block?.turnIndex).toBe(turnIndex);
      expect(block?.rawJsonlType).toBe(sourceLine?.type);
      expect(block?.timestamp).toBe(sourceLine?.timestamp);
    }

    // Spot-check the disambiguation turnIndex alone cannot provide: a
    // tool-call event needs toolUseId (a batch can emit several tool-call
    // events sharing one turnIndex).
    const toolEvent = events.find((e) => e.verb === "read");
    expect(toolEvent?.sourceRef?.turnIndex).toBe(1);
    expect(toolEvent?.sourceRef?.toolUseId).toBe("call-a");
    expect(toolEvent?.sourceRef?.messageUuid).toBe("line-1");

    const thinkEvent = events.find((e) => e.verb === "think");
    expect(thinkEvent?.sourceRef?.turnIndex).toBe(1);
    expect(thinkEvent?.sourceRef?.toolUseId).toBeUndefined();

    const speakEvent = events.find((e) => e.verb === "speak");
    expect(speakEvent?.sourceRef?.turnIndex).toBe(1);

    const askEvent = events.find((e) => e.verb === "ask");
    expect(askEvent?.sourceRef?.turnIndex).toBe(0);
    expect(askEvent?.sourceRef?.messageUuid).toBe("line-0");
  });
});

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

  test("real-corpus phrasing: 'Subagent merge denied (ADR-028 D5): ...' maps to policy/denied", () => {
    const transcript: TranscriptMessage[] = [
      assistantMsg(
        [
          {
            type: "tool_use",
            id: "call-merge2",
            name: "session_pr_merge",
            input: { task: "mt#2" },
          },
        ],
        "2026-07-24T11:06:00.000Z",
        "line-merge2"
      ),
      userMsg(
        [
          {
            type: "tool_result",
            tool_use_id: "call-merge2",
            content: "Subagent merge denied (ADR-028 D5): no valid capability grant for mt#2.",
            is_error: true,
          },
        ],
        "2026-07-24T11:06:01.000Z"
      ),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const merge = events.find((e) => e.verb === "write");
    expect(merge?.actor.kind).toBe("policy");
    expect(merge?.actor.guardName).toBe("ADR-028 D5");
    expect(merge?.outcome).toBe("denied");
  });

  test("real-corpus phrasing: '<hook> hook blocked the commit (<reason>)' maps to policy/denied", () => {
    const transcript: TranscriptMessage[] = [
      assistantMsg(
        [{ type: "tool_use", id: "call-commit", name: "session_commit", input: {} }],
        "2026-07-24T11:07:00.000Z",
        "line-commit"
      ),
      userMsg(
        [
          {
            type: "tool_result",
            tool_use_id: "call-commit",
            content: "MCP error: pre-commit hook blocked the commit (ESLint warning threshold)",
            is_error: true,
          },
        ],
        "2026-07-24T11:07:01.000Z"
      ),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const commit = events.find((e) => e.verb === "write");
    expect(commit?.actor.kind).toBe("policy");
    expect(commit?.outcome).toBe("denied");
  });

  test("a genuine (non-guard) tool error does not get attributed to policy", () => {
    const transcript: TranscriptMessage[] = [
      assistantMsg(
        [{ type: "tool_use", id: "call-err", name: READ_FILE_TOOL, input: { path: "missing.ts" } }],
        "2026-07-24T11:08:00.000Z",
        "line-err"
      ),
      userMsg(
        [
          {
            type: "tool_result",
            tool_use_id: "call-err",
            content: "ENOENT: no such file or directory",
            is_error: true,
          },
        ],
        "2026-07-24T11:08:01.000Z"
      ),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const read = events.find((e) => e.verb === "read");
    expect(read?.actor.kind).toBe("agent");
    expect(read?.outcome).toBe("error");
  });
});

describe("adaptTranscriptToEvents — unpaired tool call: outcome is unresolved, not 'ok'", () => {
  test("a tool_use with no matching tool_result ANYWHERE in the transcript has outcome undefined", () => {
    const transcript: TranscriptMessage[] = [
      assistantMsg(
        [{ type: "tool_use", id: "call-unpaired", name: READ_FILE_TOOL, input: { path: "x.ts" } }],
        "2026-07-24T11:09:00.000Z",
        "line-unpaired"
      ),
      // No following user line at all — the call is never paired with a completion.
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const read = events.find((e) => e.verb === "read");
    expect(read).toBeDefined();
    expect(read?.outcome).toBeUndefined();
    expect(read?.tEnd).toBeUndefined();
  });

  test("a tool_use followed by a user line with an UNRELATED tool_result id is still unresolved", () => {
    const transcript: TranscriptMessage[] = [
      assistantMsg(
        [{ type: "tool_use", id: "call-a", name: READ_FILE_TOOL, input: { path: "a.ts" } }],
        "2026-07-24T11:10:00.000Z",
        "line-a"
      ),
      userMsg(
        [{ type: "tool_result", tool_use_id: "call-different", content: "ok", is_error: false }],
        "2026-07-24T11:10:01.000Z"
      ),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const read = events.find((e) => e.verb === "read");
    expect(read?.outcome).toBeUndefined();
  });
});

describe("adaptTranscriptToEvents — mt#3795: pairing is by tool_use_id, not by position", () => {
  test("calls on CONSECUTIVE assistant lines both resolve, though neither is followed by its own result line", () => {
    // The shape the harness actually writes for parallel calls, and the shape
    // the old immediately-following-line search could not pair: call A, then
    // call B on the next ASSISTANT line, then one user line carrying both
    // results. Under the old rule A's next line was an assistant line (no
    // results at all) and B's next line carried A's result (wrong id), so BOTH
    // emitted unresolved.
    const transcript: TranscriptMessage[] = [
      assistantMsg(
        [{ type: "tool_use", id: "call-a", name: READ_FILE_TOOL, input: { path: "a.ts" } }],
        "2026-07-24T12:00:00.000Z",
        "line-a"
      ),
      assistantMsg(
        [{ type: "tool_use", id: "call-b", name: READ_FILE_TOOL, input: { path: "b.ts" } }],
        "2026-07-24T12:00:01.000Z",
        "line-b"
      ),
      userMsg(
        [
          { type: "tool_result", tool_use_id: "call-a", content: "contents of a", is_error: false },
          { type: "tool_result", tool_use_id: "call-b", content: "contents of b", is_error: false },
        ],
        "2026-07-24T12:00:02.000Z"
      ),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const a = events.find((e) => e.target.id.endsWith("a.ts"));
    const b = events.find((e) => e.target.id.endsWith("b.ts"));
    expect(a?.outcome).toBe("ok");
    expect(b?.outcome).toBe("ok");
    // tEnd comes from the line that CARRIED the result, not from `i + 1`.
    expect(a?.tEnd).toBe("2026-07-24T12:00:02.000Z");
    expect(b?.tEnd).toBe("2026-07-24T12:00:02.000Z");
  });

  test("a result several lines later still pairs, and an error result still reads as error", () => {
    const transcript: TranscriptMessage[] = [
      assistantMsg(
        [{ type: "tool_use", id: "call-far", name: READ_FILE_TOOL, input: { path: "far.ts" } }],
        "2026-07-24T12:10:00.000Z",
        "line-far"
      ),
      assistantMsg(
        [{ type: "text", text: "thinking out loud" }],
        "2026-07-24T12:10:01.000Z",
        "line-mid"
      ),
      userMsg([{ type: "text", text: "a genuine interjection" }], "2026-07-24T12:10:02.000Z"),
      userMsg(
        [{ type: "tool_result", tool_use_id: "call-far", content: "boom", is_error: true }],
        "2026-07-24T12:10:03.000Z"
      ),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const far = events.find((e) => e.verb === "read");
    expect(far?.outcome).toBe("error");
    expect(far?.tEnd).toBe("2026-07-24T12:10:03.000Z");
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
});

describe("adaptTranscriptToEvents — mt#3258 SC 3: coverage-hole sweep (Skill, tasks_children, + others)", () => {
  test("a Skill invocation maps to a real realm/target, not unknown:Skill", () => {
    const transcript: TranscriptMessage[] = [
      assistantMsg(
        [{ type: "tool_use", id: "call-skill", name: "Skill", input: { skill: "cockpit-design" } }],
        "2026-07-26T12:00:00.000Z",
        "line-skill"
      ),
      userMsg(
        [{ type: "tool_result", tool_use_id: "call-skill", content: "ok", is_error: false }],
        "2026-07-26T12:00:01.000Z"
      ),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const skillEvent = events.find((e) => e.verb === "execute" && e.target.realm === "agents");
    expect(skillEvent).toBeDefined();
    expect(skillEvent?.unmapped).toBe(false);
    expect(skillEvent?.target.id).toBe("agents:skill:cockpit-design");
    expect(skillEvent?.target.id).not.toContain("unknown");
  });

  test("mcp__minsky__tasks_children maps to minsky-substrate, not unknown:tasks_children", () => {
    const transcript: TranscriptMessage[] = [
      assistantMsg(
        [
          {
            type: "tool_use",
            id: "call-children",
            name: "mcp__minsky__tasks_children",
            input: { taskId: "mt#3258" },
          },
        ],
        "2026-07-26T12:00:00.000Z",
        "line-children"
      ),
      userMsg(
        [{ type: "tool_result", tool_use_id: "call-children", content: "ok", is_error: false }],
        "2026-07-26T12:00:01.000Z"
      ),
    ];
    const events = adaptTranscriptToEvents(transcript, PRINCIPAL_CONTEXT);
    const childrenEvent = events.find(
      (e) => e.verb === "read" && e.target.realm === "minsky-substrate"
    );
    expect(childrenEvent).toBeDefined();
    expect(childrenEvent?.unmapped).toBe(false);
    expect(childrenEvent?.target.id).toBe("minsky:task:mt#3258");
  });
});

describe("adaptTranscriptToEvents — AT3: unknown-tool fallback + coverage metric", () => {
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
