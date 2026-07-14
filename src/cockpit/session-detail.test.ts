/**
 * Unit tests for the changeset recency ordering helpers (mt#1920 R1).
 *
 * Pins the contract the reviewer flagged: `/api/changesets` orders newest-first
 * by a recency PROXY (lastActivityAt, falling back to createdAt), NOT by
 * session.createdAt alone. These tests exercise the pure comparator directly.
 */
import { describe, test, expect } from "bun:test";
import {
  changesetRecencyTimestamp,
  compareChangesetsByRecency,
  pickBestConversationLink,
  pickBestWorkspaceLink,
  type ChangesetRecencyFields,
  type ConversationLinkCandidate,
  type WorkspaceLinkCandidate,
} from "./session-detail";

function cs(lastActivityAt: string | null, createdAt: string | null) {
  return { session: { lastActivityAt, createdAt } satisfies ChangesetRecencyFields };
}

describe("changesetRecencyTimestamp", () => {
  test("prefers lastActivityAt over createdAt", () => {
    const t = changesetRecencyTimestamp({
      lastActivityAt: "2026-06-25T00:00:00Z",
      createdAt: "2026-06-01T00:00:00Z",
    });
    expect(t).toBe(new Date("2026-06-25T00:00:00Z").getTime());
  });

  test("falls back to createdAt when lastActivityAt is null", () => {
    const t = changesetRecencyTimestamp({
      lastActivityAt: null,
      createdAt: "2026-06-01T00:00:00Z",
    });
    expect(t).toBe(new Date("2026-06-01T00:00:00Z").getTime());
  });

  test("returns 0 when neither timestamp is present", () => {
    expect(changesetRecencyTimestamp({ lastActivityAt: null, createdAt: null })).toBe(0);
  });

  test("returns 0 for an unparseable timestamp", () => {
    expect(changesetRecencyTimestamp({ lastActivityAt: "not-a-date", createdAt: null })).toBe(0);
  });
});

describe("compareChangesetsByRecency", () => {
  test("orders newest-first by the recency proxy", () => {
    const older = cs("2026-06-01T00:00:00Z", "2026-05-01T00:00:00Z");
    const newer = cs("2026-06-25T00:00:00Z", "2026-05-01T00:00:00Z");
    const sorted = [older, newer].sort(compareChangesetsByRecency);
    expect(sorted[0]).toBe(newer);
    expect(sorted[1]).toBe(older);
  });

  test("uses lastActivityAt, not createdAt, as the sort key", () => {
    // `recent` was created earliest but is the most-recently-active — it must
    // sort first. A createdAt-only sort (the pre-fix behavior) would invert this.
    const recent = cs("2026-06-25T00:00:00Z", "2026-01-01T00:00:00Z");
    const stale = cs("2026-06-02T00:00:00Z", "2026-06-20T00:00:00Z");
    const sorted = [stale, recent].sort(compareChangesetsByRecency);
    expect(sorted[0]).toBe(recent);
    expect(sorted[1]).toBe(stale);
  });

  test("a session with null lastActivityAt sorts by its createdAt", () => {
    const a = cs(null, "2026-06-20T00:00:00Z"); // createdAt proxy (Jun 20)
    const b = cs("2026-06-10T00:00:00Z", "2026-01-01T00:00:00Z"); // lastActivity Jun 10
    const sorted = [b, a].sort(compareChangesetsByRecency);
    expect(sorted[0]).toBe(a);
    expect(sorted[1]).toBe(b);
  });

  test("rows with no recency data sort last", () => {
    const dated = cs("2026-06-01T00:00:00Z", null);
    const undated = cs(null, null);
    const sorted = [undated, dated].sort(compareChangesetsByRecency);
    expect(sorted[0]).toBe(dated);
    expect(sorted[1]).toBe(undated);
  });
});

// ---------------------------------------------------------------------------
// pickBestConversationLink (mt#2441 — minsky_session_links consultation order)
// ---------------------------------------------------------------------------

function candidate(
  agentSessionId: string,
  confidence: number | null,
  startedAt: string | null = null
): ConversationLinkCandidate {
  return { agentSessionId, confidence, startedAt };
}

describe("pickBestConversationLink", () => {
  test("returns null for an empty candidate list", () => {
    expect(pickBestConversationLink([])).toBeNull();
  });

  test("returns the sole candidate when there is exactly one", () => {
    const only = candidate("agent-a", 1.0, "2026-06-01T00:00:00Z");
    expect(pickBestConversationLink([only])).toEqual({ agentSessionId: "agent-a" });
  });

  test("prefers higher confidence (exact cwd match over descendant match)", () => {
    const descendant = candidate("agent-descendant", 0.8, "2026-06-05T00:00:00Z");
    const exact = candidate("agent-exact", 1.0, "2026-06-01T00:00:00Z");
    // exact has an OLDER startedAt but higher confidence — confidence wins.
    const result = pickBestConversationLink([descendant, exact]);
    expect(result).toEqual({ agentSessionId: "agent-exact" });
  });

  test("breaks confidence ties by most-recent startedAt", () => {
    const older = candidate("agent-older", 1.0, "2026-06-01T00:00:00Z");
    const newer = candidate("agent-newer", 1.0, "2026-06-10T00:00:00Z");
    const result = pickBestConversationLink([older, newer]);
    expect(result).toEqual({ agentSessionId: "agent-newer" });
  });

  test("treats a null confidence as lowest (0)", () => {
    const nullConfidence = candidate("agent-null", null, "2026-06-20T00:00:00Z");
    const zeroPointFive = candidate("agent-half", 0.5, "2026-06-01T00:00:00Z");
    const result = pickBestConversationLink([nullConfidence, zeroPointFive]);
    expect(result).toEqual({ agentSessionId: "agent-half" });
  });

  test("treats a null startedAt as oldest when breaking a confidence tie", () => {
    const noStartedAt = candidate("agent-no-started-at", 1.0, null);
    const withStartedAt = candidate("agent-with-started-at", 1.0, "2026-01-01T00:00:00Z");
    const result = pickBestConversationLink([noStartedAt, withStartedAt]);
    expect(result).toEqual({ agentSessionId: "agent-with-started-at" });
  });

  test("is order-independent — same winner regardless of input order", () => {
    const a = candidate("agent-a", 0.8, "2026-06-10T00:00:00Z");
    const b = candidate("agent-b", 1.0, "2026-06-01T00:00:00Z");
    const c = candidate("agent-c", 0.8, "2026-06-05T00:00:00Z");
    expect(pickBestConversationLink([a, b, c])).toEqual({ agentSessionId: "agent-b" });
    expect(pickBestConversationLink([c, a, b])).toEqual({ agentSessionId: "agent-b" });
    expect(pickBestConversationLink([b, c, a])).toEqual({ agentSessionId: "agent-b" });
  });

  // mt#2756 — the caller's query (routes/agents.ts) is link-class agnostic:
  // it fetches every minsky_session_links row for a workspace session
  // regardless of link_type, so a subagent_spawn candidate and a cwd_match
  // candidate for the SAME workspace both arrive here as plain
  // ConversationLinkCandidate objects. pickBestConversationLink doesn't need
  // to know link_type at all — confidence + recency alone decide the winner.
  describe("subagent_spawn + cwd_match combined resolution (mt#2756)", () => {
    const DISPATCHED_SUBAGENT_ID = "agent-dispatched-subagent";

    test("a subagent_spawn link (confidence 1.0) wins over a lower-confidence cwd_match descendant link", () => {
      // Dominant fleet shape (mt#2749): the dispatched subagent's own transcript
      // never chdir's into the workspace, so if a cwd_match link exists at all
      // for this workspace it's for a DIFFERENT, unrelated conversation with a
      // lower (descendant) confidence — the spawn link should still win.
      const cwdMatchDescendant = candidate("agent-cwd-descendant", 0.8, "2026-07-01T00:00:00Z");
      const subagentSpawn = candidate(DISPATCHED_SUBAGENT_ID, 1.0, "2026-06-20T00:00:00Z");
      const result = pickBestConversationLink([cwdMatchDescendant, subagentSpawn]);
      expect(result).toEqual({ agentSessionId: DISPATCHED_SUBAGENT_ID });
    });

    test("only a subagent_spawn link exists (the common case) — it resolves alone", () => {
      const subagentSpawn = candidate(DISPATCHED_SUBAGENT_ID, 1.0, "2026-06-20T00:00:00Z");
      expect(pickBestConversationLink([subagentSpawn])).toEqual({
        agentSessionId: DISPATCHED_SUBAGENT_ID,
      });
    });

    test("an exact cwd_match (confidence 1.0) and a subagent_spawn link (confidence 1.0) tie-break by recency", () => {
      const cwdMatchExact = candidate("agent-cwd-exact", 1.0, "2026-07-01T00:00:00Z");
      const subagentSpawn = candidate(DISPATCHED_SUBAGENT_ID, 1.0, "2026-06-20T00:00:00Z");
      // cwdMatchExact is more recent — recency wins the confidence tie.
      const result = pickBestConversationLink([cwdMatchExact, subagentSpawn]);
      expect(result).toEqual({ agentSessionId: "agent-cwd-exact" });
    });
  });
});

// ---------------------------------------------------------------------------
// pickBestWorkspaceLink (mt#2768 — reverse join: conversation -> workspace)
// ---------------------------------------------------------------------------

function workspaceCandidate(
  minskySessionId: string,
  confidence: number | null,
  detectedAt: string | null = null
): WorkspaceLinkCandidate {
  return { minskySessionId, confidence, detectedAt };
}

describe("pickBestWorkspaceLink", () => {
  test("returns null for an empty candidate list", () => {
    expect(pickBestWorkspaceLink([])).toBeNull();
  });

  test("returns the sole candidate when there is exactly one", () => {
    const only = workspaceCandidate("workspace-a", 1.0, "2026-06-01T00:00:00Z");
    expect(pickBestWorkspaceLink([only])).toEqual({ minskySessionId: "workspace-a" });
  });

  test("prefers higher confidence", () => {
    const lower = workspaceCandidate("workspace-lower", 0.8, "2026-06-05T00:00:00Z");
    const higher = workspaceCandidate("workspace-higher", 1.0, "2026-06-01T00:00:00Z");
    const result = pickBestWorkspaceLink([lower, higher]);
    expect(result).toEqual({ minskySessionId: "workspace-higher" });
  });

  test("breaks confidence ties by most-recently-detected link", () => {
    const older = workspaceCandidate("workspace-older", 1.0, "2026-06-01T00:00:00Z");
    const newer = workspaceCandidate("workspace-newer", 1.0, "2026-06-10T00:00:00Z");
    const result = pickBestWorkspaceLink([older, newer]);
    expect(result).toEqual({ minskySessionId: "workspace-newer" });
  });

  test("treats a null confidence as lowest (0)", () => {
    const nullConfidence = workspaceCandidate("workspace-null", null, "2026-06-20T00:00:00Z");
    const zeroPointFive = workspaceCandidate("workspace-half", 0.5, "2026-06-01T00:00:00Z");
    const result = pickBestWorkspaceLink([nullConfidence, zeroPointFive]);
    expect(result).toEqual({ minskySessionId: "workspace-half" });
  });

  test("is order-independent — same winner regardless of input order", () => {
    const a = workspaceCandidate("workspace-a", 0.8, "2026-06-10T00:00:00Z");
    const b = workspaceCandidate("workspace-b", 1.0, "2026-06-01T00:00:00Z");
    const c = workspaceCandidate("workspace-c", 0.8, "2026-06-05T00:00:00Z");
    expect(pickBestWorkspaceLink([a, b, c])).toEqual({ minskySessionId: "workspace-b" });
    expect(pickBestWorkspaceLink([c, a, b])).toEqual({ minskySessionId: "workspace-b" });
    expect(pickBestWorkspaceLink([b, c, a])).toEqual({ minskySessionId: "workspace-b" });
  });
});
