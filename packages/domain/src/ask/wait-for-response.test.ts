/**
 * Tests for ask wait-for-response (mt#2266).
 *
 * The agent-side blocking primitive: file an ask, wait, resume on response.
 * Covers the three outcomes (resolved / terminal-without-response / timeout),
 * the not-found path, and the clamp + at-least-one-poll contract — all with
 * an injected clock + sleep so no real time passes.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { askWaitForResponse } from "./wait-for-response";
import { FakeAskRepository } from "./repository";
import { ResourceNotFoundError, MinskyError } from "../errors/index";
import type { Ask, AskState } from "./types";

let repo: FakeAskRepository;

beforeEach(() => {
  repo = new FakeAskRepository();
});

async function seedAsk(state: AskState, overrides: Partial<Ask> = {}): Promise<Ask> {
  const created = await repo.create({
    kind: "direction.decide",
    classifierVersion: "v1",
    requestor: "test-agent:proc:abc123",
    title: "wait-for-response fixture",
    question: "Pick A or B?",
    windowMissedCount: 0,
    forceImmediate: false,
  });
  const seeded: Ask = { ...created, state, ...overrides };
  repo._seedAtState(seeded);
  return seeded;
}

/**
 * A controllable clock + sleep: each `sleep(ms)` advances the virtual clock
 * by `ms`. Lets the polling loop run to timeout instantly.
 */
function makeVirtualClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("askWaitForResponse", () => {
  it("resolves immediately when the ask is already responded", async () => {
    const response = { responder: "operator" as const, payload: { chosen: "A" } };
    await seedAsk("responded", { response, respondedAt: new Date().toISOString() });
    const clock = makeVirtualClock();

    const result = await askWaitForResponse(
      { id: "fake-ask-1" },
      { repo, now: clock.now, sleep: clock.sleep }
    );

    expect(result.resolved).toBe(true);
    if (!result.resolved) throw new Error("expected resolved");
    expect(result.state).toBe("responded");
    expect(result.response.payload).toEqual({ chosen: "A" });
    expect(result.pollCount).toBe(1);
  });

  it("resolves when the ask is closed (policy/operator close) and returns the response", async () => {
    const response = {
      responder: "policy" as const,
      payload: { citation: { source: "CLAUDE.md" } },
    };
    await seedAsk("closed", { response, closedAt: new Date().toISOString() });
    const clock = makeVirtualClock();

    const result = await askWaitForResponse(
      { id: "fake-ask-1" },
      { repo, now: clock.now, sleep: clock.sleep }
    );

    expect(result.resolved).toBe(true);
    if (!result.resolved) throw new Error("expected resolved");
    expect(result.state).toBe("closed");
    expect(result.response.responder).toBe("policy");
  });

  it("returns terminal-without-response immediately for a cancelled ask (no blocking)", async () => {
    await seedAsk("cancelled", { closedAt: new Date().toISOString() });
    const clock = makeVirtualClock();

    const result = await askWaitForResponse(
      { id: "fake-ask-1", timeoutSeconds: 600 },
      { repo, now: clock.now, sleep: clock.sleep }
    );

    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("expected unresolved");
    expect(result.terminal).toBe(true);
    expect(result.lastState).toBe("cancelled");
    // Returned on the first poll — did not block to timeout.
    expect(result.pollCount).toBe(1);
    expect(result.elapsedMs).toBe(0);
  });

  it("returns terminal-without-response for an expired ask", async () => {
    await seedAsk("expired", { closedAt: new Date().toISOString() });
    const clock = makeVirtualClock();

    const result = await askWaitForResponse(
      { id: "fake-ask-1" },
      { repo, now: clock.now, sleep: clock.sleep }
    );

    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("expected unresolved");
    expect(result.terminal).toBe(true);
    expect(result.lastState).toBe("expired");
  });

  it("times out (terminal:false) while the ask stays suspended", async () => {
    await seedAsk("suspended", { suspendedAt: new Date().toISOString() });
    const clock = makeVirtualClock();

    const result = await askWaitForResponse(
      { id: "fake-ask-1", timeoutSeconds: 30, intervalSeconds: 5 },
      { repo, now: clock.now, sleep: clock.sleep }
    );

    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("expected unresolved");
    expect(result.terminal).toBe(false);
    expect(result.lastState).toBe("suspended");
    // 30s timeout / 5s interval → polls until the deadline.
    expect(result.pollCount).toBeGreaterThan(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(30_000);
  });

  it("resolves mid-wait when the ask transitions to responded between polls", async () => {
    await seedAsk("suspended", { suspendedAt: new Date().toISOString() });
    const clock = makeVirtualClock();

    // After the 2nd poll's sleep, flip the ask to responded.
    let pollObserved = 0;
    const countingSleep = async (ms: number) => {
      pollObserved += 1;
      if (pollObserved === 2) {
        const current = await repo.getById("fake-ask-1");
        if (!current) throw new Error("fixture vanished mid-test");
        repo._seedAtState({
          ...current,
          state: "responded",
          response: { responder: "operator", payload: { chosen: "B" } },
          respondedAt: new Date().toISOString(),
        });
      }
      clock.advance(ms);
    };

    const result = await askWaitForResponse(
      { id: "fake-ask-1", timeoutSeconds: 600, intervalSeconds: 5 },
      { repo, now: clock.now, sleep: countingSleep }
    );

    expect(result.resolved).toBe(true);
    if (!result.resolved) throw new Error("expected resolved");
    expect(result.state).toBe("responded");
    expect(result.response.payload).toEqual({ chosen: "B" });
    // Resolved on the 3rd poll (after the 2nd sleep flipped it).
    expect(result.pollCount).toBe(3);
  });

  it("throws ResourceNotFoundError when the ask does not exist", async () => {
    const clock = makeVirtualClock();
    await expect(
      askWaitForResponse({ id: "nonexistent" }, { repo, now: clock.now, sleep: clock.sleep })
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("throws on empty id", async () => {
    const clock = makeVirtualClock();
    await expect(
      askWaitForResponse({ id: "   " }, { repo, now: clock.now, sleep: clock.sleep })
    ).rejects.toBeInstanceOf(MinskyError);
  });

  it("guarantees at least one poll even on a 1s timeout budget", async () => {
    await seedAsk("suspended", { suspendedAt: new Date().toISOString() });
    const clock = makeVirtualClock();

    const result = await askWaitForResponse(
      { id: "fake-ask-1", timeoutSeconds: 1, intervalSeconds: 5 },
      { repo, now: clock.now, sleep: clock.sleep }
    );

    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("expected unresolved");
    expect(result.pollCount).toBe(1);
  });

  it("clamps an over-cap timeout to 1800s (does not hang on a huge value)", async () => {
    // A suspended ask + tiny interval; with the virtual clock each sleep
    // advances time, so the loop terminates at the clamped 1800s deadline.
    await seedAsk("suspended", { suspendedAt: new Date().toISOString() });
    const clock = makeVirtualClock();

    const result = await askWaitForResponse(
      { id: "fake-ask-1", timeoutSeconds: 100_000, intervalSeconds: 60 },
      { repo, now: clock.now, sleep: clock.sleep }
    );

    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("expected unresolved");
    expect(result.terminal).toBe(false);
    // Clamped to 1800s — elapsed should be at/just past 1800s, not 100000s.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1_800_000);
    expect(result.elapsedMs).toBeLessThan(1_900_000);
  });

  describe("mt#1576 — the poll loop emits MCP transport progress", () => {
    it("emits once per poll, so a long wait is not silent to the transport", async () => {
      // Before mt#1576 this loop emitted only `log.debug`, which never reaches
      // the transport — so the connection looked IDLE and was killed at
      // roughly three minutes regardless of the 1800s ceiling below.
      await seedAsk("suspended", { suspendedAt: new Date().toISOString() });
      const clock = makeVirtualClock();
      const messages: string[] = [];

      const result = await askWaitForResponse(
        { id: "fake-ask-1", timeoutSeconds: 300, intervalSeconds: 60 },
        { repo, now: clock.now, sleep: clock.sleep, onProgress: (m) => messages.push(m) }
      );

      expect(result.resolved).toBe(false);
      // 300s of budget at a 60s interval — one emission per idle window. The
      // property that matters is "more than zero, one per window", not the
      // exact count, so this asserts the shape rather than pinning arithmetic.
      expect(messages.length).toBeGreaterThanOrEqual(4);
      expect(messages[0]).toContain("fake-ask-1");
      expect(messages[0]).toContain("suspended");
    });

    it("emits nothing when the ask already has a response — no poll, no window", async () => {
      // A wait that returns immediately never opens an idle window, so there
      // is nothing to keep alive. Emitting anyway would be noise.
      await seedAsk("responded", {
        response: { responder: "operator", payload: { chosen: "A" } },
      });
      const clock = makeVirtualClock();
      const messages: string[] = [];

      const result = await askWaitForResponse(
        { id: "fake-ask-1", timeoutSeconds: 300, intervalSeconds: 60 },
        { repo, now: clock.now, sleep: clock.sleep, onProgress: (m) => messages.push(m) }
      );

      expect(result.resolved).toBe(true);
      expect(messages).toEqual([]);
    });

    it("omitting onProgress leaves the wait working — the CLI path", async () => {
      await seedAsk("suspended", { suspendedAt: new Date().toISOString() });
      const clock = makeVirtualClock();

      const result = await askWaitForResponse(
        { id: "fake-ask-1", timeoutSeconds: 120, intervalSeconds: 60 },
        { repo, now: clock.now, sleep: clock.sleep }
      );

      expect(result.resolved).toBe(false);
    });

    it("a throwing reporter is swallowed rather than aborting the wait", async () => {
      // Best-effort: the reporter exists to keep the wait alive, so it must
      // never be the thing that kills it.
      await seedAsk("suspended", { suspendedAt: new Date().toISOString() });
      const clock = makeVirtualClock();

      const result = await askWaitForResponse(
        { id: "fake-ask-1", timeoutSeconds: 120, intervalSeconds: 60 },
        {
          repo,
          now: clock.now,
          sleep: clock.sleep,
          onProgress: () => {
            throw new Error("reporter exploded");
          },
        }
      );

      expect(result.resolved).toBe(false);
      if (result.resolved) throw new Error("expected unresolved");
      expect(result.terminal).toBe(false);
    });
  });
});
