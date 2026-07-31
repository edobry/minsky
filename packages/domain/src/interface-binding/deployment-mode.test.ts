/**
 * Tests for the iTerm correlator's deployment-mode gate (mt#1628).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { isLocalItermCorrelationSupported } from "./deployment-mode";
import { setHostedMode, isHostedMode } from "../configuration/guard";

describe("isLocalItermCorrelationSupported", () => {
  afterEach(() => {
    // Never leak hosted-mode state across tests in this file or the suite.
    setHostedMode(false);
  });

  test("returns true on local (non-hosted) darwin", () => {
    expect(isHostedMode()).toBe(false); // sanity — starts unset
    expect(isLocalItermCorrelationSupported("darwin")).toBe(true);
  });

  test("returns false on non-darwin platforms, even local", () => {
    expect(isLocalItermCorrelationSupported("linux")).toBe(false);
    expect(isLocalItermCorrelationSupported("win32")).toBe(false);
  });

  test("returns false when hosted, even on darwin", () => {
    setHostedMode(true);
    expect(isLocalItermCorrelationSupported("darwin")).toBe(false);
  });

  test("defaults to the real process.platform when no override is passed", () => {
    // Whatever this test runner's actual platform is, the function must not
    // throw and must return a boolean — exercises the no-arg call path.
    expect(typeof isLocalItermCorrelationSupported()).toBe("boolean");
  });
});
