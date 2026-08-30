import { describe, test, expect } from "bun:test";
import type { RefResolvers } from "../refs";
import { prepareWorkPackageCreate } from "./work-package-create-prep";

/** Resolvers backed by a fixed map of known refs → status. */
function makeResolvers(known: Record<string, string>): RefResolvers {
  const lookup = async (id: string) =>
    id in known ? { found: true as const, status: known[id] } : { found: false as const };
  return {
    getTaskStatus: lookup,
    getChangesetStatus: lookup,
    getAskState: lookup,
    getMemoryState: lookup,
    getWorkspaceState: lookup,
  };
}

const VALID_GROOMED = `Origin: groomed

## Members

1. mt#101 — first
2. mt#102 — second

## Grouping rationale

Same widget.
`;

describe("prepareWorkPackageCreate", () => {
  test("valid groomed briefing with resolvable refs: ok, statuses captured for F7", async () => {
    const outcome = await prepareWorkPackageCreate(
      VALID_GROOMED,
      makeResolvers({ "mt#101": "READY", "mt#102": "TODO" })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.parsed.members).toHaveLength(2);
      expect(outcome.refStatuses.get("mt#101")).toBe("READY");
      expect(outcome.refStatuses.get("mt#102")).toBe("TODO");
    }
  });

  test("structural failure is reported alone — the ref sweep never runs on it", async () => {
    let resolverCalls = 0;
    const resolvers = makeResolvers({});
    const counting: RefResolvers = {
      ...resolvers,
      getTaskStatus: async (id) => {
        resolverCalls += 1;
        return resolvers.getTaskStatus(id);
      },
    };
    const outcome = await prepareWorkPackageCreate(
      "Origin: groomed\n\n## Members\n- mt#1\n",
      counting
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("invalid-briefing");
      expect(outcome.message).toContain("Grouping rationale");
    }
    expect(resolverCalls).toBe(0);
  });

  test("an unresolvable cited ref refuses NAMING the ref (mem#676 R5)", async () => {
    const outcome = await prepareWorkPackageCreate(
      VALID_GROOMED.replace("second", "second, see mem#9999"),
      makeResolvers({ "mt#101": "READY", "mt#102": "TODO" })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "unresolved-refs") {
      expect(outcome.unresolved.map((u) => u.ref)).toEqual(["mem#9999"]);
      expect(outcome.message).toContain("mem#9999");
    } else {
      throw new Error(`expected unresolved-refs, got ${JSON.stringify(outcome)}`);
    }
  });

  test("a briefing citing nothing (memberless succession) is ok with an empty status map", async () => {
    const outcome = await prepareWorkPackageCreate(
      "Origin: succession\n\n## Situation\n\nDone-ish.\n\n## Decisions\n\nNone.\n\n## Provenance\n\nOperator.\n",
      makeResolvers({})
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.refStatuses.size).toBe(0);
  });
});
