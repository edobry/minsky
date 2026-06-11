/**
 * Tests for the entity-tab route matcher (mt#2398, extended mt#1919).
 */
import { describe, test, expect } from "bun:test";
import { matchEntityRoute } from "./tabs";

describe("matchEntityRoute", () => {
  test("matches /session/:id as kind session (harness agentSessionId)", () => {
    const tab = matchEntityRoute("/session/4d44d12b-58f0-433e-95b3-8b914693fa39");
    expect(tab?.kind).toBe("session");
    expect(tab?.entityId).toBe("4d44d12b-58f0-433e-95b3-8b914693fa39");
    expect(tab?.label).toBe("4d44d12b…");
  });

  test("matches /agents/:id as kind agent (Minsky workspace sessionId)", () => {
    const tab = matchEntityRoute("/agents/561a8568-cb5e-44d0-bcee-bf8c8da2f011");
    expect(tab?.kind).toBe("agent");
    expect(tab?.entityId).toBe("561a8568-cb5e-44d0-bcee-bf8c8da2f011");
    expect(tab?.label).toBe("561a8568…");
  });

  test("short agent id is not truncated", () => {
    const tab = matchEntityRoute("/agents/abc123");
    expect(tab?.label).toBe("abc123");
  });

  test("URL-encoded agent id is decoded", () => {
    const tab = matchEntityRoute("/agents/foo%20bar");
    expect(tab?.entityId).toBe("foo bar");
  });

  test("matches /tasks/:id as kind task", () => {
    const tab = matchEntityRoute("/tasks/mt%231919");
    expect(tab?.kind).toBe("task");
    expect(tab?.entityId).toBe("mt#1919");
  });

  test("matches /ask/:id as kind ask (mt#2410)", () => {
    const tab = matchEntityRoute("/ask/0a1b2c3d-0000-0000-0000-000000000000");
    expect(tab?.kind).toBe("ask");
    expect(tab?.entityId).toBe("0a1b2c3d-0000-0000-0000-000000000000");
    expect(tab?.label).toBe("0a1b2c3d…");
  });

  test("matches /memory/:id as kind memory (mt#2410)", () => {
    const tab = matchEntityRoute("/memory/d4e5f6a7-0000-0000-0000-000000000000");
    expect(tab?.kind).toBe("memory");
    expect(tab?.entityId).toBe("d4e5f6a7-0000-0000-0000-000000000000");
    expect(tab?.label).toBe("d4e5f6a7…");
  });

  test("list routes do not create tabs", () => {
    expect(matchEntityRoute("/agents")).toBeNull();
    expect(matchEntityRoute("/sessions")).toBeNull();
    expect(matchEntityRoute("/tasks")).toBeNull();
    expect(matchEntityRoute("/asks")).toBeNull();
    expect(matchEntityRoute("/memories")).toBeNull();
  });

  test("/tasks/graph literal sibling is excluded", () => {
    expect(matchEntityRoute("/tasks/graph")).toBeNull();
  });

  test("nested paths under an entity do not match", () => {
    expect(matchEntityRoute("/agents/abc/def")).toBeNull();
    expect(matchEntityRoute("/session/abc/def")).toBeNull();
  });
});
