/**
 * Unit tests for AppContainer
 *
 * Tests cover every public API method and the key behavioral contracts
 * documented in the mt#761 spec:
 * - register() + initialize() + get() basic flow
 * - set() directly sets instances (test pattern)
 * - get() throws for unresolved services
 * - initialize() resolves in registration order
 * - Factories can access previously resolved services via get()
 * - close() calls disposers in reverse order
 * - set() takes precedence over register()
 * - has() returns correct boolean
 * - Async factories are properly awaited
 */

import { describe, test, expect } from "bun:test";
import { TsyringeContainer } from "./container";
import type { AppServices } from "./types";

// Minimal fakes that satisfy the type constraints
const fakePersistence = {
  initialize: async () => {},
  close: async () => {},
  getStorage: () => ({}) as any,
  isInitialized: () => true,
} as unknown as AppServices["persistence"];

const fakeSessionProvider = {
  getSession: async () => null,
  listSessions: async () => [],
  addSession: async () => {},
  deleteSession: async () => {},
} as unknown as AppServices["sessionProvider"];

const SERVICE_NOT_AVAILABLE = 'Service "persistence" is not available';

const fakeGitService = {
  clone: async () => ({ workdir: "", session: "" }),
  execInRepository: async () => "",
} as unknown as AppServices["gitService"];

describe("TsyringeContainer", () => {
  // --- register() + initialize() + get() ---

  test("register + initialize + get: basic sync factory", async () => {
    const container = new TsyringeContainer();
    container.register("persistence", () => fakePersistence);
    await container.initialize();
    expect(container.get("persistence")).toBe(fakePersistence);
  });

  test("register + initialize + get: async factory", async () => {
    const container = new TsyringeContainer();
    container.register("persistence", async () => {
      // Simulate async work (DB connection)
      await new Promise((r) => setTimeout(r, 1));
      return fakePersistence;
    });
    await container.initialize();
    expect(container.get("persistence")).toBe(fakePersistence);
  });

  // --- set() ---

  test("set: directly provides instance without factory", () => {
    const container = new TsyringeContainer();
    container.set("persistence", fakePersistence);
    expect(container.get("persistence")).toBe(fakePersistence);
  });

  test("set: takes precedence over register (factory not called)", async () => {
    let factoryCalled = false;
    const container = new TsyringeContainer();
    container.register("persistence", () => {
      factoryCalled = true;
      return fakePersistence;
    });
    container.set("persistence", fakePersistence);
    await container.initialize();
    expect(factoryCalled).toBe(false);
    expect(container.get("persistence")).toBe(fakePersistence);
  });

  // --- get() throws ---

  test("get: throws for unregistered service", () => {
    const container = new TsyringeContainer();
    expect(() => container.get("persistence")).toThrow(SERVICE_NOT_AVAILABLE);
  });

  test("get: throws for registered but not initialized service", () => {
    const container = new TsyringeContainer();
    container.register("persistence", () => fakePersistence);
    // initialize() not called
    expect(() => container.get("persistence")).toThrow(SERVICE_NOT_AVAILABLE);
  });

  // --- has() ---

  test("has: returns false for unregistered service", () => {
    const container = new TsyringeContainer();
    expect(container.has("persistence")).toBe(false);
  });

  test("has: returns true after set()", () => {
    const container = new TsyringeContainer();
    container.set("persistence", fakePersistence);
    expect(container.has("persistence")).toBe(true);
  });

  test("has: returns true after initialize()", async () => {
    const container = new TsyringeContainer();
    container.register("persistence", () => fakePersistence);
    expect(container.has("persistence")).toBe(false);
    await container.initialize();
    expect(container.has("persistence")).toBe(true);
  });

  // --- Registration order ---

  test("initialize: resolves factories in registration order", async () => {
    const order: string[] = [];
    const container = new TsyringeContainer();

    container.register("persistence", () => {
      order.push("persistence");
      return fakePersistence;
    });
    container.register("sessionProvider", () => {
      order.push("sessionProvider");
      return fakeSessionProvider;
    });
    container.register("gitService", () => {
      order.push("gitService");
      return fakeGitService;
    });

    await container.initialize();
    expect(order).toEqual(["persistence", "sessionProvider", "gitService"]);
  });

  // --- Dependency resolution via get() ---

  test("factories can access previously resolved services", async () => {
    const container = new TsyringeContainer();

    container.register("persistence", () => fakePersistence);
    container.register("sessionProvider", (c) => {
      // This factory depends on persistence being resolved first
      const p = c.get("persistence");
      expect(p).toBe(fakePersistence);
      return fakeSessionProvider;
    });

    await container.initialize();
    expect(container.get("sessionProvider")).toBe(fakeSessionProvider);
  });

  test("factory throws if dependency not yet resolved (wrong registration order)", async () => {
    const container = new TsyringeContainer();

    // Register sessionProvider BEFORE persistence — wrong order
    container.register("sessionProvider", (c) => {
      c.get("persistence"); // This should throw
      return fakeSessionProvider;
    });
    container.register("persistence", () => fakePersistence);

    await expect(container.initialize()).rejects.toThrow(SERVICE_NOT_AVAILABLE);
  });

  // --- close() ---

  test("close: calls registered disposers", async () => {
    let disposed = false;
    const container = new TsyringeContainer();

    container.register("persistence", () => fakePersistence, {
      dispose: async () => {
        disposed = true;
      },
    });

    await container.initialize();
    expect(disposed).toBe(false);
    await container.close();
    expect(disposed).toBe(true);
  });

  test("close: disposes in reverse registration order", async () => {
    const order: string[] = [];
    const container = new TsyringeContainer();

    container.register("persistence", () => fakePersistence, {
      dispose: async () => {
        order.push("persistence");
      },
    });
    container.register("sessionProvider", () => fakeSessionProvider, {
      dispose: async () => {
        order.push("sessionProvider");
      },
    });
    container.register("gitService", () => fakeGitService, {
      dispose: async () => {
        order.push("gitService");
      },
    });

    await container.initialize();
    await container.close();
    // Reverse of registration order: leaves before roots
    expect(order).toEqual(["gitService", "sessionProvider", "persistence"]);
  });

  test("close: clears all instances", async () => {
    const container = new TsyringeContainer();
    container.set("persistence", fakePersistence);
    expect(container.has("persistence")).toBe(true);
    await container.close();
    expect(container.has("persistence")).toBe(false);
  });

  // --- Chaining ---

  test("register and set return this for chaining", () => {
    const container = new TsyringeContainer();
    const result = container
      .register("persistence", () => fakePersistence)
      .set("gitService", fakeGitService);
    expect(result).toBe(container);
  });

  // --- Re-registration ---

  test("re-registering a key updates the factory and moves to end of init order", async () => {
    const order: string[] = [];
    const container = new TsyringeContainer();

    container.register("persistence", () => {
      order.push("persistence-v1");
      return fakePersistence;
    });
    container.register("sessionProvider", () => {
      order.push("sessionProvider");
      return fakeSessionProvider;
    });
    // Re-register persistence — should now resolve AFTER sessionProvider
    container.register("persistence", () => {
      order.push("persistence-v2");
      return fakePersistence;
    });

    await container.initialize();
    expect(order).toEqual(["sessionProvider", "persistence-v2"]);
  });
});
