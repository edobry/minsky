/**
 * Tests for the ask -> conversation stamp hook (mt#3564).
 *
 * ## Why these build payloads through `normalizeToolResult`
 *
 * This hook's direct precedent, `stamp-session-creator-link.ts`, wrote ZERO rows against
 * 235 sessions because it read `tool_result` while production sends `tool_response`
 * (mt#3182). It stayed green because its unit tests HAND-BUILT a `tool_result` — a
 * payload production never produces — so the suite could not observe the defect.
 *
 * Every test here therefore constructs the payload the way the harness actually sends
 * it (`tool_response` carrying the MCP content envelope, a JSON string inside a text
 * block) and runs it through `normalizeToolResult`, which is what `readInput` applies in
 * production. If that normalization regresses, these tests go red rather than this hook
 * silently going dead.
 */
/* eslint-disable custom/no-real-fs-in-tests -- these tests write and read the REAL attribution map through an isolated mkdtemp dir. The whole point of this suite is that the store roundtrips on a real filesystem; a mock fs would test the mock. Precedent: ask-routing-deferral-detector.test.ts. */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeToolResult } from "./types";
import type { ToolHookInput } from "./types";
import { resolveCreatedAsk, isOverridden, stampAskConversation } from "./stamp-ask-conversation";
import { readAskConversationMap } from "./ask-conversation-map";

const ASK_ID = "2422ee3c-7e28-49d0-88f2-bbabbed6c65e";
const CONVERSATION_ID = "c8fc3ca9-c3d6-4916-bbfe-99917f4ae596";
const NOW = "2026-08-22T12:00:00.000Z";
const ASKS_CREATE_TOOL = "mcp__minsky__asks_create";

let dir: string;
let mapPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mt3564-stamp-"));
  mapPath = join(dir, "ask-conversation-map.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Build the payload production sends for an MCP tool call, then normalize it exactly as
 * `readInput` does. `result` is stringified into a text content block — the shape
 * `normalizeToolResult`'s docblock records as measured from real captures.
 */
function productionPayload(result: unknown, sessionId: string | null = CONVERSATION_ID) {
  // `null`, not `undefined`, is the omit signal: a default parameter is applied when
  // `undefined` is passed EXPLICITLY, so `productionPayload(x, undefined)` would have
  // silently supplied the default conversation id and made the no-conversation test
  // assert the opposite of what it reads as.
  const payload: Record<string, unknown> = {
    hook_event_name: "PostToolUse",
    tool_name: ASKS_CREATE_TOOL,
    tool_input: {},
    tool_response: [{ type: "text", text: JSON.stringify(result) }],
    ...(sessionId === null ? {} : { session_id: sessionId }),
  };
  normalizeToolResult(payload);
  return payload as unknown as ToolHookInput;
}

describe("resolveCreatedAsk (against the production envelope)", () => {
  test("resolves id and shortId from a real asks_create success shape", () => {
    const input = productionPayload({
      id: ASK_ID,
      shortId: "ask#8014",
      kind: "direction.decide",
      state: "suspended",
      formWarnings: [],
    });
    expect(resolveCreatedAsk(input)).toEqual({ askId: ASK_ID, shortId: "ask#8014" });
  });

  test("resolves without a shortId when the result omits it", () => {
    const input = productionPayload({ id: ASK_ID, state: "routed" });
    expect(resolveCreatedAsk(input)).toEqual({ askId: ASK_ID });
  });

  test("returns null when the id is not a uuid — a map keyed on it would be meaningless", () => {
    expect(resolveCreatedAsk(productionPayload({ id: "ask#8014" }))).toBeNull();
    expect(resolveCreatedAsk(productionPayload({ id: "" }))).toBeNull();
  });

  test("returns null on an error-shaped result with no id", () => {
    expect(resolveCreatedAsk(productionPayload({ error: "boom" }))).toBeNull();
  });

  test("returns null when the envelope carries non-JSON text", () => {
    const payload: Record<string, unknown> = {
      hook_event_name: "PostToolUse",
      tool_name: ASKS_CREATE_TOOL,
      tool_input: {},
      session_id: CONVERSATION_ID,
      tool_response: [{ type: "text", text: "not json at all" }],
    };
    normalizeToolResult(payload);
    expect(resolveCreatedAsk(payload as unknown as ToolHookInput)).toBeNull();
  });

  test("NEGATIVE CONTROL: an un-normalized production payload resolves nothing", () => {
    // This is the mt#3182 defect reproduced deliberately. Skipping normalization is
    // exactly what the broken precedent did; if this ever starts resolving, the
    // normalization has moved somewhere this hook does not depend on, and the test
    // above stops being evidence that production works.
    const raw: Record<string, unknown> = {
      hook_event_name: "PostToolUse",
      tool_name: ASKS_CREATE_TOOL,
      tool_input: {},
      session_id: CONVERSATION_ID,
      tool_response: [{ type: "text", text: JSON.stringify({ id: ASK_ID }) }],
    };
    expect(resolveCreatedAsk(raw as unknown as ToolHookInput)).toBeNull();
  });
});

describe("isOverridden", () => {
  test("false when MINSKY_HOOK_OVERRIDE is unset or names another guard", () => {
    expect(isOverridden({})).toBe(false);
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "some-other-guard" })).toBe(false);
  });

  test("true for the guard name, for `all`, and inside a comma-separated list", () => {
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "stamp-ask-conversation" })).toBe(true);
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "all" })).toBe(true);
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "a, stamp-ask-conversation ,b" })).toBe(true);
  });
});

describe("stampAskConversation", () => {
  test("writes the attribution for a real create payload", () => {
    const input = productionPayload({ id: ASK_ID, shortId: "ask#8014" });
    expect(stampAskConversation(input, NOW, mapPath, {})).toBe("written");

    const entry = readAskConversationMap(mapPath).entries[ASK_ID];
    expect(entry?.conversationId).toBe(CONVERSATION_ID);
    expect(entry?.shortId).toBe("ask#8014");
    expect(entry?.recordedAt).toBe(NOW);
  });

  test("no-ops when the harness supplied no conversation id", () => {
    const input = productionPayload({ id: ASK_ID }, null);
    expect(input.session_id).toBeUndefined();
    expect(stampAskConversation(input, NOW, mapPath, {})).toBe("no-conversation");
  });

  test("no-ops when the result carries no resolvable ask", () => {
    const input = productionPayload({ error: "nope" });
    expect(stampAskConversation(input, NOW, mapPath, {})).toBe("unresolvable");
  });

  test("respects the override without touching the map", () => {
    const input = productionPayload({ id: ASK_ID });
    expect(stampAskConversation(input, NOW, mapPath, { MINSKY_HOOK_OVERRIDE: "all" })).toBe(
      "overridden"
    );
    expect(readAskConversationMap(mapPath).entries[ASK_ID]).toBeUndefined();
  });

  test("reports write-failed rather than throwing when the map path is unwritable", () => {
    const blocked = join(dir, "blocked-dir");
    require("node:fs").mkdirSync(blocked, { recursive: true });
    const input = productionPayload({ id: ASK_ID });
    expect(stampAskConversation(input, NOW, blocked, {})).toBe("write-failed");
  });
});
