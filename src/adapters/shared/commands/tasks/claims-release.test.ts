/**
 * `tasks.claims.release` — ownership rule, caller identity, and the two
 * registrations whose absence makes the command inert over MCP (mt#4568).
 *
 * What is NOT here, and why: the Postgres round-trip. The repository primitives
 * this command composes (`listClaims`, `deleteByIds`) are already covered by
 * `packages/domain/src/presence/repository.test.ts` against real Postgres, and
 * the command adds no new persistence path — only an ownership filter over
 * rows they return. The live round-trip is `scripts/smoke-claims-release.ts`
 * (acceptance tests 1-3 and SC5), which is what actually exercises the delete.
 *
 * The two structural tests at the bottom are the ones that matter most here.
 * Both defects they guard produce the SAME signature — the command works over
 * the CLI and silently does nothing over MCP — which is the mem#1184 / mt#4408
 * R4 shape in this same claims subsystem, and is invisible to any test that
 * exercises only one invocation path.
 */
import { describe, test, expect } from "bun:test";

import { selectOwnClaims, createTasksClaimsReleaseCommand } from "./claims-command";
import { resolveCallerActorId } from "@minsky/domain/agent-identity/index";

const ACTOR_A = "com.anthropic.claude-code:conv:cbafdfe3-8d61-4e73-a679-e6f7ce9948a4";
const ACTOR_B = "com.anthropic.claude-code:conv:3a61b3a8-67a2-4536-8461-741a6c7f1b15";

function claim(id: string, actorId: string, claimedAt: string) {
  return { id, actorId, claimedAt, lastRefreshedAt: claimedAt };
}

describe("selectOwnClaims — the ownership rule", () => {
  test("selects the caller's claim and leaves a peer's untouched", () => {
    const claims = [
      claim("row-a", ACTOR_A, "2026-08-25T16:20:36.545Z"),
      claim("row-b", ACTOR_B, "2026-08-25T16:24:14.770Z"),
    ];

    const own = selectOwnClaims(claims, ACTOR_A);

    expect(own.map((c) => c.id)).toEqual(["row-a"]);
    // The peer's row is not merely absent from the result — it must be
    // untouched, since these ids are what the command passes to deleteByIds.
    expect(own.some((c) => c.actorId === ACTOR_B)).toBe(false);
  });

  test("replays the originating incident: A claims, B claims, A releases", () => {
    // The measured 2026-08-25 rows from mt#4566, which is what this task exists
    // for: A's claim was refreshed at 16:25:59 by its own handoff-notes write,
    // 105 seconds AFTER B had claimed, and both read stale:false.
    const claims = [
      {
        ...claim("row-a", ACTOR_A, "2026-08-25T16:20:36.545Z"),
        lastRefreshedAt: "2026-08-25T16:25:59.827Z",
      },
      {
        ...claim("row-b", ACTOR_B, "2026-08-25T16:24:14.770Z"),
        lastRefreshedAt: "2026-08-25T16:33:22.012Z",
      },
    ];

    const releasedByA = selectOwnClaims(claims, ACTOR_A);
    const survivors = claims.filter((c) => !releasedByA.includes(c));

    expect(releasedByA).toHaveLength(1);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.actorId).toBe(ACTOR_B);
  });

  test("releasing a claim you do not hold selects nothing", () => {
    const claims = [claim("row-b", ACTOR_B, "2026-08-25T16:24:14.770Z")];

    expect(selectOwnClaims(claims, ACTOR_A)).toEqual([]);
  });

  test("a stale conversation id matches nothing rather than matching approximately", () => {
    // mt#4440: a caller can resolve to a conversation id that is real but stale.
    // The exact-match rule means such a caller releases nothing, rather than
    // fuzzily matching a prefix and clearing a row it does not own.
    const staleButSameConversationPrefix = "com.anthropic.claude-code:conv:cbafdfe3";
    const claims = [claim("row-a", ACTOR_A, "2026-08-25T16:20:36.545Z")];

    expect(selectOwnClaims(claims, staleButSameConversationPrefix)).toEqual([]);
  });

  test("selects every row the caller holds, not just the first", () => {
    const claims = [
      claim("row-a1", ACTOR_A, "2026-08-25T16:20:36.545Z"),
      claim("row-b", ACTOR_B, "2026-08-25T16:24:14.770Z"),
      claim("row-a2", ACTOR_A, "2026-08-25T16:26:00.000Z"),
    ];

    expect(selectOwnClaims(claims, ACTOR_A).map((c) => c.id)).toEqual(["row-a1", "row-a2"]);
  });
});

describe("resolveCallerActorId — both invocation paths", () => {
  const ENV_KEYS = ["CLAUDE_AGENT_ID", "CLAUDE_CODE_SESSION_ID"] as const;

  function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void) {
    const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("the server-injected value wins over the harness environment", () => {
    // This precedence is the whole point: the MCP server is a long-lived daemon,
    // so any env var it carries names some OTHER conversation — possibly one
    // that is still live. Preferring the env would attribute the release to it.
    withEnv({ CLAUDE_AGENT_ID: ACTOR_B }, () => {
      expect(resolveCallerActorId(ACTOR_A)).toBe(ACTOR_A);
    });
  });

  test("falls back to CLAUDE_AGENT_ID when nothing was injected (CLI path)", () => {
    withEnv({ CLAUDE_AGENT_ID: ACTOR_B }, () => {
      expect(resolveCallerActorId(undefined)).toBe(ACTOR_B);
    });
  });

  test("derives a conversation-scoped id from CLAUDE_CODE_SESSION_ID", () => {
    withEnv({ CLAUDE_CODE_SESSION_ID: "3a61b3a8-67a2-4536-8461-741a6c7f1b15" }, () => {
      expect(resolveCallerActorId(undefined)).toBe(ACTOR_B);
    });
  });

  test("returns null when no source names the caller", () => {
    // Null is a real outcome, not a degradation: the command releases nothing
    // rather than deleting rows it cannot attribute to this caller.
    withEnv({}, () => {
      expect(resolveCallerActorId(undefined)).toBeNull();
      expect(resolveCallerActorId("   ")).toBeNull();
    });
  });
});

describe("the two registrations that decide whether this works over MCP", () => {
  test("readsPresence is declared, so the ambient write cannot re-stake the release", () => {
    // Without this flag `writeTaskClaim` runs AFTER the handler returns and
    // re-INSERTS the row the release just deleted — a no-op that reports
    // success. Asserted on the definition because that is where mt#3903 moved
    // the fact; the bridge-level "flags survive registration" assertion lives in
    // src/adapters/mcp/shared-command-integration.test.ts.
    const command = createTasksClaimsReleaseCommand(() => undefined);

    expect(command.readsPresence).toBe(true);
    expect(command.id).toBe("tasks.claims.release");
  });

  test("the command id is in CALLER_ACTOR_ID_TOOL_NAMES, matched on the resolved name", async () => {
    // The injection set is exact-match on the RESOLVED `tool.name`, which is always
    // the canonical dotted form (mt#4827) — so a Claude-Desktop alias caller still
    // matches without the set carrying a second spelling. A command missing from it
    // resolves no identity over MCP and releases nothing, while working correctly
    // over the CLI.
    const source = await Bun.file(
      new URL("../../../../mcp/server.ts", import.meta.url).pathname
    ).text();

    // Assert on the SET's contents rather than a bare grep for the string: the
    // name also appears in that file's prose, so a grep would pass on a comment
    // alone. This checks it is a member of the array the set is built from.
    const setBlock = source.slice(
      source.indexOf("const CALLER_ACTOR_ID_TOOL_NAMES"),
      source.indexOf("const DI_FREE_TOOL_NAMES")
    );
    expect(setBlock).toContain("CLAIMS_RELEASE_TOOL_NAME");
    expect(source).toContain('const CLAIMS_RELEASE_TOOL_NAME = "tasks.claims.release"');
    // The set holds canonical names ONLY; alias coverage comes from the call site
    // resolving the name first, not from the set carrying both spellings (mt#4827).
    // Assert the call site actually does that — without it, this set silently stops
    // matching every underscore-calling client, which is the defect mt#4827 fixed.
    expect(setBlock).not.toContain("toClaudeDesktopName");
    expect(source).toContain("CALLER_ACTOR_ID_TOOL_NAMES.has(tool.name)");
  });

  test("the effect classification marks it as mutating, not reading", async () => {
    const { MCP_COMMAND_EFFECTS } = await import("@minsky/shared/tool-effect");

    expect(MCP_COMMAND_EFFECTS["tasks.claims.release"]).toBe("mutates");
  });
});
