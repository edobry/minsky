/**
 * Tests for session-film-links.ts (mt#3184 — spec SC 8 / AT 6).
 */
import { describe, test, expect } from "bun:test";
import { resolveEntityLink } from "./session-film-links";

describe("resolveEntityLink", () => {
  test("a minsky task target yields the correct minsky:// entity type + id (AT6)", () => {
    const resolved = resolveEntityLink({ id: "minsky:task:mt#1772" });
    expect(resolved).toEqual({ kind: "minsky", entityType: "task", entityId: "mt#1772" });
  });

  test("a file target resolves to its path target (AT6)", () => {
    const resolved = resolveEntityLink({ id: "file:workspace:src/cockpit/server.ts" });
    expect(resolved).toEqual({
      kind: "path",
      label: "src/cockpit/server.ts",
      path: "src/cockpit/server.ts",
    });
  });

  test("a web target resolves to its https domain", () => {
    const resolved = resolveEntityLink({ id: "web:example.com" });
    expect(resolved).toEqual({
      kind: "external",
      label: "example.com",
      href: "https://example.com",
    });
  });

  test("a notion target resolves to a notion.so URL", () => {
    const resolved = resolveEntityLink({ id: "notion:3a7937f0-3cb4" });
    expect(resolved).toEqual({
      kind: "external",
      label: "3a7937f0-3cb4",
      href: "https://notion.so/3a7937f0-3cb4",
    });
  });

  test("a workspace-clone target maps to the codec's 'session' routable type", () => {
    const resolved = resolveEntityLink({ id: "minsky:workspace:mt-3184" });
    expect(resolved).toEqual({ kind: "minsky", entityType: "session", entityId: "mt-3184" });
  });

  test("a memory/ask/changeset target routes to the matching type", () => {
    expect(resolveEntityLink({ id: "minsky:memory:abcd" })).toEqual({
      kind: "minsky",
      entityType: "memory",
      entityId: "abcd",
    });
    expect(resolveEntityLink({ id: "minsky:ask:1234" })).toEqual({
      kind: "minsky",
      entityType: "ask",
      entityId: "1234",
    });
    expect(resolveEntityLink({ id: "minsky:changeset:99" })).toEqual({
      kind: "minsky",
      entityType: "changeset",
      entityId: "99",
    });
  });

  test("shell/agents/unknown targets are non-navigable labels", () => {
    expect(resolveEntityLink({ id: "shell:bun test" }).kind).toBe("none");
    expect(resolveEntityLink({ id: "agents:Explore" }).kind).toBe("none");
    expect(resolveEntityLink({ id: "unknown:Skill" }).kind).toBe("none");
  });
});
