/**
 * Tests for the shared Braintrust emitter (mt#1778 extraction).
 *
 * The `readBraintrustConfig` function is already exercised end-to-end via
 * `.claude/hooks/memory-search.test.ts` (which re-exports from this module).
 * These tests focus on the new generic surface: `emitBraintrustEvent`'s
 * graceful-degradation contract under arbitrary input/output/metadata shapes,
 * which earlier callers (memory-search) didn't exercise because their event
 * shape was fixed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { emitBraintrustEvent, readBraintrustConfig } from "./braintrust";

describe("readBraintrustConfig (direct module surface)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BRAINTRUST_API_KEY;
    delete process.env.BRAINTRUST_PROJECT_NAME;
    delete process.env.BRAINTRUST_API_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when no apiKey is anywhere available", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/definitely-not-a-real-minsky-home-mt1778-1";
    const cfg = await readBraintrustConfig();
    expect(cfg).toBeNull();
    process.env.HOME = originalHome;
  });

  it("populates defaults for projectName and appUrl when only apiKey is set", async () => {
    process.env.BRAINTRUST_API_KEY = "sk-test-mt1778";
    const cfg = await readBraintrustConfig();
    expect(cfg?.apiKey).toBe("sk-test-mt1778");
    expect(cfg?.projectName).toBe("minsky");
    expect(cfg?.appUrl).toBe("https://api.braintrust.dev");
  });
});

describe("emitBraintrustEvent — graceful degradation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BRAINTRUST_API_KEY;
    delete process.env.BRAINTRUST_PROJECT_NAME;
    delete process.env.BRAINTRUST_API_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("does not throw when no Braintrust config is available (generic event)", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/definitely-not-a-real-minsky-home-mt1778-2";

    // Generic event with arbitrary input/output/metadata — exercises the new
    // generic surface beyond memory-search's fixed shape.
    await expect(
      emitBraintrustEvent({
        input: { kind: "mcp_disconnect", server: "minsky" },
        output: { cause: "stdin_close", uptimeMs: 12345, processRole: "main_session" },
        metadata: { source: "minsky.mcp.disconnect-tracker", testCase: "no-config" },
      })
    ).resolves.toBeUndefined();

    process.env.HOME = originalHome;
  });

  it("does not throw when event payload is empty", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/definitely-not-a-real-minsky-home-mt1778-3";

    // Minimum-viable event — no fields. Verifies the generic surface accepts
    // a fully-empty event without crashing.
    await expect(emitBraintrustEvent({})).resolves.toBeUndefined();

    process.env.HOME = originalHome;
  });

  it("does not throw when called with only metadata", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/definitely-not-a-real-minsky-home-mt1778-4";

    // Realistic shape for a counter-style metric (no input/output, only labels).
    await expect(
      emitBraintrustEvent({
        metadata: {
          source: "minsky.skills.retrospective",
          fireCount: 1,
        },
      })
    ).resolves.toBeUndefined();

    process.env.HOME = originalHome;
  });
});
