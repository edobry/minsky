/**
 * Tests for the ClientCapabilityRegistry interface, the no-op default,
 * and the real MCPClientCapabilityRegistry that tracks active MCP Servers.
 *
 * Reference: mt#1456 (interface + no-op), mt#1457 (MCP-backed impl).
 */

import { describe, expect, test } from "bun:test";
import {
  NoopClientCapabilityRegistry,
  MCPClientCapabilityRegistry,
  type ClientCapabilityRegistry,
} from "./client-capabilities";

// ---------------------------------------------------------------------------
// Fake Server — minimal stand-in for the SDK Server class
// ---------------------------------------------------------------------------

/**
 * Test fake matching the subset of `Server` that
 * `MCPClientCapabilityRegistry` reads. Capabilities can be set/cleared
 * dynamically to simulate connection initialization.
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
// MCPClientCapabilityRegistry — mt#1457
// ---------------------------------------------------------------------------

describe("MCPClientCapabilityRegistry", () => {
  test("starts with no registered servers and reports no elicitation", () => {
    const registry = new MCPClientCapabilityRegistry();
    expect(registry.registeredCount).toBe(0);
    expect(registry.hasElicitation()).toBe(false);
    expect(registry.activeElicitationServer()).toBe(null);
  });

  test("registerServer adds a server to the active set", () => {
    const registry = new MCPClientCapabilityRegistry();
    const server = new FakeServer();
    registry.registerServer(server as never);
    expect(registry.registeredCount).toBe(1);
  });

  test("registerServer is idempotent — re-registering the same instance is a no-op", () => {
    const registry = new MCPClientCapabilityRegistry();
    const server = new FakeServer();
    registry.registerServer(server as never);
    registry.registerServer(server as never);
    registry.registerServer(server as never);
    expect(registry.registeredCount).toBe(1);
  });

  test("unregisterServer removes a server from the active set", () => {
    const registry = new MCPClientCapabilityRegistry();
    const server = new FakeServer();
    registry.registerServer(server as never);
    registry.unregisterServer(server as never);
    expect(registry.registeredCount).toBe(0);
  });

  test("unregisterServer is safe for never-registered servers", () => {
    const registry = new MCPClientCapabilityRegistry();
    const server = new FakeServer();
    expect(() => registry.unregisterServer(server as never)).not.toThrow();
    expect(registry.registeredCount).toBe(0);
  });

  test("hasElicitation() returns false when registered server reports no capabilities (pre-initialize)", () => {
    const registry = new MCPClientCapabilityRegistry();
    const server = new FakeServer();
    registry.registerServer(server as never);
    // capabilities undefined — connection has not completed initialize handshake
    expect(registry.hasElicitation()).toBe(false);
  });

  test("hasElicitation() returns false when registered server's client did NOT advertise elicitation", () => {
    const registry = new MCPClientCapabilityRegistry();
    const server = new FakeServer();
    server.setCapabilities({ tools: {} }); // some other capability, no elicitation
    registry.registerServer(server as never);
    expect(registry.hasElicitation()).toBe(false);
  });

  test("hasElicitation() returns true when registered server's client advertised elicitation", () => {
    const registry = new MCPClientCapabilityRegistry();
    const server = new FakeServer();
    server.setCapabilities({ elicitation: { form: {} } });
    registry.registerServer(server as never);
    expect(registry.hasElicitation()).toBe(true);
  });

  test("hasElicitation() is live — picks up post-registration capability changes", () => {
    const registry = new MCPClientCapabilityRegistry();
    const server = new FakeServer();
    registry.registerServer(server as never);
    expect(registry.hasElicitation()).toBe(false);

    // Simulate the initialize handshake completing after registration.
    server.setCapabilities({ elicitation: {} });
    expect(registry.hasElicitation()).toBe(true);
  });

  test("hasElicitation() returns true if ANY registered server's client advertised elicitation", () => {
    const registry = new MCPClientCapabilityRegistry();
    const noElicit = new FakeServer();
    noElicit.setCapabilities({ tools: {} });
    const elicit = new FakeServer();
    elicit.setCapabilities({ elicitation: {} });
    registry.registerServer(noElicit as never);
    registry.registerServer(elicit as never);
    expect(registry.hasElicitation()).toBe(true);
  });

  test("activeElicitationServer() returns the first elicitation-capable server", () => {
    const registry = new MCPClientCapabilityRegistry();
    const noElicit = new FakeServer();
    noElicit.setCapabilities({ tools: {} });
    const elicit = new FakeServer();
    elicit.setCapabilities({ elicitation: {} });
    registry.registerServer(noElicit as never);
    registry.registerServer(elicit as never);

    const active = registry.activeElicitationServer();
    expect(active).not.toBe(null);
    // The returned server is the one with elicitation capability — proven by
    // the structural identity check on the underlying object.
    expect(active).toBe(elicit as never);
  });

  test("activeElicitationServer() returns null when no registered server is elicitation-capable", () => {
    const registry = new MCPClientCapabilityRegistry();
    const server = new FakeServer();
    server.setCapabilities({ tools: {} });
    registry.registerServer(server as never);
    expect(registry.activeElicitationServer()).toBe(null);
  });

  test("unregistering an elicitation-capable server flips hasElicitation back to false", () => {
    const registry = new MCPClientCapabilityRegistry();
    const server = new FakeServer();
    server.setCapabilities({ elicitation: {} });
    registry.registerServer(server as never);
    expect(registry.hasElicitation()).toBe(true);

    registry.unregisterServer(server as never);
    expect(registry.hasElicitation()).toBe(false);
    expect(registry.activeElicitationServer()).toBe(null);
  });

  test("satisfies the ClientCapabilityRegistry interface contract", () => {
    const registry: ClientCapabilityRegistry = new MCPClientCapabilityRegistry();
    expect(typeof registry.hasElicitation).toBe("function");
    expect(typeof registry.activeElicitationServer).toBe("function");
  });
});
