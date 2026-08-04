/**
 * rail-collapse matcher + persistence tests (mt#3700).
 *
 * The chord half dispatches events on real elements and matches inside a real
 * `window` keydown listener, following `new-conversation.test.ts`: the guard's
 * whole job is to read `e.target`, and only a dispatched event has a real one.
 *
 * The persistence half passes an explicit storage object rather than patching
 * the global, which is what the injectable `RailCollapseStorage` parameter
 * exists for — including the throwing case, which is otherwise only reachable by
 * monkey-patching `localStorage` and restoring it.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  loadPersistedRailCollapsed,
  matchesRailCollapseShortcut,
  persistRailCollapsed,
  railToggleLabel,
  type RailCollapseStorage,
} from "./rail-collapse";

/** Dispatch a keydown from `target` and report the matcher's verdict. */
function matchOnDispatch(target: Element, init: KeyboardEventInit): boolean {
  let matched = false;
  const handler = (e: Event) => {
    matched = matchesRailCollapseShortcut(e as KeyboardEvent);
  };
  window.addEventListener("keydown", handler);
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  window.removeEventListener("keydown", handler);
  return matched;
}

function mount<T extends HTMLElement>(el: T): T {
  document.body.appendChild(el);
  return el;
}

/** An in-memory `RailCollapseStorage`, so a test can read back what was written. */
function fakeStorage(seed: Record<string, string> = {}): RailCollapseStorage & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

const STORAGE_DISABLED = "storage disabled";

/** A storage whose every operation throws — private-browsing / disabled-storage. */
const THROWING_STORAGE: RailCollapseStorage = {
  getItem() {
    throw new Error(STORAGE_DISABLED);
  },
  setItem() {
    throw new Error(STORAGE_DISABLED);
  },
  removeItem() {
    throw new Error(STORAGE_DISABLED);
  },
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("matchesRailCollapseShortcut", () => {
  test("⌘B from a non-text target matches", () => {
    expect(matchOnDispatch(document.body, { key: "b", metaKey: true })).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(matchOnDispatch(document.body, { key: "B", metaKey: true })).toBe(true);
  });

  test("plain B does not match", () => {
    expect(matchOnDispatch(document.body, { key: "b" })).toBe(false);
  });

  test("Ctrl+B does NOT match — this binding is meta-only, per new-conversation.ts", () => {
    expect(matchOnDispatch(document.body, { key: "b", ctrlKey: true })).toBe(false);
  });

  test("⌘⇧B does not match — that is a browser bookmarks-bar chord, not this one", () => {
    expect(matchOnDispatch(document.body, { key: "b", metaKey: true, shiftKey: true })).toBe(false);
  });

  test("adding Alt does not match", () => {
    expect(matchOnDispatch(document.body, { key: "b", metaKey: true, altKey: true })).toBe(false);
  });

  test("⌘K does not match — the palette chord must not toggle the rail", () => {
    expect(matchOnDispatch(document.body, { key: "k", metaKey: true })).toBe(false);
  });

  test("suppressed while focus is in a textarea", () => {
    const textarea = mount(document.createElement("textarea"));
    expect(matchOnDispatch(textarea, { key: "b", metaKey: true })).toBe(false);
  });

  test("suppressed while focus is in an input", () => {
    const input = mount(document.createElement("input"));
    expect(matchOnDispatch(input, { key: "b", metaKey: true })).toBe(false);
  });
});

describe("railToggleLabel", () => {
  test("names the action the press performs, not the current state", () => {
    expect(railToggleLabel(false)).toBe("Collapse sidebar");
    expect(railToggleLabel(true)).toBe("Expand sidebar");
  });
});

describe("rail collapse persistence", () => {
  test("round-trips the collapsed state", () => {
    const storage = fakeStorage();
    persistRailCollapsed(true, storage);
    expect(loadPersistedRailCollapsed(storage)).toBe(true);
  });

  test('expanded is stored as an ABSENT key, not the string "false"', () => {
    const storage = fakeStorage();
    persistRailCollapsed(true, storage);
    persistRailCollapsed(false, storage);
    expect(storage.entries.size).toBe(0);
    expect(loadPersistedRailCollapsed(storage)).toBe(false);
  });

  test("empty storage reads as expanded", () => {
    expect(loadPersistedRailCollapsed(fakeStorage())).toBe(false);
  });

  test('a value that is not the literal "true" reads as expanded', () => {
    expect(loadPersistedRailCollapsed(fakeStorage({ "cockpit.rail.collapsed.v1": "1" }))).toBe(
      false
    );
    expect(loadPersistedRailCollapsed(fakeStorage({ "cockpit.rail.collapsed.v1": "yes" }))).toBe(
      false
    );
  });

  test("a throwing storage reads as expanded instead of propagating", () => {
    expect(loadPersistedRailCollapsed(THROWING_STORAGE)).toBe(false);
  });

  test("a throwing storage does not make persisting throw", () => {
    expect(() => persistRailCollapsed(true, THROWING_STORAGE)).not.toThrow();
    expect(() => persistRailCollapsed(false, THROWING_STORAGE)).not.toThrow();
  });
});
