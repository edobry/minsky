/**
 * Tests for updatePrStateOnMerge and projectPrState — defensive projection that
 * strips unknown keys from persisted prState blobs.
 */

import { describe, it, expect } from "bun:test";
import { updatePrStateOnMerge, projectPrState } from "./session-update-operations";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";

describe("updatePrStateOnMerge — prState key projection", () => {
  it("strips commitHash and unknown keys from persisted prState on merge", async () => {
    // Arrange: session record with legacy commitHash + rogue foo key in prState
    const sessionRecord: SessionRecord = {
      sessionId: "test-session-1077",
      repoName: "minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: "2024-01-01T00:00:00.000Z",
      prState: {
        branchName: "pr/test-session-1077",
        exists: true,
        lastChecked: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
        // These extra keys simulate stale fields from older persisted JSON blobs:
        ...({ commitHash: "abc123", foo: "bar" } as unknown as object),
      } as SessionRecord["prState"],
    };

    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });

    // Act
    await updatePrStateOnMerge("test-session-1077", sessionDB);

    // Assert
    const updated = await sessionDB.getSession("test-session-1077");
    expect(updated).not.toBeNull();
    if (!updated) return; // type-narrowing only; expect above already fails if null

    const prState = updated.prState;
    expect(prState).not.toBeUndefined();
    if (!prState) return;

    // Known fields are preserved or set correctly
    expect(prState.branchName).toBe("pr/test-session-1077");
    expect(prState.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(prState.exists).toBe(false);
    expect(typeof prState.lastChecked).toBe("string");
    expect(typeof prState.mergedAt).toBe("string");

    // Unknown keys must not survive
    expect((prState as Record<string, unknown>)["commitHash"]).toBeUndefined();
    expect((prState as Record<string, unknown>)["foo"]).toBeUndefined();
  });

  it("is idempotent — clean prState stays clean after second call", async () => {
    const sessionRecord: SessionRecord = {
      sessionId: "test-session-clean",
      repoName: "minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: "2024-01-01T00:00:00.000Z",
      prState: {
        branchName: "pr/test-session-clean",
        exists: true,
        lastChecked: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    };

    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });

    await updatePrStateOnMerge("test-session-clean", sessionDB);
    await updatePrStateOnMerge("test-session-clean", sessionDB);

    const updated = await sessionDB.getSession("test-session-clean");
    expect(updated).not.toBeNull();
    if (!updated) return;

    const prState = updated.prState;
    expect(prState).not.toBeUndefined();
    if (!prState) return;

    expect(prState.exists).toBe(false);
    expect((prState as Record<string, unknown>)["commitHash"]).toBeUndefined();
  });

  it("returns early without error when prState is absent", async () => {
    const sessionRecord: SessionRecord = {
      sessionId: "test-session-no-prstate",
      repoName: "minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });

    // Should not throw
    await expect(
      updatePrStateOnMerge("test-session-no-prstate", sessionDB)
    ).resolves.toBeUndefined();

    const updated = await sessionDB.getSession("test-session-no-prstate");
    expect(updated).not.toBeNull();
    if (!updated) return;

    expect(updated.prState).toBeUndefined();
  });
});

describe("projectPrState — key projection helper", () => {
  it("strips commitHash and unknown keys from prState blob", () => {
    const legacy = {
      branchName: "pr/test-session",
      exists: true,
      lastChecked: "2024-01-01T00:00:00.000Z",
      createdAt: "2024-01-01T00:00:00.000Z",
      // Extra keys simulating older DB rows:
      ...({ commitHash: "abc123", rogueKey: "should-be-gone" } as unknown as object),
    } as NonNullable<SessionRecord["prState"]>;

    const projected = projectPrState(legacy);

    // Known fields are preserved
    expect(projected.branchName).toBe("pr/test-session");
    expect(projected.exists).toBe(true);
    expect(projected.lastChecked).toBe("2024-01-01T00:00:00.000Z");
    expect(projected.createdAt).toBe("2024-01-01T00:00:00.000Z");

    // Unknown keys must not survive
    expect((projected as Record<string, unknown>)["commitHash"]).toBeUndefined();
    expect((projected as Record<string, unknown>)["rogueKey"]).toBeUndefined();
  });

  it("preserves mergedAt when present", () => {
    const prState = {
      branchName: "pr/merged-session",
      exists: false,
      lastChecked: "2024-02-01T00:00:00.000Z",
      createdAt: "2024-01-01T00:00:00.000Z",
      mergedAt: "2024-02-01T12:00:00.000Z",
    } as NonNullable<SessionRecord["prState"]>;

    const projected = projectPrState(prState);

    expect(projected.mergedAt).toBe("2024-02-01T12:00:00.000Z");
    expect(projected.exists).toBe(false);
  });

  it("handles prState with only required fields", () => {
    const minimal = {
      branchName: "pr/minimal",
      lastChecked: "2024-01-01T00:00:00.000Z",
    } as NonNullable<SessionRecord["prState"]>;

    const projected = projectPrState(minimal);

    expect(projected.branchName).toBe("pr/minimal");
    expect(projected.lastChecked).toBe("2024-01-01T00:00:00.000Z");
    expect(projected.exists).toBeUndefined();
    expect(projected.createdAt).toBeUndefined();
    expect(projected.mergedAt).toBeUndefined();
  });
});
