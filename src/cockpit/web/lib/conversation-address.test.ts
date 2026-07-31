/**
 * Route-id resolution across both id spaces (mt#3132 Success Criterion 6,
 * Acceptance Test 5).
 *
 * Pure — no React, no router, no DOM. The property under test is that
 * resolution is a REGISTRY LOOKUP and never an id-shape guess, which is what
 * mt#3132's `## Implementation-entry findings` corrected in the spec's own
 * id-space section.
 */
import { describe, test, expect } from "bun:test";
import {
  actuatorMayStillLink,
  resolveConversationAddress,
  type ActuatorSummary,
} from "./conversation-address";

const CONVERSATION_UUID = "2154425b-1e39-4a6f-9f0e-6b3b1a2c4d5e";
/** A DEFAULT local id: `randomUUID()`, so it is uuid-shaped like a real one. */
const UUID_SHAPED_LOCAL_ID = "39d94344-36ad-4a17-b8b3-d35dd8f50714";
/** An entity-thread local id: NOT uuid-shaped. */
const PREFIXED_LOCAL_ID = "task-mt3132-thread";
/** The address kind under test throughout — the pre-`init` window. */
const STARTING = "actuator-starting";

function actuator(over: Partial<ActuatorSummary> = {}): ActuatorSummary {
  return { sessionId: UUID_SHAPED_LOCAL_ID, harnessSessionId: null, status: "running", ...over };
}

describe("resolveConversationAddress", () => {
  test("an id in no registry row is a plain conversation — the common path, unchanged", () => {
    const address = resolveConversationAddress(CONVERSATION_UUID, []);
    expect(address).toEqual({
      kind: "conversation",
      conversationId: CONVERSATION_UUID,
      actuator: null,
    });
  });

  test("a local id with no harness id yet is a STARTING ACTUATOR, not a 404 (AT5)", () => {
    // The pre-`init` window. There is no conversation id to translate to, so
    // this cannot be served by any amount of id mapping.
    const record = actuator();
    const address = resolveConversationAddress(UUID_SHAPED_LOCAL_ID, [record]);
    expect(address).toEqual({
      kind: STARTING,
      localId: UUID_SHAPED_LOCAL_ID,
      actuator: record,
    });
  });

  test("resolution is by REGISTRY, not by id shape", () => {
    // The whole point of the spec's Implementation-entry correction: this local
    // id is uuid-shaped, so every shape check passes it. Only the registry
    // knows it addresses an actuator rather than a transcript.
    const shapeCheck = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(shapeCheck.test(UUID_SHAPED_LOCAL_ID)).toBe(true);
    expect(resolveConversationAddress(UUID_SHAPED_LOCAL_ID, [actuator()]).kind).toBe(STARTING);
    // ...and the same id resolves to a plain conversation when no row claims it.
    expect(resolveConversationAddress(UUID_SHAPED_LOCAL_ID, []).kind).toBe("conversation");
  });

  test("a non-uuid local id resolves the same way — both spawn shapes are real", () => {
    const record = actuator({ sessionId: PREFIXED_LOCAL_ID });
    expect(resolveConversationAddress(PREFIXED_LOCAL_ID, [record]).kind).toBe(STARTING);
  });

  test("a linked local id translates to its conversation and stays a valid address", () => {
    const record = actuator({ harnessSessionId: CONVERSATION_UUID });
    const address = resolveConversationAddress(UUID_SHAPED_LOCAL_ID, [record]);
    expect(address).toEqual({
      kind: "conversation",
      conversationId: CONVERSATION_UUID,
      actuator: record,
    });
  });

  test("the conversation uuid itself resolves, carrying its actuator", () => {
    const record = actuator({ harnessSessionId: CONVERSATION_UUID });
    const address = resolveConversationAddress(CONVERSATION_UUID, [record]);
    expect(address).toEqual({
      kind: "conversation",
      conversationId: CONVERSATION_UUID,
      actuator: record,
    });
  });

  test("local id wins over harness id, matching registry.get()'s own precedence", () => {
    const collides = "collision-id";
    const byLocal = actuator({ sessionId: collides, harnessSessionId: null });
    const byHarness = actuator({ sessionId: "other-local", harnessSessionId: collides });
    // `byLocalId.get(id) ?? byHarnessId.get(id)` — local first.
    expect(resolveConversationAddress(collides, [byHarness, byLocal]).kind).toBe(STARTING);
  });

  test("ignores unrelated rows", () => {
    const others = [
      actuator({ sessionId: "unrelated-1" }),
      actuator({ sessionId: "unrelated-2", harnessSessionId: "some-other-conversation" }),
    ];
    expect(resolveConversationAddress(CONVERSATION_UUID, others)).toEqual({
      kind: "conversation",
      conversationId: CONVERSATION_UUID,
      actuator: null,
    });
  });
});

describe("actuatorMayStillLink", () => {
  test("a running or spawned actuator may still produce a conversation", () => {
    expect(actuatorMayStillLink(actuator({ status: "running" }))).toBe(true);
    expect(actuatorMayStillLink(actuator({ status: "spawned" }))).toBe(true);
  });

  test("a terminal actuator that never linked never will", () => {
    // Rendering "starting…" forever for one of these would be exactly the
    // falsely-confident state this umbrella exists to remove.
    expect(actuatorMayStillLink(actuator({ status: "exited" }))).toBe(false);
    expect(actuatorMayStillLink(actuator({ status: "crashed" }))).toBe(false);
  });
});
