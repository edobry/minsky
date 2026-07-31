/**
 * Tests for the entity-tab route matcher (mt#2398, extended mt#1919, mt#2535, mt#2769).
 */
import { describe, test, expect } from "bun:test";
import {
  matchEntityRoute,
  isAcceptedTabKind,
  migrateLegacySessionPath,
  backfillTabRecency,
  evictToCap,
  MAX_OPEN_TABS,
  type EntityTab,
} from "./tabs";

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

  describe("driven-session route (mt#3400)", () => {
    test("/driven/:id matches and carries the driven kind", () => {
      const tab = matchEntityRoute("/driven/ds-abc123");
      expect(tab?.kind).toBe("driven");
      expect(tab?.entityId).toBe("ds-abc123");
      expect(tab?.path).toBe("/driven/ds-abc123");
    });

    test("a percent-encoded driven id decodes into entityId but keeps the encoded path", () => {
      const tab = matchEntityRoute("/driven/foo%20bar");
      expect(tab?.entityId).toBe("foo bar");
      expect(tab?.path).toBe("/driven/foo%20bar");
    });

    test("the /driven list-less base route does not match", () => {
      expect(matchEntityRoute("/driven")).toBeNull();
    });

    test("a nested path under a driven session does not match", () => {
      expect(matchEntityRoute("/driven/abc/def")).toBeNull();
    });
  });

  describe("run-detail tab sub-routes (mt#2768)", () => {
    test("/agents/:id/conversation matches and normalizes to the base entity path", () => {
      const tab = matchEntityRoute("/agents/abc123/conversation");
      expect(tab?.kind).toBe("agent");
      expect(tab?.entityId).toBe("abc123");
      expect(tab?.path).toBe("/agents/abc123");
    });

    test("/agents/:id/context matches and normalizes to the base entity path", () => {
      const tab = matchEntityRoute("/agents/abc123/context");
      expect(tab?.kind).toBe("agent");
      expect(tab?.path).toBe("/agents/abc123");
    });

    test("/conversation/:id/overview matches and normalizes to the base entity path", () => {
      const tab = matchEntityRoute("/conversation/xyz789/overview");
      expect(tab?.kind).toBe("session");
      expect(tab?.entityId).toBe("xyz789");
      expect(tab?.path).toBe("/conversation/xyz789");
    });

    test("/conversation/:id/context matches and normalizes to the base entity path", () => {
      const tab = matchEntityRoute("/conversation/xyz789/context");
      expect(tab?.kind).toBe("session");
      expect(tab?.path).toBe("/conversation/xyz789");
    });

    test("an unrecognized suffix still does not match (e.g. /agents/:id/overview is invalid — overview is not an agents sub-tab)", () => {
      expect(matchEntityRoute("/agents/abc123/overview")).toBeNull();
    });

    test("an unrecognized suffix still does not match (e.g. /conversation/:id/conversation is invalid)", () => {
      expect(matchEntityRoute("/conversation/xyz789/conversation")).toBeNull();
    });

    test("base and tab-suffixed paths for the same entity normalize to the SAME tab-strip path", () => {
      const base = matchEntityRoute("/agents/abc123");
      const withTab = matchEntityRoute("/agents/abc123/context");
      if (!base || !withTab) throw new Error("expected both routes to match");
      expect(base.path).toBe(withTab.path);
    });
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

  // mt#3400 — this is the leg that makes a driven tab SURVIVE a reload. The
  // filter runs at load, so a kind missing here is dropped from the restored
  // set: the tab would work for the session and silently vanish on refresh.
  test("accepts the driven kind so a driven tab survives a reload", () => {
    expect(isAcceptedTabKind("driven")).toBe(true);
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

// ---------------------------------------------------------------------------
// LRU cap on the open-tab working set (mt#3252)
// ---------------------------------------------------------------------------

/** A task tab at `id`, activated at `lastActiveAt`. */
function tabAt(id: string, lastActiveAt?: number): EntityTab {
  return {
    kind: "task",
    entityId: `mt#${id}`,
    path: `/tasks/mt%23${id}`,
    label: `mt#${id}`,
    ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
  };
}

describe("evictToCap — bounding the working set (mt#3252)", () => {
  test("a set at or under the cap is returned untouched (same reference)", () => {
    const tabs = [tabAt("1", 10), tabAt("2", 20)];
    expect(evictToCap(tabs, { cap: 2 })).toBe(tabs);
  });

  test("evicts the LEAST-RECENTLY-ACTIVE tab, not the first opened", () => {
    // Open order 1,2,3 — but tab 1 was activated most recently, so tab 2 is
    // the coldest and must be the one to go.
    const tabs = [tabAt("1", 300), tabAt("2", 100), tabAt("3", 200)];
    const kept = evictToCap(tabs, { cap: 2 }).map((t) => t.entityId);
    expect(kept).toEqual(["mt#1", "mt#3"]);
  });

  test("surviving tabs keep their original order (eviction is not a re-sort)", () => {
    const tabs = [tabAt("1", 400), tabAt("2", 100), tabAt("3", 300), tabAt("4", 200)];
    const kept = evictToCap(tabs, { cap: 2 }).map((t) => t.entityId);
    expect(kept).toEqual(["mt#1", "mt#3"]);
  });

  test("the protected (active) tab is never evicted even when it is the coldest", () => {
    const tabs = [tabAt("1", 300), tabAt("2", 1), tabAt("3", 200)];
    const kept = evictToCap(tabs, { cap: 2, protectPath: "/tasks/mt%232" }).map((t) => t.entityId);
    // Tab 2 is the coldest by far but is active, so tab 3 (the coldest
    // evictable) goes instead — leaving the active tab and the warmest other.
    expect(kept).toContain("mt#2");
    expect(kept).toEqual(["mt#1", "mt#2"]);
  });

  test("a cap smaller than the protected set leaves the protected tab standing", () => {
    const tabs = [tabAt("1", 10), tabAt("2", 20)];
    const kept = evictToCap(tabs, { cap: 0, protectPath: "/tasks/mt%232" });
    expect(kept.map((t) => t.entityId)).toEqual(["mt#2"]);
  });

  test("ties break by open order, so back-filled ordinal recencies stay stable", () => {
    const tabs = [tabAt("1", 5), tabAt("2", 5), tabAt("3", 5)];
    const kept = evictToCap(tabs, { cap: 2 }).map((t) => t.entityId);
    expect(kept).toEqual(["mt#2", "mt#3"]);
  });

  test("a tab with no recency at all ranks oldest rather than crashing the sort", () => {
    const tabs = [tabAt("1", 100), tabAt("2"), tabAt("3", 200)];
    const kept = evictToCap(tabs, { cap: 2 }).map((t) => t.entityId);
    expect(kept).toEqual(["mt#1", "mt#3"]);
  });

  test("the default cap is MAX_OPEN_TABS", () => {
    const tabs = Array.from({ length: MAX_OPEN_TABS + 3 }, (_, i) => tabAt(String(i), i));
    expect(evictToCap(tabs)).toHaveLength(MAX_OPEN_TABS);
  });

  test("a 49-tab backlog (the measured pre-fix state) is bounded to the cap, keeping the newest", () => {
    const tabs = backfillTabRecency(Array.from({ length: 49 }, (_, i) => tabAt(String(i))));
    const kept = evictToCap(tabs);
    expect(kept).toHaveLength(MAX_OPEN_TABS);
    // Back-filled recency is ordinal, so "newest" is the tail of persisted order.
    expect(kept[0]?.entityId).toBe(`mt#${49 - MAX_OPEN_TABS}`);
    expect(kept[kept.length - 1]?.entityId).toBe("mt#48");
  });
});

describe("backfillTabRecency — legacy payloads (mt#3252)", () => {
  test("tabs persisted without a recency field get ordinal recency, preserving order", () => {
    const filled = backfillTabRecency([tabAt("1"), tabAt("2"), tabAt("3")]);
    expect(filled.map((t) => t.lastActiveAt)).toEqual([0, 1, 2]);
  });

  test("no tab loses its identity in the back-fill", () => {
    const legacy = [tabAt("1"), tabAt("2")];
    const filled = backfillTabRecency(legacy);
    expect(filled).toHaveLength(2);
    expect(filled.map((t) => t.path)).toEqual(legacy.map((t) => t.path));
  });

  test("an existing recency value is left alone", () => {
    const filled = backfillTabRecency([tabAt("1", 1_760_000_000_000)]);
    expect(filled[0]?.lastActiveAt).toBe(1_760_000_000_000);
  });

  test("a non-finite persisted value is repaired rather than poisoning the LRU sort", () => {
    const filled = backfillTabRecency([
      { ...tabAt("1"), lastActiveAt: Number.NaN },
      { ...tabAt("2"), lastActiveAt: Number.POSITIVE_INFINITY },
    ]);
    expect(filled.map((t) => t.lastActiveAt)).toEqual([0, 1]);
  });

  test("ordinal back-fill always ranks older than a real activation timestamp", () => {
    const mixed = backfillTabRecency([tabAt("legacy"), tabAt("live", Date.now())]);
    const [legacy, live] = mixed;
    expect(legacy?.lastActiveAt).toBeLessThan(live?.lastActiveAt ?? 0);
  });
});
