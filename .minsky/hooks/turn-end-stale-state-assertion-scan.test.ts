/**
 * Tests for the stale-state-assertion Stop scan (mt#4199).
 *
 * The guard is two halves and they are tested separately on purpose:
 *
 *  - `findPendingClaims` — the IO-free gate that decides whether a substrate
 *    read happens at all. Every precision property lives here.
 *  - `classifyResolved` — the pure terminal-vs-open decision, driven by two
 *    state maps rather than by a patched database (the `/implement-task` §6
 *    testable-design split).
 *
 * The acceptance tests in mt#4199's spec are named in the test titles they map
 * to, so a reader can check coverage against the spec without inferring it.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyResolved,
  collectAssertions,
  collectEntityRefs,
  findPendingClaims,
  PROXIMITY_CHARS,
  TERMINAL_ASK_STATES,
} from "./turn-end-stale-state-assertion-scan";

/** The literal shape of mem#669 R17's closing message — the originating case. */
const R17_MESSAGE =
  "mt#3711 is merged and live. Nothing else outstanding.\n\n" +
  "Still with you: ask#8467 — what mt#2430 should deliver now that the RFC option was declined.";

describe("collectEntityRefs", () => {
  test("collects bare ask and task refs with their offsets", () => {
    const refs = collectEntityRefs("see ask#8467 and mt#2430");

    expect(refs.map((r) => `${r.kind}:${r.id}`)).toEqual(["ask:8467", "task:mt#2430"]);
    expect(refs[0]?.at).toBeLessThan(refs[1]?.at ?? 0);
  });

  test("collects minsky:// link targets too — the union the planning audit required", () => {
    // A correctly-LINKED ref is the case `scanMessage`'s findings do not carry;
    // missing it would make the guard blind to exactly the well-formed messages
    // the cockpit-deeplink rules ask for.
    const refs = collectEntityRefs("[ask#8467](minsky://ask/2f747fc3-70e4-4e3c-952c-4af9c1eed01d)");

    expect(refs.some((r) => r.kind === "ask" && r.id === "8467")).toBe(true);
    expect(refs.some((r) => r.id.startsWith("2f747fc3"))).toBe(true);
  });

  test("ignores mem# and ws# — neither has a state that can await the principal", () => {
    expect(collectEntityRefs("see mem#669 and ws#372")).toEqual([]);
  });

  test("dedupes repeated refs to the same entity", () => {
    const refs = collectEntityRefs("ask#8467 ... ask#8467 again");
    expect(refs).toHaveLength(1);
  });
});

describe("collectAssertions", () => {
  test("matches the R17 phrasing", () => {
    const found = collectAssertions(R17_MESSAGE);
    expect(found.map((a) => a.family)).toContain("still-with-you");
  });

  test("matches the paraphrases the family produces", () => {
    for (const phrase of [
      "this is waiting on you",
      "it needs your decision",
      "awaiting your answer",
      "that remains your call",
      "sitting in your inbox",
    ]) {
      expect(collectAssertions(phrase).length).toBeGreaterThan(0);
    }
  });

  test("does not match an ordinary status sentence", () => {
    expect(collectAssertions("I merged it and the deploy is healthy.")).toEqual([]);
  });
});

describe("findPendingClaims — the gate", () => {
  test("AT1 gate — the R17 message produces a claim naming the ask", () => {
    const claims = findPendingClaims(R17_MESSAGE);

    const askClaim = claims.find((c) => c.entity.kind === "ask");
    expect(askClaim).toBeDefined();
    expect(askClaim?.entity.id).toBe("8467");
    expect(askClaim?.assertion.family).toBe("still-with-you");
  });

  test("AT3 — a ref with no pending-on-principal claim produces nothing", () => {
    // The ref is present and correctly linked; nothing asserts it needs anyone.
    const claims = findPendingClaims(
      "Merged [ask#8467](minsky://ask/2f747fc3) as part of the cleanup. Nothing outstanding."
    );
    expect(claims).toEqual([]);
  });

  test("a pending phrase with no entity ref produces nothing", () => {
    expect(findPendingClaims("One thing is still with you — the naming call.")).toEqual([]);
  });

  test("proximity is required: a ref far from the phrase is not captured", () => {
    const far = `Still with you: the naming decision.\n\n${"x".repeat(PROXIMITY_CHARS + 50)}\n\nSeparately, ask#8467 is closed.`;
    expect(findPendingClaims(far)).toEqual([]);
  });

  test("a quoted or fenced ref does not trip the gate", () => {
    // A turn DISCUSSING this guard, or quoting a prior message, must not fire —
    // the same elision discipline the incident-scan sibling uses.
    const quoted = "The old message said:\n\n> Still with you: ask#8467\n\nThat was the bug.";
    expect(findPendingClaims(quoted)).toEqual([]);
  });
});

describe("classifyResolved — the substrate decision", () => {
  const claims = findPendingClaims(R17_MESSAGE);

  test("AT1 — a closed ask asserted as pending is a contradiction", () => {
    const resolved = classifyResolved(claims, new Map([["8467", "closed"]]), new Map());

    const ask = resolved.find((r) => r.entity.kind === "ask");
    expect(ask?.isTerminal).toBe(true);
    expect(ask?.liveState).toBe("closed");
    // The record must name the ref, what was asserted, and what is true.
    expect(ask?.entity.ref).toBe("ask#8467");
    expect(ask?.assertion.phrase.toLowerCase()).toContain("still with you");
  });

  test("AT2 — a suspended or routed ask is NOT a contradiction", () => {
    for (const openState of ["suspended", "routed"]) {
      const resolved = classifyResolved(claims, new Map([["8467", openState]]), new Map());
      expect(resolved.find((r) => r.entity.kind === "ask")?.isTerminal).toBe(false);
    }
  });

  test("every terminal ask state is treated as terminal", () => {
    for (const state of TERMINAL_ASK_STATES) {
      const resolved = classifyResolved(claims, new Map([["8467", state]]), new Map());
      expect(resolved.find((r) => r.entity.kind === "ask")?.isTerminal).toBe(true);
    }
  });

  test("AT4 — a task asserted as blocked on the principal, but DONE, is a contradiction", () => {
    const taskClaims = findPendingClaims("mt#2430 is still blocked on your decision.");
    const resolved = classifyResolved(taskClaims, new Map(), new Map([["mt#2430", "DONE"]]));

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.isTerminal).toBe(true);
    expect(resolved[0]?.liveState).toBe("DONE");
  });

  test("a task still in PLANNING is not a contradiction", () => {
    const taskClaims = findPendingClaims("mt#2430 is still blocked on your decision.");
    const resolved = classifyResolved(taskClaims, new Map(), new Map([["mt#2430", "PLANNING"]]));

    expect(resolved[0]?.isTerminal).toBe(false);
  });

  test("a ref the substrate cannot resolve is DROPPED, not treated as terminal", () => {
    // The failure direction that matters: an unresolved row must never become a
    // finding, or a lookup miss manufactures a contradiction.
    expect(classifyResolved(claims, new Map(), new Map())).toEqual([]);
  });
});
