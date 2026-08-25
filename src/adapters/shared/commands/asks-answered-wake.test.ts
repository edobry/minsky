/**
 * mt#4476 AT1 — `asks.respond`'s wake write.
 *
 * Every collaborator arrives as an argument, so nothing here patches a module: the
 * sink is a factory parameter and the ask is a plain value. That shape is the reason
 * `emitAnsweredAskWakeBestEffort` lives in its own module rather than inside
 * `asks.ts`, where observing it would have required spying on the DI container
 * (`testing-standards.mdc §Testable Design`).
 */

import { describe, expect, test } from "bun:test";

import type { Ask } from "@minsky/domain/ask/types";
import type { WakeSignalPayload, WakeSignalSink } from "@minsky/domain/ask/wake-on-respond";

import {
  MAX_WAKE_ANSWER_CHARS,
  emitAnsweredAskWakeBestEffort,
  renderAnswerForWake,
} from "./asks-answered-wake";

const AGENT_ID = "com.anthropic.claude-code:conv:c8fc3ca9-c3d6-4916-bbfe-99917f4ae596";

function recordingSink(): { sink: WakeSignalSink; emitted: WakeSignalPayload[] } {
  const emitted: WakeSignalPayload[] = [];
  return {
    emitted,
    sink: {
      async emit(payload: WakeSignalPayload): Promise<void> {
        emitted.push(payload);
      },
    },
  };
}

function answeredAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "direction.decide",
    classifierVersion: "v1.0.0",
    state: "closed",
    requestor: "claude-opus-5",
    parentTaskId: "mt#4476",
    filedByAgentId: AGENT_ID,
    title: "Should the wake fire on the tool-call seam?",
    question: "…",
    response: {
      responder: "operator",
      payload: "yes — ship it",
    },
    ...overrides,
  } as Ask;
}

describe("emitAnsweredAskWakeBestEffort (mt#4476 AT1)", () => {
  test("writes a wake row carrying the filing conversation's identity and the answer", async () => {
    const { sink, emitted } = recordingSink();

    await emitAnsweredAskWakeBestEffort(async () => sink, answeredAsk());

    expect(emitted).toHaveLength(1);
    const payload = emitted[0];
    expect(payload?.kind).toBe("ask.answered");
    expect(payload?.askId).toBe("11111111-1111-4111-8111-111111111111");
    // The whole point of the task: addressed to the CONVERSATION, not to a workspace
    // session — an ordinary ask has no workspace session to key on.
    expect(payload?.agentId).toBe(AGENT_ID);
    expect(payload?.parentSessionId).toBeUndefined();
    expect(payload?.reviewBody).toBe("yes — ship it");
    expect(payload?.reviewAuthor).toBe("operator");
  });

  test("a sink failure leaves the caller's result intact (SC4)", async () => {
    const failingSink: WakeSignalSink = {
      async emit(): Promise<void> {
        // PersistentWakeSignalSink re-throws by design; the swallow has to be in the
        // wrapper, which is exactly what this asserts.
        throw new Error("wake_pending insert failed");
      },
    };

    // Resolves rather than rejects. If this ever throws, `asks.respond` fails for an
    // operator because a background delivery hint could not be written.
    await expect(
      emitAnsweredAskWakeBestEffort(async () => failingSink, answeredAsk())
    ).resolves.toBeUndefined();
  });

  test("a failure BUILDING the sink is swallowed too, not just a failure emitting", async () => {
    // The persistence provider being unresolvable is the likelier outage of the two,
    // and it happens before any sink exists — so the factory call has to be inside
    // the try, which is why `buildSink` is a factory rather than a sink.
    await expect(
      emitAnsweredAskWakeBestEffort(async () => {
        throw new Error("persistence provider unavailable");
      }, answeredAsk())
    ).resolves.toBeUndefined();
  });

  test("no identity means no row — never an unaddressable one", async () => {
    const { sink, emitted } = recordingSink();

    await emitAnsweredAskWakeBestEffort(
      async () => sink,
      answeredAsk({ filedByAgentId: undefined })
    );

    // A row keyed on neither grain matches no drain query and would sit undelivered
    // forever while every surface reported success. Not writing it is the fix; the
    // repository ALSO refuses it, so this is defence in depth rather than the only guard.
    expect(emitted).toHaveLength(0);
  });
});

describe("renderAnswerForWake (mt#4476)", () => {
  test("renders a non-string payload rather than dropping it", () => {
    expect(renderAnswerForWake({ value: "narrow-respawn" })).toBe('{"value":"narrow-respawn"}');
  });

  test("empty and absent payloads render as empty string, not 'undefined'", () => {
    expect(renderAnswerForWake(undefined)).toBe("");
    expect(renderAnswerForWake(null)).toBe("");
    expect(renderAnswerForWake("")).toBe("");
  });

  test("caps an oversized answer at the WRITE", () => {
    const long = "x".repeat(MAX_WAKE_ANSWER_CHARS * 3);

    const rendered = renderAnswerForWake(long);

    // Capping here rather than only at the render is load-bearing: `buildBlock` in the
    // wake-enrichment middleware drops an over-budget payload WHOLE rather than
    // truncating it, so an uncapped answer would not arrive clipped — it would not
    // arrive at all, with nothing to notice.
    expect(rendered.length).toBeLessThanOrEqual(MAX_WAKE_ANSWER_CHARS + 1);
    expect(rendered.endsWith("…")).toBe(true);
  });
});
