import { describe, expect, test } from "bun:test";

import {
  DISPATCH_STAMP_VERSION,
  HOOK_UNKNOWN_AGENT_TYPE,
  buildDispatchStamp,
  decideDispatchRecording,
  extractMinskySessionIdFromPrompt,
  findStampInTranscriptLines,
  parseDispatchStamp,
  stampPrompt,
} from "./agent-dispatch-stamp";
import { UNKNOWN_AGENT_TYPE } from "../../src/mcp/subagent-dispatch-tracker";

const STAMP = {
  parentAgentSessionId: "c4d477ed-06f4-4a8b-884d-e306ec3ac523",
  parentToolUseId: "toolu_01HFmYeonk1aZCcGM9VMt2VD",
};

describe("dispatch stamp format", () => {
  test("round-trips through build and parse", () => {
    expect(parseDispatchStamp(buildDispatchStamp(STAMP))).toEqual(STAMP);
  });

  test("parses out of surrounding prose, not just a bare stamp", () => {
    const text = `Do the thing.\n\n${buildDispatchStamp(STAMP)}\n`;
    expect(parseDispatchStamp(text)).toEqual(STAMP);
  });

  test("survives JSON encoding, which is what the transcript scan depends on", () => {
    // The Stop side scans RAW JSONL lines rather than decoded content, so the
    // stamp has to come through `JSON.stringify` byte-for-byte. If a future
    // format change introduces a quote or backslash, this fails here rather
    // than silently breaking the join in production.
    const encoded = JSON.stringify({ content: `prompt\n\n${buildDispatchStamp(STAMP)}` });
    expect(parseDispatchStamp(encoded)).toEqual(STAMP);
  });

  test("returns null when no stamp is present", () => {
    expect(parseDispatchStamp("just a prompt")).toBeNull();
    expect(parseDispatchStamp("")).toBeNull();
    expect(parseDispatchStamp(undefined)).toBeNull();
  });

  test("does not match a different stamp version", () => {
    const other = buildDispatchStamp(STAMP).replace(DISPATCH_STAMP_VERSION, "minsky:dispatch:v0");
    expect(parseDispatchStamp(other)).toBeNull();
  });
});

describe("stampPrompt", () => {
  test("appends the stamp, leaving the original prompt as the leading text", () => {
    const stamped = stampPrompt("Do the thing.", STAMP);
    expect(stamped.startsWith("Do the thing.")).toBe(true);
    expect(parseDispatchStamp(stamped)).toEqual(STAMP);
  });

  test("is idempotent — a re-dispatch cannot accumulate stamps or overwrite the first", () => {
    const once = stampPrompt("Do the thing.", STAMP);
    const twice = stampPrompt(once, {
      parentAgentSessionId: "different-session",
      parentToolUseId: "toolu_different",
    });
    expect(twice).toBe(once);
    expect(parseDispatchStamp(twice)).toEqual(STAMP);
  });
});

describe("findStampInTranscriptLines", () => {
  test("returns the FIRST stamp, which is the dispatched prompt", () => {
    // Measured shape (2026-08-08): the prompt lands in the child's first `user`
    // record, and an assistant line can quote it back later. Last-wins would
    // therefore read the echo instead of the dispatch.
    const lines = [
      JSON.stringify({ type: "user", content: `task\n\n${buildDispatchStamp(STAMP)}` }),
      JSON.stringify({
        type: "assistant",
        content: buildDispatchStamp({
          parentAgentSessionId: "echoed",
          parentToolUseId: "toolu_echoed",
        }),
      }),
    ];
    expect(findStampInTranscriptLines(lines)).toEqual(STAMP);
  });

  test("skips malformed lines rather than throwing", () => {
    const lines = ["{not json", "", JSON.stringify({ content: buildDispatchStamp(STAMP) })];
    expect(findStampInTranscriptLines(lines)).toEqual(STAMP);
  });

  test("returns null for a transcript with no stamp (pre-mt#2292 subagent)", () => {
    expect(findStampInTranscriptLines([JSON.stringify({ content: "hello" })])).toBeNull();
    expect(findStampInTranscriptLines([])).toBeNull();
  });
});

describe("extractMinskySessionIdFromPrompt", () => {
  test("recovers the workspace id from a generated prompt's absolute path", () => {
    const prompt =
      "Read /Users/x/.local/state/minsky/sessions/e76aef14-dbe0-4d9b-8339-3c0dc6090685/README.md";
    expect(extractMinskySessionIdFromPrompt(prompt)).toBe("e76aef14-dbe0-4d9b-8339-3c0dc6090685");
  });

  test("returns null for a bare dispatch that names no workspace", () => {
    expect(extractMinskySessionIdFromPrompt("Search the codebase for foo.")).toBeNull();
    expect(extractMinskySessionIdFromPrompt(undefined)).toBeNull();
  });
});

describe("decideDispatchRecording", () => {
  const base = {
    sessionId: STAMP.parentAgentSessionId,
    toolUseId: STAMP.parentToolUseId,
    prompt: "Do the thing.",
    subagentType: "general-purpose",
  };

  test("records a bare dispatch, with no reconciliation key", () => {
    const decision = decideDispatchRecording(base);
    expect(decision.action).toBe("record");
    if (decision.action !== "record") throw new Error("unreachable");
    expect(decision.stamp).toEqual(STAMP);
    expect(decision.subagentSessionId).toBeNull();
    expect(decision.agentType).toBe("general-purpose");
  });

  test("carries the workspace id when the prompt names one — the no-double-write key", () => {
    const decision = decideDispatchRecording({
      ...base,
      prompt: "cd-free work in /Users/x/.local/state/minsky/sessions/abc12345-dead-beef/src",
    });
    if (decision.action !== "record") throw new Error("expected record");
    expect(decision.subagentSessionId).toBe("abc12345-dead-beef");
  });

  test("falls back to the agent-type sentinel rather than inventing a type", () => {
    const decision = decideDispatchRecording({ ...base, subagentType: undefined });
    if (decision.action !== "record") throw new Error("expected record");
    expect(decision.agentType).toBe(HOOK_UNKNOWN_AGENT_TYPE);
  });

  test("skips only when a harness identifier is missing", () => {
    expect(decideDispatchRecording({ ...base, toolUseId: undefined }).action).toBe("skip");
    expect(decideDispatchRecording({ ...base, sessionId: undefined }).action).toBe("skip");
  });

  test("an unresolvable task id is NOT a skip — the dispatch still happened", () => {
    // The row is worth writing without a task id; the sentinel exists so the
    // Stop side can fill in what the dispatch side could not. Pinned because
    // treating this as a skip is exactly the pre-mt#2292 defect, one layer up.
    expect(decideDispatchRecording({ ...base, prompt: "" }).action).toBe("record");
  });
});

describe("sentinel pinning", () => {
  test("the locally-duplicated agent-type sentinel equals the tracker's", () => {
    // The constant is duplicated to keep this module dependency-free. Pinning
    // them here is what stops the two drifting apart silently.
    expect(HOOK_UNKNOWN_AGENT_TYPE).toBe(UNKNOWN_AGENT_TYPE);
  });
});
