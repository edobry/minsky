/**
 * Tests for the ClientCapabilityRegistry interface, the no-op default, the
 * caller-scoped SingleConnectionCapabilityRegistry, and the fleet-wide
 * MCPConnectionTracker.
 *
 * Reference: mt#1456 (interface + no-op), mt#1457 (MCP-backed impl),
 * mt#4451 (caller-scoped resolution — the split these two classes represent).
 */

import { describe, expect, test } from "bun:test";
import {
  NoopClientCapabilityRegistry,
  MCPConnectionTracker,
  SingleConnectionCapabilityRegistry,
  type ClientCapabilityRegistry,
} from "./client-capabilities";

// ---------------------------------------------------------------------------
// Fake Server — minimal stand-in for the SDK Server class
// ---------------------------------------------------------------------------

/**
 * Test fake matching the subset of `Server` that the two implementations read.
 * Capabilities can be set/cleared dynamically to simulate connection
 * initialization.
 */
class FakeServer {
  private capabilities: any = undefined;

  setCapabilities(caps: any): void {
    this.capabilities = caps;
  }

  getClientCapabilities(): any {
    return this.capabilities;
  }

  /**
   * Stand-in for the SDK's elicitInput. Tests that exercise the dispatch
   * path provide their own mock; capability tests don't call this.
   */
  elicitInput(): Promise<unknown> {
    return Promise.reject(new Error("elicitInput not mocked in capability tests"));
  }
}

// ---------------------------------------------------------------------------
// NoopClientCapabilityRegistry — mt#1456 surface (regression-protected here)
// ---------------------------------------------------------------------------

describe("NoopClientCapabilityRegistry", () => {
  test("hasElicitation() returns false", () => {
    const registry = new NoopClientCapabilityRegistry();
    expect(registry.hasElicitation()).toBe(false);
  });

  test("hasElicitation() is stable across calls", () => {
    const registry = new NoopClientCapabilityRegistry();
    expect(registry.hasElicitation()).toBe(false);
    expect(registry.hasElicitation()).toBe(false);
    expect(registry.hasElicitation()).toBe(false);
  });

  test("activeElicitationServer() returns null", () => {
    const registry = new NoopClientCapabilityRegistry();
    expect(registry.activeElicitationServer()).toBe(null);
  });

  test("satisfies the ClientCapabilityRegistry interface contract", () => {
    const registry: ClientCapabilityRegistry = new NoopClientCapabilityRegistry();
    expect(typeof registry.hasElicitation).toBe("function");
    expect(typeof registry.activeElicitationServer).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// SingleConnectionCapabilityRegistry — mt#4451 (the caller-scoped answer)
// ---------------------------------------------------------------------------

describe("SingleConnectionCapabilityRegistry", () => {
  test("hasElicitation() is false pre-initialize (server reports no capabilities)", () => {
    const server = new FakeServer();
    const registry = new SingleConnectionCapabilityRegistry(server as never);
    expect(registry.hasElicitation()).toBe(false);
    expect(registry.activeElicitationServer()).toBe(null);
  });

  test("hasElicitation() is false when the client advertised other capabilities", () => {
    const server = new FakeServer();
    server.setCapabilities({ tools: {}, roots: {} });
    const registry = new SingleConnectionCapabilityRegistry(server as never);
    expect(registry.hasElicitation()).toBe(false);
    expect(registry.activeElicitationServer()).toBe(null);
  });

  test("hasElicitation() is true when this connection advertised elicitation", () => {
    const server = new FakeServer();
    // The exact shape ADR-006 captured from Claude Code.
    server.setCapabilities({ elicitation: { form: {} }, roots: {} });
    const registry = new SingleConnectionCapabilityRegistry(server as never);
    expect(registry.hasElicitation()).toBe(true);
  });

  test("reads capabilities live, so a post-construction initialize is picked up", () => {
    const server = new FakeServer();
    const registry = new SingleConnectionCapabilityRegistry(server as never);
    expect(registry.hasElicitation()).toBe(false);

    // The SDK populates getClientCapabilities() during `initialize`, which may
    // land after this object was built (server.ts constructs one per request).
    server.setCapabilities({ elicitation: {} });
    expect(registry.hasElicitation()).toBe(true);
  });

  test("activeElicitationServer() returns THIS connection, by identity", () => {
    const server = new FakeServer();
    server.setCapabilities({ elicitation: {} });
    const registry = new SingleConnectionCapabilityRegistry(server as never);
    expect(registry.activeElicitationServer()).toBe(server as never);
  });

  /**
   * AT1 — the defect this task fixes, stated as a test.
   *
   * Two connections are live; only one advertises elicitation. A query made on
   * behalf of the NON-advertising connection must answer false. Under the old
   * process-wide registry this returned true, because it scanned every
   * registered server rather than the caller's.
   */
  test("AT1: a second connection's capabilities cannot change this caller's answer", () => {
    const callerWithout = new FakeServer();
    callerWithout.setCapabilities({ tools: {} });
    const otherWith = new FakeServer();
    otherWith.setCapabilities({ elicitation: {} });

    // Both are live on the daemon — the tracker sees both.
    const tracker = new MCPConnectionTracker();
    tracker.registerServer(callerWithout as never);
    tracker.registerServer(otherWith as never);
    expect(tracker.anyConnectionHasElicitation()).toBe(true);

    // The caller-scoped answer is the one routing uses, and it is false.
    const callerRegistry = new SingleConnectionCapabilityRegistry(callerWithout as never);
    expect(callerRegistry.hasElicitation()).toBe(false);
    expect(callerRegistry.activeElicitationServer()).toBe(null);
  });

  /**
   * AT2 — dispatch targets the caller, not whoever happens to be first.
   *
   * Asserted by IDENTITY rather than by capability, because with several
   * elicitation-capable connections every candidate satisfies "is capable";
   * only identity distinguishes the caller from an arbitrary Set-iteration
   * winner.
   */
  test("AT2: with several capable connections, each resolves to its OWN server", () => {
    const first = new FakeServer();
    first.setCapabilities({ elicitation: {} });
    const second = new FakeServer();
    second.setCapabilities({ elicitation: {} });
    const third = new FakeServer();
    third.setCapabilities({ elicitation: {} });

    const tracker = new MCPConnectionTracker();
    tracker.registerServer(first as never);
    tracker.registerServer(second as never);
    tracker.registerServer(third as never);

    expect(new SingleConnectionCapabilityRegistry(second as never).activeElicitationServer()).toBe(
      second as never
    );
    expect(new SingleConnectionCapabilityRegistry(third as never).activeElicitationServer()).toBe(
      third as never
    );
    expect(new SingleConnectionCapabilityRegistry(first as never).activeElicitationServer()).toBe(
      first as never
    );
  });

  test("satisfies the ClientCapabilityRegistry interface contract", () => {
    const registry: ClientCapabilityRegistry = new SingleConnectionCapabilityRegistry(
      new FakeServer() as never
    );
    expect(typeof registry.hasElicitation).toBe("function");
    expect(typeof registry.activeElicitationServer).toBe("function");
  });
});

/**
 * AT3 — a caller with no resolvable connection resolves to "no elicitation".
 *
 * The CLI, a programmatic emitter and a test all reach `asks.create` with no
 * `callerCapabilities` on the execution context. The container default is what
 * answers then, and it must be the no-op — never a fleet-wide view. This test
 * pins the DEFAULT's behaviour; `asks-elicitation-routing.test.ts` pins the
 * call-site preference that selects it.
 */
describe("AT3: no resolvable connection", () => {
  test("the no-op default answers 'no elicitation' rather than deferring to any connection", () => {
    const fallback: ClientCapabilityRegistry = new NoopClientCapabilityRegistry();
    expect(fallback.hasElicitation()).toBe(false);
    expect(fallback.activeElicitationServer()).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// MCPConnectionTracker — mt#1457's lifecycle half, renamed by mt#4451
// ---------------------------------------------------------------------------

describe("MCPConnectionTracker", () => {
  test("starts empty and reports no elicitation anywhere", () => {
    const tracker = new MCPConnectionTracker();
    expect(tracker.registeredCount).toBe(0);
    expect(tracker.anyConnectionHasElicitation()).toBe(false);
  });

  test("registerServer adds a server to the active set", () => {
    const tracker = new MCPConnectionTracker();
    tracker.registerServer(new FakeServer() as never);
    expect(tracker.registeredCount).toBe(1);
  });

  test("registerServer is idempotent — re-registering the same instance is a no-op", () => {
    const tracker = new MCPConnectionTracker();
    const server = new FakeServer();
    tracker.registerServer(server as never);
    tracker.registerServer(server as never);
    tracker.registerServer(server as never);
    expect(tracker.registeredCount).toBe(1);
  });

  test("unregisterServer removes a server from the active set", () => {
    const tracker = new MCPConnectionTracker();
    const server = new FakeServer();
    tracker.registerServer(server as never);
    tracker.unregisterServer(server as never);
    expect(tracker.registeredCount).toBe(0);
  });

  test("unregisterServer is safe for never-registered servers", () => {
    const tracker = new MCPConnectionTracker();
    const server = new FakeServer();
    expect(() => tracker.unregisterServer(server as never)).not.toThrow();
    expect(tracker.registeredCount).toBe(0);
  });

  test("anyConnectionHasElicitation() is false pre-initialize", () => {
    const tracker = new MCPConnectionTracker();
    tracker.registerServer(new FakeServer() as never);
    expect(tracker.anyConnectionHasElicitation()).toBe(false);
  });

  test("anyConnectionHasElicitation() is true when ANY connection advertised it", () => {
    const tracker = new MCPConnectionTracker();
    const noElicit = new FakeServer();
    noElicit.setCapabilities({ tools: {} });
    const elicit = new FakeServer();
    elicit.setCapabilities({ elicitation: {} });
    tracker.registerServer(noElicit as never);
    tracker.registerServer(elicit as never);
    expect(tracker.anyConnectionHasElicitation()).toBe(true);
  });

  test("anyConnectionHasElicitation() is live — picks up post-registration changes", () => {
    const tracker = new MCPConnectionTracker();
    const server = new FakeServer();
    tracker.registerServer(server as never);
    expect(tracker.anyConnectionHasElicitation()).toBe(false);

    server.setCapabilities({ elicitation: {} });
    expect(tracker.anyConnectionHasElicitation()).toBe(true);
  });

  test("unregistering the only capable connection flips it back to false", () => {
    const tracker = new MCPConnectionTracker();
    const server = new FakeServer();
    server.setCapabilities({ elicitation: {} });
    tracker.registerServer(server as never);
    expect(tracker.anyConnectionHasElicitation()).toBe(true);

    tracker.unregisterServer(server as never);
    expect(tracker.anyConnectionHasElicitation()).toBe(false);
  });

  /**
   * SC4 regression guard. The tracker must NOT carry the interface's method
   * names, so a future caller cannot reach for a fleet-wide answer while
   * believing it is caller-scoped — the exact confusion that produced this
   * task. A structural assertion rather than a type-level one, because the
   * failure mode is someone calling the method at runtime.
   */
  test("SC4: does not expose the ClientCapabilityRegistry method names", () => {
    const tracker = new MCPConnectionTracker() as unknown as Record<string, unknown>;
    expect(tracker.hasElicitation).toBeUndefined();
    expect(tracker.activeElicitationServer).toBeUndefined();
  });
});
