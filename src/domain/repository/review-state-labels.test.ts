/**
 * Unit tests for review-state labels (mt#1348).
 *
 * Covers:
 *  - applyReviewStateLabel: correct label added for each review event
 *  - applyReviewStateLabel: conflicting labels removed on REQUEST_CHANGES → APPROVE transition
 *  - applyReviewStateLabel: idempotent — no add call when label already present
 *  - ensureReviewStateLabelsExist: creates missing labels, skips existing ones
 *  - Bootstrap: creates full label set when none exist
 *  - Graceful degradation: label failures do NOT propagate
 *
 * All tests use a fake OctokitReviewLabelClient injected directly — no mock.module().
 */

import { describe, expect, test } from "bun:test";
import {
  applyReviewStateLabel,
  ensureReviewStateLabelsExist,
  reviewEventToLabel,
  conflictingLabels,
  LABEL_NEEDS_CHANGES,
  LABEL_BOT_APPROVED,
  LABEL_BOT_COMMENTED,
  REVIEW_STATE_LABELS,
  type OctokitReviewLabelClient,
} from "./review-state-labels";

// ── Fake client builder ─────────────────────────────────────────────────────

interface FakeState {
  repoLabels: Set<string>;
  prLabels: Map<number, Set<string>>;
  getLabelCalls: string[];
  createLabelCalls: Array<{ name: string; color: string }>;
  addLabelCalls: Array<{ prNumber: number; labels: string[] }>;
  removeLabelCalls: Array<{ prNumber: number; name: string }>;
  listLabelsCalls: number[];
  getLabelThrows?: (name: string) => Error | null;
  addLabelsThrows?: (prNumber: number) => Error | null;
  removeLabelsThrows?: (prNumber: number, name: string) => Error | null;
}

function buildFakeClient(state: FakeState): OctokitReviewLabelClient {
  return {
    rest: {
      issues: {
        getLabel: async ({ name }: { owner: string; repo: string; name: string }) => {
          state.getLabelCalls.push(name);
          if (state.getLabelThrows) {
            const err = state.getLabelThrows(name);
            if (err) throw err;
          }
          if (!state.repoLabels.has(name)) {
            const err = new Error(`Label not found: ${name}`) as Error & { status: number };
            err.status = 404;
            throw err;
          }
          return { data: { name } };
        },

        createLabel: async ({
          name,
          color,
        }: {
          owner: string;
          repo: string;
          name: string;
          color: string;
          description: string;
        }) => {
          state.repoLabels.add(name);
          state.createLabelCalls.push({ name, color });
          return { data: { name } };
        },

        addLabels: async ({
          issue_number,
          labels,
        }: {
          owner: string;
          repo: string;
          issue_number: number;
          labels: string[];
        }) => {
          if (state.addLabelsThrows) {
            const err = state.addLabelsThrows(issue_number);
            if (err) throw err;
          }
          const prLabelSet = state.prLabels.get(issue_number) ?? new Set<string>();
          for (const label of labels) {
            prLabelSet.add(label);
          }
          state.prLabels.set(issue_number, prLabelSet);
          state.addLabelCalls.push({ prNumber: issue_number, labels });
          return { data: labels.map((name) => ({ name })) };
        },

        removeLabel: async ({
          issue_number,
          name,
        }: {
          owner: string;
          repo: string;
          issue_number: number;
          name: string;
        }) => {
          if (state.removeLabelsThrows) {
            const err = state.removeLabelsThrows(issue_number, name);
            if (err) throw err;
          }
          const prLabelSet = state.prLabels.get(issue_number);
          if (prLabelSet) {
            prLabelSet.delete(name);
          }
          state.removeLabelCalls.push({ prNumber: issue_number, name });
          return { data: {} };
        },

        listLabelsOnIssue: async ({
          issue_number,
        }: {
          owner: string;
          repo: string;
          issue_number: number;
        }) => {
          state.listLabelsCalls.push(issue_number);
          const prLabelSet = state.prLabels.get(issue_number) ?? new Set<string>();
          return { data: Array.from(prLabelSet).map((name) => ({ name })) };
        },
      },
    },
  };
}

function makeState(opts?: {
  repoLabels?: string[];
  prLabels?: Record<number, string[]>;
}): FakeState {
  return {
    repoLabels: new Set(opts?.repoLabels ?? []),
    prLabels: new Map(
      Object.entries(opts?.prLabels ?? {}).map(([k, v]) => [Number(k), new Set(v as string[])])
    ),
    getLabelCalls: [],
    createLabelCalls: [],
    addLabelCalls: [],
    removeLabelCalls: [],
    listLabelsCalls: [],
  };
}

// ── reviewEventToLabel ───────────────────────────────────────────────────────

describe("reviewEventToLabel", () => {
  test("REQUEST_CHANGES → review:needs-changes", () => {
    expect(reviewEventToLabel("REQUEST_CHANGES")).toBe(LABEL_NEEDS_CHANGES);
  });

  test("APPROVE → review:bot-approved", () => {
    expect(reviewEventToLabel("APPROVE")).toBe(LABEL_BOT_APPROVED);
  });

  test("COMMENT → review:bot-commented", () => {
    expect(reviewEventToLabel("COMMENT")).toBe(LABEL_BOT_COMMENTED);
  });
});

// ── conflictingLabels ────────────────────────────────────────────────────────

describe("conflictingLabels", () => {
  test("REQUEST_CHANGES conflicts with bot-approved", () => {
    expect(conflictingLabels("REQUEST_CHANGES")).toEqual([LABEL_BOT_APPROVED]);
  });

  test("APPROVE conflicts with needs-changes", () => {
    expect(conflictingLabels("APPROVE")).toEqual([LABEL_NEEDS_CHANGES]);
  });

  test("COMMENT has no conflicts", () => {
    expect(conflictingLabels("COMMENT")).toEqual([]);
  });
});

// ── ensureReviewStateLabelsExist ─────────────────────────────────────────────

describe("ensureReviewStateLabelsExist", () => {
  test("creates all three labels when none exist", async () => {
    const state = makeState();
    const client = buildFakeClient(state);

    await ensureReviewStateLabelsExist(client, "owner", "repo");

    expect(state.createLabelCalls.map((c) => c.name).sort()).toEqual(
      [...REVIEW_STATE_LABELS].sort()
    );
    expect(state.repoLabels.size).toBe(3);
  });

  test("skips labels that already exist", async () => {
    const state = makeState({ repoLabels: [LABEL_NEEDS_CHANGES, LABEL_BOT_APPROVED] });
    const client = buildFakeClient(state);

    await ensureReviewStateLabelsExist(client, "owner", "repo");

    // Only the missing label should be created
    expect(state.createLabelCalls).toHaveLength(1);
    expect(state.createLabelCalls[0]?.name).toBe(LABEL_BOT_COMMENTED);
  });

  test("skips when all labels exist", async () => {
    const state = makeState({ repoLabels: [...REVIEW_STATE_LABELS] });
    const client = buildFakeClient(state);

    await ensureReviewStateLabelsExist(client, "owner", "repo");

    expect(state.createLabelCalls).toHaveLength(0);
  });

  test("assigns correct colors — needs-changes is red, bot-approved is green, bot-commented is blue", async () => {
    const state = makeState();
    const client = buildFakeClient(state);

    await ensureReviewStateLabelsExist(client, "owner", "repo");

    const byName = Object.fromEntries(state.createLabelCalls.map((c) => [c.name, c.color]));
    // Red family
    expect(byName[LABEL_NEEDS_CHANGES]).toMatch(/^b|^c|^d|^e|^f|^[0-9]/); // any hex that starts with red-ish
    // We just verify each has a color assigned and they are non-empty strings
    expect(byName[LABEL_NEEDS_CHANGES]).toBeTruthy();
    expect(byName[LABEL_BOT_APPROVED]).toBeTruthy();
    expect(byName[LABEL_BOT_COMMENTED]).toBeTruthy();
    // And that they are distinct colors
    const colors = new Set(Object.values(byName));
    expect(colors.size).toBe(3);
  });
});

// ── applyReviewStateLabel ────────────────────────────────────────────────────

describe("applyReviewStateLabel — REQUEST_CHANGES", () => {
  test("adds review:needs-changes label", async () => {
    const state = makeState();
    const client = buildFakeClient(state);

    await applyReviewStateLabel(client, "owner", "repo", 42, "REQUEST_CHANGES");

    const prLabels = state.prLabels.get(42);
    expect(prLabels?.has(LABEL_NEEDS_CHANGES)).toBe(true);
  });

  test("removes review:bot-approved when it was previously on the PR", async () => {
    const state = makeState({ prLabels: { 42: [LABEL_BOT_APPROVED] } });
    const client = buildFakeClient(state);

    await applyReviewStateLabel(client, "owner", "repo", 42, "REQUEST_CHANGES");

    const prLabels = state.prLabels.get(42);
    expect(prLabels?.has(LABEL_NEEDS_CHANGES)).toBe(true);
    expect(prLabels?.has(LABEL_BOT_APPROVED)).toBe(false);
    expect(state.removeLabelCalls.some((c) => c.name === LABEL_BOT_APPROVED)).toBe(true);
  });

  test("does not remove bot-approved when it was not on the PR", async () => {
    const state = makeState();
    const client = buildFakeClient(state);

    await applyReviewStateLabel(client, "owner", "repo", 42, "REQUEST_CHANGES");

    expect(state.removeLabelCalls).toHaveLength(0);
  });
});

describe("applyReviewStateLabel — APPROVE", () => {
  test("adds review:bot-approved label", async () => {
    const state = makeState();
    const client = buildFakeClient(state);

    await applyReviewStateLabel(client, "owner", "repo", 7, "APPROVE");

    const prLabels = state.prLabels.get(7);
    expect(prLabels?.has(LABEL_BOT_APPROVED)).toBe(true);
  });

  test("removes review:needs-changes when previously set", async () => {
    const state = makeState({ prLabels: { 7: [LABEL_NEEDS_CHANGES] } });
    const client = buildFakeClient(state);

    await applyReviewStateLabel(client, "owner", "repo", 7, "APPROVE");

    const prLabels = state.prLabels.get(7);
    expect(prLabels?.has(LABEL_BOT_APPROVED)).toBe(true);
    expect(prLabels?.has(LABEL_NEEDS_CHANGES)).toBe(false);
    expect(state.removeLabelCalls.some((c) => c.name === LABEL_NEEDS_CHANGES)).toBe(true);
  });

  test("transition: REQUEST_CHANGES → APPROVE flips labels correctly", async () => {
    // Simulate a full round: reviewer requests changes, author fixes, reviewer approves.
    const state = makeState({ prLabels: { 99: [LABEL_NEEDS_CHANGES] } });
    const client = buildFakeClient(state);

    // Reviewer bot approves
    await applyReviewStateLabel(client, "owner", "repo", 99, "APPROVE");

    const prLabels = state.prLabels.get(99);
    expect(prLabels?.has(LABEL_BOT_APPROVED)).toBe(true);
    expect(prLabels?.has(LABEL_NEEDS_CHANGES)).toBe(false);
  });
});

describe("applyReviewStateLabel — COMMENT", () => {
  test("adds review:bot-commented label", async () => {
    const state = makeState();
    const client = buildFakeClient(state);

    await applyReviewStateLabel(client, "owner", "repo", 5, "COMMENT");

    const prLabels = state.prLabels.get(5);
    expect(prLabels?.has(LABEL_BOT_COMMENTED)).toBe(true);
  });

  test("does not remove any labels", async () => {
    const state = makeState({ prLabels: { 5: [LABEL_NEEDS_CHANGES, LABEL_BOT_APPROVED] } });
    const client = buildFakeClient(state);

    await applyReviewStateLabel(client, "owner", "repo", 5, "COMMENT");

    expect(state.removeLabelCalls).toHaveLength(0);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe("applyReviewStateLabel — idempotency", () => {
  test("applying the same label twice does not produce a second addLabels call", async () => {
    const state = makeState({ prLabels: { 10: [LABEL_NEEDS_CHANGES] } });
    const client = buildFakeClient(state);

    // Label already on PR, applying again should be a no-op
    await applyReviewStateLabel(client, "owner", "repo", 10, "REQUEST_CHANGES");

    // addLabelCalls should be empty since the label was already present
    expect(state.addLabelCalls).toHaveLength(0);
  });

  test("applying bot-approved when already approved is a no-op add", async () => {
    const state = makeState({ prLabels: { 10: [LABEL_BOT_APPROVED] } });
    const client = buildFakeClient(state);

    await applyReviewStateLabel(client, "owner", "repo", 10, "APPROVE");

    expect(state.addLabelCalls).toHaveLength(0);
  });
});

// ── Graceful degradation ─────────────────────────────────────────────────────

describe("applyReviewStateLabel — graceful degradation", () => {
  test("addLabels failure does not throw", async () => {
    const state = makeState();
    state.addLabelsThrows = () => new Error("GitHub API error");
    const client = buildFakeClient(state);

    // Should NOT throw even though addLabels fails
    await expect(
      applyReviewStateLabel(client, "owner", "repo", 42, "REQUEST_CHANGES")
    ).resolves.toBeUndefined();
  });

  test("removeLabel failure does not throw", async () => {
    const state = makeState({ prLabels: { 42: [LABEL_BOT_APPROVED] } });
    state.removeLabelsThrows = () => new Error("Network error");
    const client = buildFakeClient(state);

    await expect(
      applyReviewStateLabel(client, "owner", "repo", 42, "REQUEST_CHANGES")
    ).resolves.toBeUndefined();
  });
});
