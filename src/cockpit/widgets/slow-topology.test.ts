/**
 * Unit tests for the slow-topology widget (mt#2602).
 *
 * Verifies fetch() reads ONLY the in-process cache (never derives per
 * request) and reports an honest "pending" status before the sweeper's first
 * tick has populated it.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { slowTopologyWidget, type SlowTopologyPayload } from "./slow-topology";
import { resetTopologyCacheForTests, setTopologyCacheForTests } from "../topology-cache";
import type { WeldEntry } from "../topology-derivation";

afterEach(() => {
  resetTopologyCacheForTests();
});

const sampleEntry: WeldEntry = {
  name: "check-branch-fresh",
  sourceDir: ".claude/hooks",
  installDate: "2026-01-01T00:00:00Z",
  commitSha: "abc1234abc1234abc1234abc1234abc1234abcd",
  commitUrl: "https://github.com/edobry/minsky/commit/abc1234abc1234abc1234abc1234abc1234abcd",
  retrospective: null,
};

describe("slowTopologyWidget.fetch", () => {
  test("reports 'pending' with an empty inventory before any cache write", async () => {
    const result = await slowTopologyWidget.fetch({ id: "slow-topology" });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const payload = result.payload as SlowTopologyPayload;
    expect(payload.status).toBe("pending");
    expect(payload.computedAt).toBeNull();
    expect(payload.interlockCount).toBe(0);
    expect(payload.entries).toEqual([]);
  });

  test("reports 'ready' with the cached snapshot once the sweeper has populated it", async () => {
    setTopologyCacheForTests({ entries: [sampleEntry], computedAt: "2026-06-01T00:00:00Z" });

    const result = await slowTopologyWidget.fetch({ id: "slow-topology" });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const payload = result.payload as SlowTopologyPayload;
    expect(payload.status).toBe("ready");
    expect(payload.computedAt).toBe("2026-06-01T00:00:00Z");
    expect(payload.interlockCount).toBe(1);
    expect(payload.entries).toEqual([sampleEntry]);
  });
});
