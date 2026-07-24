import { describe, test, expect } from "bun:test";
import {
  mapHookEventToRunState,
  OBSERVED_HOOK_EVENTS,
  PERMISSION_REQUEST_REASON,
  type HookPayload,
  type RunStatePatch,
} from "./event-mapping";

const AT = new Date("2026-07-24T19:00:00.000Z");

const EVENT_USER_PROMPT_SUBMIT = "UserPromptSubmit";
const EVENT_PRE_TOOL_USE = "PreToolUse";
const EVENT_POST_TOOL_USE = "PostToolUse";
const EVENT_SESSION_START = "SessionStart";

/**
 * Map an event that is expected to be observed, narrowing away the
 * "unmapped" null so assertions read directly off the patch.
 */
function mapped(eventName: string, payload: HookPayload = {}): RunStatePatch {
  const patch = mapHookEventToRunState(eventName, payload, AT);
  if (patch === null) throw new Error(`expected ${eventName} to map to a patch, got null`);
  return patch;
}

describe("mapHookEventToRunState", () => {
  test("UserPromptSubmit records thinking, carries prompt_id, and clears any in-flight tool", () => {
    const patch = mapped(EVENT_USER_PROMPT_SUBMIT, { prompt_id: "p-1" });
    expect(patch.activity).toBe("thinking");
    expect(patch.promptId).toBe("p-1");
    expect(patch.toolName).toBeNull();
    expect(patch.toolStartedAt).toBeNull();
  });

  test("PreToolUse records the tool name and stamps a start time for elapsed rendering", () => {
    const patch = mapped(EVENT_PRE_TOOL_USE, { tool_name: "Bash", prompt_id: "p-2" });
    expect(patch.activity).toBe("running");
    expect(patch.toolName).toBe("Bash");
    expect(patch.toolStartedAt).toEqual(AT);
  });

  test("PostToolUse clears the in-flight tool so a finished call stops reading as running", () => {
    const patch = mapped(EVENT_POST_TOOL_USE, { tool_name: "Bash" });
    expect(patch.activity).toBe("thinking");
    expect(patch.toolName).toBeNull();
    expect(patch.toolStartedAt).toBeNull();
  });

  test("Stop records idle and clears the in-flight tool", () => {
    const patch = mapped("Stop");
    expect(patch.activity).toBe("idle");
    expect(patch.toolName).toBeNull();
  });

  test("StopFailure stores error_type VERBATIM rather than collapsing it to a vocabulary value", () => {
    const patch = mapped("StopFailure", {
      error_type: "rate_limit",
      error_message: "429 slow down",
    });
    // The Rate-limited-vs-Errored split belongs to the render layer; storing a
    // collapsed value here would bake today's mapping into the schema.
    expect(patch.lastErrorType).toBe("rate_limit");
    expect(patch.lastErrorMessage).toBe("429 slow down");
    expect(patch.lastErrorAt).toEqual(AT);
    expect(patch.activity).toBe("idle");
  });

  test("StopFailure without an error_type falls back to the documented `unknown` matcher", () => {
    expect(mapped("StopFailure").lastErrorType).toBe("unknown");
  });

  test.each([["permission_prompt"], ["idle_prompt"], ["agent_needs_input"]])(
    "Notification(%s) records a needs-input reason sourced from the harness, not inferred",
    (type) => {
      const patch = mapped("Notification", { type });
      expect(patch.needsInputReason).toBe(type);
      expect(patch.needsInputAt).toEqual(AT);
    }
  );

  test("Notification(agent_completed) CLEARS needs-input rather than recording it as blocking", () => {
    // agent_completed reports completion, not a request for input. Recording it
    // as a needs-input reason would make the console claim the operator is
    // blocking when they are not.
    const patch = mapped("Notification", { type: "agent_completed" });
    expect(patch.needsInputReason).toBeNull();
    expect(patch.needsInputAt).toBeNull();
  });

  test("PermissionRequest is the unambiguous NEEDS INPUT (permission) source and names the tool", () => {
    const patch = mapped("PermissionRequest", { tool_name: "Bash" });
    expect(patch.needsInputReason).toBe(PERMISSION_REQUEST_REASON);
    expect(patch.needsInputTool).toBe("Bash");
    expect(patch.needsInputAt).toEqual(AT);
  });

  test.each([[EVENT_USER_PROMPT_SUBMIT], [EVENT_PRE_TOOL_USE], [EVENT_POST_TOOL_USE]])(
    "%s clears needs-input — forward progress is an observation that the block resolved",
    (eventName) => {
      const patch = mapped(eventName);
      expect(patch.needsInputReason).toBeNull();
      expect(patch.needsInputTool).toBeNull();
      expect(patch.needsInputAt).toBeNull();
    }
  );

  test("PreCompact records the trigger and reads NO token-usage field", () => {
    // The harness documents only session_id/transcript_path/cwd/
    // hook_event_name/trigger on this event. A token estimate here would be a
    // field that does not exist.
    const patch = mapped("PreCompact", { trigger: "auto" });
    expect(patch.lastCompactionTrigger).toBe("auto");
    expect(patch.lastCompactionAt).toEqual(AT);
    expect(Object.keys(patch)).toEqual(["lastCompactionTrigger", "lastCompactionAt"]);
  });

  test("PostCompact records only the completion time", () => {
    expect(mapped("PostCompact").lastCompactionEndedAt).toEqual(AT);
  });

  test("SessionEnd writes a HINT and never asserts an authoritative end", () => {
    const patch = mapped("SessionEnd", { reason: "clear" });
    expect(patch.endedHintAt).toEqual(AT);
    expect(patch.endedHintReason).toBe("clear");
    // Guard against a future edit promoting the hint into an activity claim:
    // /exit and /clear do not fire SessionEnd at all (ADR-017), so anything
    // derived from its presence would be wrong for the cleanest exits.
    expect(patch.activity).toBeUndefined();
  });

  test("an unmapped event is a no-op, not an error", () => {
    // A settings.json registration that runs ahead of its mapping, or a new
    // harness event, must degrade to "no state change" — never a crash.
    expect(mapHookEventToRunState("SomeFutureEvent", {}, AT)).toBeNull();
    expect(mapHookEventToRunState("SubagentStart", {}, AT)).toBeNull();
  });

  test("every event in OBSERVED_HOOK_EVENTS actually maps to a patch", () => {
    // The registration set and the mapping set must not drift: an event listed
    // as observed but unmapped would be registered in settings.json and then
    // silently discarded on arrival.
    for (const eventName of OBSERVED_HOOK_EVENTS) {
      expect(mapHookEventToRunState(eventName, {}, AT)).not.toBeNull();
    }
  });

  test("SessionStart is deliberately NOT observed — mt#2971 owns it (ask#5718 coordinate)", () => {
    expect(OBSERVED_HOOK_EVENTS).not.toContain(EVENT_SESSION_START);
    expect(mapHookEventToRunState(EVENT_SESSION_START, {}, AT)).toBeNull();
  });
});
