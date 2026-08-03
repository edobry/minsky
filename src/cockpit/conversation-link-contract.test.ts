/**
 * Contract test for the `source` discriminator on `GET /api/agents/:id`'s
 * `conversations[]` elements (mt#3529, PR #2523 R1).
 *
 * The route maps `resolveWorkspaceConversations`'s output straight onto the
 * response, so asserting the resolver's shape asserts the payload's. What this
 * guards is the thing a future edit could silently break: a branch that stops
 * emitting `source`, or emits a value outside the declared union. Both are
 * invisible to a typecheck once a caller widens the type, and invisible to the
 * existing tests, which only assert `agentSessionId`.
 *
 * The two branches are covered separately because they are separate code paths
 * with separate literals — a test that only exercised the stamped path would
 * pass while the derived path returned an undefined `source`.
 */
import { describe, expect, test } from "bun:test";

import { resolveWorkspaceConversations } from "./routes/agents";
import type { ConversationLinkSource } from "./conversation-link-source";

const WORKSPACE = "ws-contract-1";
const CONV_STAMPED = "984efc25-2e41-4e8a-ba56-6f5ff55220ac";
const CONV_DERIVED = "ac34711e-ad50-41dd-8e42-1af8828bf343";
const AGENT_ID = `com.anthropic.claude-code:conv:${CONV_DERIVED}`;

/** Every value the discriminator is allowed to take. */
const ALLOWED_SOURCES: ConversationLinkSource[] = ["link-row", "derived-agent-id"];

/**
 * Stub of the two query shapes the resolver issues, in order:
 *   1. the link-row join  (`select().from().innerJoin().where().orderBy()`)
 *   2. the derived existence check (`select().from().where()`)
 */
function stubDb(opts: {
  linkRows: Array<{ agentSessionId: string; confidence: number | null; startedAt: Date | null }>;
  transcriptRows: Array<{ agentSessionId: string; startedAt: Date | null }>;
}) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(opts.linkRows),
          }),
        }),
        where: () => Promise.resolve(opts.transcriptRows),
      }),
    }),
  };
}

function resolveWith(db: unknown, agentId: string | null) {
  // The db arrives through the injected getter rather than a module mock —
  // `custom/no-global-module-mocks` bans the latter, and injection is what the
  // rest of this directory (createAgentsWidget's factory params) already does.
  return resolveWorkspaceConversations(WORKSPACE, agentId, () => Promise.resolve(db as never));
}

describe("GET /api/agents/:id — conversations[].source contract", () => {
  test("a stamped link row is reported as source: link-row", async () => {
    const candidates = await resolveWith(
      stubDb({
        linkRows: [{ agentSessionId: CONV_STAMPED, confidence: 1, startedAt: null }],
        transcriptRows: [],
      }),
      AGENT_ID
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agentSessionId).toBe(CONV_STAMPED);
    expect(candidates[0]?.source).toBe("link-row");
  });

  test("a stamped row wins over the workspace's own agentId", async () => {
    // The agentId names CONV_DERIVED, but a writer stamped CONV_STAMPED. The
    // stamped row must win AND the derived candidate must not also appear.
    const candidates = await resolveWith(
      stubDb({
        linkRows: [{ agentSessionId: CONV_STAMPED, confidence: 1, startedAt: null }],
        transcriptRows: [{ agentSessionId: CONV_DERIVED, startedAt: null }],
      }),
      AGENT_ID
    );

    expect(candidates.map((c) => c.agentSessionId)).toEqual([CONV_STAMPED]);
  });

  test("the fallback is reported as source: derived-agent-id", async () => {
    const candidates = await resolveWith(
      stubDb({
        linkRows: [],
        transcriptRows: [{ agentSessionId: CONV_DERIVED, startedAt: null }],
      }),
      AGENT_ID
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agentSessionId).toBe(CONV_DERIVED);
    expect(candidates[0]?.source).toBe("derived-agent-id");
    // No writer confidence exists for a derived link; inventing one would let
    // it sort against real values in pickBestConversationLink.
    expect(candidates[0]?.confidence).toBeNull();
  });

  test("an unknown:hash workspace yields no candidate at all", async () => {
    const candidates = await resolveWith(
      stubDb({ linkRows: [], transcriptRows: [{ agentSessionId: CONV_DERIVED, startedAt: null }] }),
      "unknown:hash:3defa5b5675196ca"
    );

    expect(candidates).toEqual([]);
  });

  test("every emitted candidate carries a source from the declared union", async () => {
    // The cross-branch invariant: whatever path produced a candidate, the
    // discriminator is present and in-range. A branch that forgot it would
    // ship `undefined` to every consumer of the API.
    for (const fixture of [
      {
        linkRows: [{ agentSessionId: CONV_STAMPED, confidence: 1, startedAt: null }],
        transcriptRows: [],
      },
      { linkRows: [], transcriptRows: [{ agentSessionId: CONV_DERIVED, startedAt: null }] },
    ]) {
      const candidates = await resolveWith(stubDb(fixture), AGENT_ID);
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(ALLOWED_SOURCES).toContain(candidate.source);
      }
    }
  });

  test("no candidate is emitted when the DB is unavailable", async () => {
    const candidates = await resolveWith(null, AGENT_ID);
    expect(candidates).toEqual([]);
  });
});
