/**
 * Tests for session-film-beams.ts (mt#3231 SC 7 / AT 7).
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/lib/session-film-beams.test.ts
 */
import { describe, test, expect } from "bun:test";
import {
  beamClassName,
  beamDashArray,
  beamEndpoints,
  beamKindForAgent,
} from "./session-film-beams";

describe("beamKindForAgent — outcome physics (AT 7)", () => {
  test("a read renders a pull beam", () => {
    expect(beamKindForAgent("t1", "read", "ok")).toBe("pull");
  });

  test("a write renders a push beam", () => {
    expect(beamKindForAgent("t1", "write", "ok")).toBe("push");
  });

  test("a create renders a push beam (same physics as write)", () => {
    expect(beamKindForAgent("t1", "create", "ok")).toBe("push");
  });

  test("a search renders a fan beam, distinct from a plain read pull", () => {
    expect(beamKindForAgent("t1", "search", "ok")).toBe("fan");
  });

  test("a delete renders the loud beam, distinct from an ordinary push", () => {
    expect(beamKindForAgent("t1", "delete", "ok")).toBe("loud");
  });

  test("an error outcome renders bounce regardless of verb", () => {
    expect(beamKindForAgent("t1", "write", "error")).toBe("bounce");
    expect(beamKindForAgent("t1", "read", "error")).toBe("bounce");
  });

  test("a denied outcome renders the policy beam regardless of verb", () => {
    expect(beamKindForAgent("t1", "write", "denied")).toBe("policy");
  });

  test("no current target -> no beam", () => {
    expect(beamKindForAgent(null, "read", "ok")).toBeNull();
  });

  test("a conversational verb (think/wait/speak/ask/respond) never beams", () => {
    expect(beamKindForAgent("agents:x", "think", "ok")).toBeNull();
    expect(beamKindForAgent("agents:x", "wait", "ok")).toBeNull();
    expect(beamKindForAgent("agents:x", "speak", "ok")).toBeNull();
  });

  test("pull/push/fan/loud/bounce/policy are all mutually distinct kinds", () => {
    const kinds = new Set([
      beamKindForAgent("t", "read", "ok"),
      beamKindForAgent("t", "write", "ok"),
      beamKindForAgent("t", "search", "ok"),
      beamKindForAgent("t", "delete", "ok"),
      beamKindForAgent("t", "write", "error"),
      beamKindForAgent("t", "write", "denied"),
    ]);
    expect(kinds.size).toBe(6);
  });
});

describe("beamEndpoints — direction (AT 7)", () => {
  const home = { x: 0, y: 0 };
  const target = { x: 100, y: 50 };

  test("pull runs target -> home (energy flows toward the agent)", () => {
    const ends = beamEndpoints("pull", home, target);
    expect(ends).toEqual({ x1: 100, y1: 50, x2: 0, y2: 0 });
  });

  test("push runs home -> target", () => {
    const ends = beamEndpoints("push", home, target);
    expect(ends).toEqual({ x1: 0, y1: 0, x2: 100, y2: 50 });
  });

  test("bounce and policy also run home -> target (the failed/blocked attempt direction)", () => {
    expect(beamEndpoints("bounce", home, target)).toEqual({ x1: 0, y1: 0, x2: 100, y2: 50 });
    expect(beamEndpoints("policy", home, target)).toEqual({ x1: 0, y1: 0, x2: 100, y2: 50 });
  });
});

describe("beamClassName / beamDashArray — visually distinct treatments (AT 7)", () => {
  test("failure kinds (loud/bounce/policy) use the warn-red token, not signal-cyan", () => {
    expect(beamClassName("loud")).toContain("warn-red");
    expect(beamClassName("bounce")).toContain("warn-red");
    expect(beamClassName("policy")).toContain("warn-red");
  });

  test("ordinary action kinds (pull/push/fan) use the signal-cyan token", () => {
    expect(beamClassName("pull")).toContain("signal-cyan");
    expect(beamClassName("push")).toContain("signal-cyan");
    expect(beamClassName("fan")).toContain("signal-cyan");
  });

  test("fan/policy/bounce each carry their own distinct dash pattern; pull/push/loud are solid", () => {
    const dashes = [beamDashArray("fan"), beamDashArray("policy"), beamDashArray("bounce")];
    expect(new Set(dashes).size).toBe(3);
    expect(beamDashArray("pull")).toBeUndefined();
    expect(beamDashArray("push")).toBeUndefined();
    expect(beamDashArray("loud")).toBeUndefined();
  });
});
