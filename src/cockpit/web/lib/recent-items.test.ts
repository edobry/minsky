import { describe, test, expect, beforeEach } from "bun:test";
import { getRecentItems, addRecentItem } from "./recent-items";

const STORAGE_KEY = "minsky-cockpit-recent-items";

// Mock localStorage for test environment
const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const key of Object.keys(store)) {
      delete store[key];
    }
  },
  get length() {
    return Object.keys(store).length;
  },
  key: (_index: number) => null as string | null,
};

// @ts-expect-error — overriding readonly globalThis.localStorage for tests
globalThis.localStorage = mockLocalStorage;

describe("recent-items", () => {
  beforeEach(() => {
    mockLocalStorage.clear();
  });

  test("getRecentItems returns empty array when no items stored", () => {
    expect(getRecentItems()).toEqual([]);
  });

  test("getRecentItems returns empty array for invalid JSON", () => {
    store[STORAGE_KEY] = "not-json";
    expect(getRecentItems()).toEqual([]);
  });

  test("getRecentItems returns empty array for non-array JSON", () => {
    store[STORAGE_KEY] = JSON.stringify({ foo: "bar" });
    expect(getRecentItems()).toEqual([]);
  });

  test("addRecentItem stores and retrieves an item", () => {
    addRecentItem({
      type: "task",
      id: "mt#1",
      label: "Test task",
      path: "/tasks?highlight=mt%231",
    });
    const items = getRecentItems();
    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first).toBeDefined();
    expect(first?.id).toBe("mt#1");
    expect(first?.label).toBe("Test task");
    expect(first?.type).toBe("task");
    expect(first?.path).toBe("/tasks?highlight=mt%231");
    expect(first?.timestamp).toBeGreaterThan(0);
  });

  test("addRecentItem deduplicates by id — re-adding moves item to front", () => {
    addRecentItem({ type: "task", id: "mt#1", label: "First", path: "/a" });
    addRecentItem({ type: "task", id: "mt#2", label: "Second", path: "/b" });
    addRecentItem({ type: "task", id: "mt#1", label: "First updated", path: "/a" });

    const items = getRecentItems();
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe("mt#1");
    expect(items[0]?.label).toBe("First updated");
    expect(items[1]?.id).toBe("mt#2");
  });

  test("addRecentItem caps at 5 items", () => {
    for (let i = 0; i < 8; i++) {
      addRecentItem({ type: "page", id: `p${i}`, label: `Page ${i}`, path: `/${i}` });
    }
    const items = getRecentItems();
    expect(items).toHaveLength(5);
    expect(items[0]?.id).toBe("p7");
  });

  test("getRecentItems returns items sorted by timestamp descending", () => {
    const now = Date.now();
    store[STORAGE_KEY] = JSON.stringify([
      { type: "task", id: "a", label: "A", path: "/a", timestamp: now - 1000 },
      { type: "task", id: "b", label: "B", path: "/b", timestamp: now },
      { type: "task", id: "c", label: "C", path: "/c", timestamp: now - 500 },
    ]);
    const items = getRecentItems();
    expect(items[0]?.id).toBe("b");
    expect(items[1]?.id).toBe("c");
    expect(items[2]?.id).toBe("a");
  });
});
