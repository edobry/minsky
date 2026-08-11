/**
 * mt#3945 — `cc_conversation_id` is derived from `actor_id`, not from a
 * spawn-frozen env var.
 *
 * The defect these cover: `writeTaskClaim` read `CC_CONVERSATION_ID`, which
 * nothing sets (0 of 6076 task rows in prod ever carried a value), and
 * `writeSessionAttachment` read `CLAUDE_CODE_SESSION_ID`, captured once at
 * process spawn and never re-read — so it went stale on the first `/clear` and
 * stayed stale. mt#3900 made `actor_id` resolve live and left both of these
 * frozen, which is what turned their prior agreement into a coming divergence.
 */
import { describe, test, expect } from "bun:test";
import { resolvePresenceConversationId } from "./presence-conversation";

const CONV = "8f3a2d1b-4c5e-4a6f-9b7c-0d1e2f3a4b5c";
const OTHER = "9c4e5f2a-1b2c-4d3e-8f9a-0b1c2d3e4f5a";
const CLAUDE_CODE = "com.anthropic.claude-code";
/** A Layer-1 ascribed actor — names a process, never a conversation. */
const ASCRIBED = "unknown:hash:3defa5b5675196ca";

describe("resolvePresenceConversationId", () => {
  test("derives the conversation from a conversation-scoped actorId", () => {
    expect(resolvePresenceConversationId(`${CLAUDE_CODE}:conv:${CONV}`)).toBe(CONV);
  });

  test("the derived value wins over a stale ambient env value", () => {
    // The regression this whole task exists for: after a `/clear`, `actorId`
    // carries the CURRENT conversation while the env var still holds the one
    // that was live when the server process spawned. Taking the env value here
    // is what recorded an agent's work under a stranger's id.
    expect(resolvePresenceConversationId(`${CLAUDE_CODE}:conv:${CONV}`, OTHER)).toBe(CONV);
  });

  test("a delegation chain does not leak the parent id into the value", () => {
    // `{kind}:{scope}:{id}@{parent-agentId}` is legal on any id, so a naive
    // `:conv:` split would return "<uuid>@com.anthropic...".
    expect(
      resolvePresenceConversationId(`${CLAUDE_CODE}:conv:${CONV}@${CLAUDE_CODE}:proc:abc123`)
    ).toBe(CONV);
  });

  test("falls back to the ambient value for a Layer-1 ascribed actor", () => {
    // 113 prod rows are exactly this case: `actor_id` names no conversation, so
    // the env var is the only signal there is. Preserving it is why the read
    // was not simply deleted.
    expect(resolvePresenceConversationId(ASCRIBED, CONV)).toBe(CONV);
  });

  test("returns undefined when neither source names a conversation", () => {
    expect(resolvePresenceConversationId(ASCRIBED)).toBeUndefined();
    expect(resolvePresenceConversationId(ASCRIBED, "")).toBeUndefined();
  });

  test("a subagent's compound id is not unwrapped to its parent conversation", () => {
    // `conv:<parent>/task:<sub-id>` names a subagent, not a conversation.
    // Returning `<parent>` would assert the subagent's claim belongs to the
    // parent conversation — a different, unasserted claim.
    expect(resolvePresenceConversationId(`${CLAUDE_CODE}:conv:${CONV}/task:sub-7`)).toBeUndefined();
  });

  test("a malformed actorId falls through to the ambient value rather than throwing", () => {
    expect(resolvePresenceConversationId("not-an-agent-id", CONV)).toBe(CONV);
    expect(resolvePresenceConversationId("", CONV)).toBe(CONV);
  });
});
