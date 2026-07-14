/**
 * Tests for the entity-tab route matcher (mt#2398, extended mt#1919, mt#2535, mt#2769).
 */
import { describe, test, expect } from "bun:test";
import { matchEntityRoute, isAcceptedTabKind, migrateLegacySessionPath, type EntityTab } from "./tabs";

describe("matchEntityRoute", () => {
  test("matches /conversation/:id as kind session (harness agentSessionId)", () => {
    const tab = matchEntityRoute("/conversation/4d44d12b-58f0-433e-95b3-8b914693fa39");
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

  test("matches /changeset/:id as kind changeset (mt#2535)", () => {
    const tab = matchEntityRoute("/changeset/42");
    expect(tab?.kind).toBe("changeset");
    expect(tab?.entityId).toBe("42");
    expect(tab?.label).toBe("42");
  });

  test("URL-encoded changeset id is decoded", () => {
    const tab = matchEntityRoute("/changeset/pr%2342");
    expect(tab?.entityId).toBe("pr#42");
  });

  test("changeset list route does not create a tab", () => {
    expect(matchEntityRoute("/changesets")).toBeNull();
  });

  test("list routes do not create tabs", () => {
    expect(matchEntityRoute("/agents")).toBeNull();
    expect(matchEntityRoute("/conversations")).toBeNull();
    expect(matchEntityRoute("/tasks")).toBeNull();
    expect(matchEntityRoute("/asks")).toBeNull();
    expect(matchEntityRoute("/memories")).toBeNull();
  });

  test("/tasks/graph literal sibling is excluded", () => {
    expect(matchEntityRoute("/tasks/graph")).toBeNull();
  });

  test("nested paths under an entity do not match", () => {
    expect(matchEntityRoute("/agents/abc/def")).toBeNull();
    expect(matchEntityRoute("/conversation/abc/def")).toBeNull();
  });
});

describe("isAcceptedTabKind (loadTabs kind filter)", () => {
  test("accepts all defined entity tab kinds including changeset", () => {
    expect(isAcceptedTabKind("task")).toBe(true);
    expect(isAcceptedTabKind("session")).toBe(true);
    expect(isAcceptedTabKind("agent")).toBe(true);
    expect(isAcceptedTabKind("ask")).toBe(true);
    expect(isAcceptedTabKind("memory")).toBe(true);
    expect(isAcceptedTabKind("changeset")).toBe(true);
  });

  test("rejects unknown kinds so stale tabs are dropped", () => {
    expect(isAcceptedTabKind("unknown")).toBe(false);
    expect(isAcceptedTabKind("pr")).toBe(false);
    expect(isAcceptedTabKind(null)).toBe(false);
    expect(isAcceptedTabKind(undefined)).toBe(false);
    expect(isAcceptedTabKind(42)).toBe(false);
  });

  test("persisted changeset tab shape passes the kind filter", () => {
    const persistedTab = {
      kind: "changeset",
      entityId: "42",
      path: "/changeset/42",
      label: "42",
    };
    // Verify the kind is accepted (the filter that loadTabs applies)
    expect(isAcceptedTabKind(persistedTab.kind)).toBe(true);
    // Verify the full shape round-trips through matchEntityRoute
    const matched = matchEntityRoute(persistedTab.path);
    expect(matched?.kind).toBe("changeset");
    expect(matched?.entityId).toBe("42");
  });
});

describe("migrateLegacySessionPath (mt#2769 success criterion 1b)", () => {
  const legacyTab: EntityTab = {
    kind: "session",
    entityId: "4d44d12b-58f0-433e-95b3-8b914693fa39",
    path: "/session/4d44d12b-58f0-433e-95b3-8b914693fa39",
    label: "4d44d12b…",
  };

  test("rewrites a persisted /session/:id tab to /conversation/:id", () => {
    const migrated = migrateLegacySessionPath(legacyTab);
    expect(migrated.path).toBe("/conversation/4d44d12b-58f0-433e-95b3-8b914693fa39");
  });

  test("kind and entityId are left untouched (broader tab-kind rename is out of scope)", () => {
    const migrated = migrateLegacySessionPath(legacyTab);
    expect(migrated.kind).toBe("session");
    expect(migrated.entityId).toBe(legacyTab.entityId);
    expect(migrated.label).toBe(legacyTab.label);
  });

  test("the migrated path resolves via matchEntityRoute", () => {
    const migrated = migrateLegacySessionPath(legacyTab);
    const matched = matchEntityRoute(migrated.path);
    expect(matched?.kind).toBe("session");
    expect(matched?.entityId).toBe(legacyTab.entityId);
  });

  test("a tab already on /conversation/:id passes through unchanged", () => {
    const currentTab: EntityTab = {
      kind: "session",
      entityId: "abc123",
      path: "/conversation/abc123",
      label: "abc123",
    };
    expect(migrateLegacySessionPath(currentTab)).toEqual(currentTab);
  });

  test("non-session-shaped tabs (task, agent, ask, memory, changeset) pass through unchanged", () => {
    const otherTabs: EntityTab[] = [
      { kind: "task", entityId: "mt#42", path: "/tasks/mt%2342", label: "mt#42" },
      { kind: "agent", entityId: "xyz", path: "/agents/xyz", label: "xyz" },
      { kind: "ask", entityId: "a1", path: "/ask/a1", label: "a1" },
      { kind: "memory", entityId: "m1", path: "/memory/m1", label: "m1" },
      { kind: "changeset", entityId: "42", path: "/changeset/42", label: "42" },
    ];
    for (const tab of otherTabs) {
      expect(migrateLegacySessionPath(tab)).toEqual(tab);
    }
  });
});
