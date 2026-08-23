import { describe, test, expect } from "bun:test";
import {
  classifyRef,
  resolveRefs,
  renderOutcomeLabel,
  type RefResolvers,
  type RefStatusResult,
} from "./refs";

const ASK_UUID = "38b1c0de-1234-4abc-8def-000000000001";
const MEMORY_UUID = "87181969-2d58-4a41-bc5e-a0d328b36a2e";
const WORKSPACE_UUID = "e884fda2-ffd8-4342-b6cb-fedd91604fc5";

describe("classifyRef", () => {
  test("task ids", () => {
    expect(classifyRef("mt#123")).toEqual({ raw: "mt#123", kind: "task", id: "mt#123" });
    expect(classifyRef("md#456").kind).toBe("task");
  });

  test("PR numbers in all accepted spellings", () => {
    expect(classifyRef("123")).toEqual({ raw: "123", kind: "changeset", id: "123" });
    expect(classifyRef("#123").id).toBe("123");
    expect(classifyRef("PR #123").id).toBe("123");
    expect(classifyRef("pr#123").id).toBe("123");
  });

  test("pr prefix wins over the generic task pattern", () => {
    expect(classifyRef("pr#123").kind).toBe("changeset");
  });

  test("a bare uuid is not attributed to an entity by shape alone", () => {
    // Asks, memories, and workspaces are all uuid-keyed, so the token cannot
    // say which store holds it — `resolveRefs` narrows it (mt#3354).
    expect(classifyRef(ASK_UUID)).toEqual({ raw: ASK_UUID, kind: "uuid", id: ASK_UUID });
  });

  // mt#3354 AT4: the regression this task exists to prevent. Each of these
  // satisfies TASK_RE and used to be looked up in the task id-space.
  test("entity short ids are NOT classified as tasks", () => {
    expect(classifyRef("ask#6448").kind).toBe("ask");
    expect(classifyRef("mem#775").kind).toBe("memory");
    expect(classifyRef("ws#1").kind).toBe("workspace");
  });

  test("entity short ids classify case-insensitively, like the shared parser", () => {
    expect(classifyRef("Ask#6448").kind).toBe("ask");
    expect(classifyRef("MEM#775").kind).toBe("memory");
  });

  test("the reported id is the canonical short-id token, not the raw casing", () => {
    // Matches how a uuid is lower-cased, so a caller keying off `id` sees one
    // stable form regardless of how the ref was typed (PR #2451 R1).
    expect(classifyRef("Ask#6448").id).toBe("ask#6448");
    expect(classifyRef("MEM#775").id).toBe("mem#775");
    expect(classifyRef("WS#1").id).toBe("ws#1");
  });

  // mt#3354 AT5: reserving the three entity prefixes must not narrow the
  // open-ended task-backend registry.
  test("a non-entity prefix still classifies as a task ref", () => {
    expect(classifyRef("md#456").kind).toBe("task");
    expect(classifyRef("gh#12").kind).toBe("task");
    expect(classifyRef("mt#3354").kind).toBe("task");
  });

  test("unknown formats are explicit", () => {
    expect(classifyRef("not-a-ref").kind).toBe("unknown");
    expect(classifyRef("mt#").kind).toBe("unknown");
  });
});

/**
 * Model the real repository contract: the SAME record is reachable by EITHER id
 * form. That is what `askIdWhere` / `memoryIdWhere` / `resolveEntityIdPrefix`
 * already guarantee in production, so a fake that only answered to the uuid
 * would let a short-id routing regression pass.
 */
const byEitherForm =
  (uuid: string, shortId: string, record: { status: string; title: string }) =>
  async (id: string) => {
    const normalized = id.toLowerCase();
    return normalized === uuid || normalized === shortId
      ? { found: true, uuid, ...record }
      : { found: false };
  };

// Module-scoped so the outcome-discrimination block below reuses this one
// fixture rather than declaring a second, divergent copy of the same contract.
const resolvers: RefResolvers = {
  getTaskStatus: async (id) =>
    id === "mt#404" ? { found: false } : { found: true, status: "DONE", title: `Task ${id}` },
  getChangesetStatus: async (n) =>
    n === "404" ? { found: false } : { found: true, status: "open", title: `PR ${n}` },
  getAskState: byEitherForm(ASK_UUID, "ask#6448", { status: "closed", title: "An ask" }),
  getMemoryState: byEitherForm(MEMORY_UUID, "mem#775", {
    status: "project",
    title: "A memory",
  }),
  getWorkspaceState: byEitherForm(WORKSPACE_UUID, "ws#1", {
    status: "active",
    title: "mt#3354",
  }),
};

describe("resolveRefs", () => {
  test("resolves 6 mixed refs (3 tasks, 2 PRs, 1 ask) in one call", async () => {
    const results = await resolveRefs(
      ["mt#1", "mt#2", "mt#3", "100", "PR #200", ASK_UUID],
      resolvers
    );

    expect(results).toHaveLength(6);
    expect(results.map((r) => r.kind)).toEqual([
      "task",
      "task",
      "task",
      "changeset",
      "changeset",
      "ask",
    ]);
    expect(results.every((r) => r.found)).toBe(true);
    expect(results[3]?.status).toBe("open");
    expect(results[5]?.status).toBe("closed");
  });

  test("not-found is explicit per ref, without failing the rest", async () => {
    const results = await resolveRefs(["mt#404", "mt#1", "404"], resolvers);
    expect(results[0]).toMatchObject({ ref: "mt#404", found: false });
    expect(results[1]?.found).toBe(true);
    expect(results[2]).toMatchObject({ ref: "404", kind: "changeset", found: false });
  });

  test("a resolver error surfaces on that ref only", async () => {
    const throwing: RefResolvers = {
      ...resolvers,
      getChangesetStatus: async () => {
        throw new Error("GitHub unreachable");
      },
    };
    const results = await resolveRefs(["123", "mt#1"], throwing);
    expect(results[0]).toMatchObject({ found: false, outcome: "unavailable" });
    // The raw cause is logged, never returned (mt#4142) — see the leak test below.
    expect(results[0]?.error).not.toMatch(/GitHub unreachable/);
    expect(results[1]?.found).toBe(true);
  });

  test("unknown refs report the format error", async () => {
    const results = await resolveRefs(["garbage!"], resolvers);
    expect(results[0]?.found).toBe(false);
    expect(results[0]?.error).toMatch(/unrecognized ref format/);
  });

  // mt#3354 AT6: an unparseable ref must stay distinguishable from an absent
  // one. `found: false` alone is the same value both cases produce.
  test("an unparseable ref is distinguishable from a ref that does not exist", async () => {
    const [garbage, absent] = await resolveRefs(["garbage!", "mt#404"], resolvers);
    expect(garbage).toMatchObject({ kind: "unknown", found: false });
    expect(garbage?.error).toBeDefined();
    expect(absent).toMatchObject({ kind: "task", found: false });
    expect(absent?.error).toBeUndefined();
  });

  // mt#3354 AT1
  test("an ask resolves identically by short id and by uuid", async () => {
    const expected = { kind: "ask", found: true, status: "closed", title: "An ask" };
    const [short, long] = await resolveRefs(["ask#6448", ASK_UUID], resolvers);
    expect(short).toMatchObject(expected);
    expect(long).toMatchObject(expected);
  });

  // mt#3354 AT2 — the uuid half pins the false negative found during planning:
  // a real memory uuid used to report `kind: "ask", found: false`.
  test("a memory resolves identically by short id and by uuid", async () => {
    const expected = { kind: "memory", found: true, status: "project", title: "A memory" };
    const [short, long] = await resolveRefs(["mem#775", MEMORY_UUID], resolvers);
    expect(short).toMatchObject(expected);
    expect(long).toMatchObject(expected);
  });

  // mt#3354 AT3
  test("a workspace resolves identically by short id and by uuid", async () => {
    const [short, long] = await resolveRefs(["ws#1", WORKSPACE_UUID], resolvers);
    expect(short).toMatchObject({ kind: "workspace", found: true, status: "active" });
    expect(long).toMatchObject({ kind: "workspace", found: true, status: "active" });
  });

  // mt#3685 AT1/AT2: a short-id ref surfaces its full uuid, so a caller can
  // emit a minsky:// deeplink (ADR-029: the uuid is the sole link target)
  // without a second per-entity lookup.
  test("found uuid-keyed rows carry the full uuid alongside the short id", async () => {
    const [ask, memory, workspace] = await resolveRefs(["ask#6448", "mem#775", "ws#1"], resolvers);
    expect(ask?.uuid).toBe(ASK_UUID);
    expect(memory?.uuid).toBe(MEMORY_UUID);
    expect(workspace?.uuid).toBe(WORKSPACE_UUID);
  });

  test("a bare-uuid ref carries the uuid even when the resolver omits it", async () => {
    const noUuidField: RefResolvers = {
      ...resolvers,
      getAskState: async (id) =>
        id === ASK_UUID ? { found: true, status: "closed", title: "An ask" } : { found: false },
    };
    const [result] = await resolveRefs([ASK_UUID], noUuidField);
    expect(result?.uuid).toBe(ASK_UUID);
  });

  // mt#3685 AT3: kinds whose `id` already is the link target stay byte-stable —
  // no uuid key at all, not `uuid: undefined`.
  test("task and changeset rows carry no uuid key", async () => {
    const [task, changeset] = await resolveRefs(["mt#1", "100"], resolvers);
    expect(task && "uuid" in task).toBe(false);
    expect(changeset && "uuid" in changeset).toBe(false);
  });

  // mt#3685 AT4
  test("a not-found row carries no uuid key", async () => {
    const [absent] = await resolveRefs(["mt#404"], resolvers);
    expect(absent && "uuid" in absent).toBe(false);
  });

  test("a uuid held by no store stays kind uuid rather than a missing ask", async () => {
    const orphan = "00000000-0000-4000-8000-000000000000";
    const [result] = await resolveRefs([orphan], resolvers);
    expect(result).toMatchObject({ kind: "uuid", found: false });
    // No store errored — a clean miss carries no error.
    expect(result?.error).toBeUndefined();
  });

  test("a failing uuid store does not mask a hit in a later one", async () => {
    const flakyAsks: RefResolvers = {
      ...resolvers,
      getAskState: async () => {
        throw new Error("asks unreachable");
      },
    };
    const [result] = await resolveRefs([MEMORY_UUID], flakyAsks);
    expect(result).toMatchObject({ kind: "memory", found: true, status: "project" });
    expect(result?.error).toBeUndefined();
  });

  test("when every uuid store fails, each failure is surfaced", async () => {
    const allDown: RefResolvers = {
      ...resolvers,
      getAskState: async () => {
        throw new Error("asks down");
      },
      getMemoryState: async () => {
        throw new Error("memories down");
      },
      getWorkspaceState: async () => {
        throw new Error("workspaces down");
      },
    };
    const [result] = await resolveRefs([MEMORY_UUID], allDown);
    expect(result).toMatchObject({ found: false, outcome: "unavailable" });
    // This used to splice every store's raw message into `error`. mt#4142 moved
    // the causes to the log and kept the COUNT, which is the part a caller can
    // act on: 3 of 3 down is an outage, 1 of 3 is a partial degradation.
    expect(result?.error).toMatch(/3 of 3/);
    for (const cause of ["asks down", "memories down", "workspaces down"]) {
      expect(result?.error).not.toMatch(cause);
    }
  });

  test("one shared cause across every store is reported once, not three times", async () => {
    // The realistic total-failure case: the DB is down, so all three stores
    // throw the SAME message. Printing it three times on one CLI line is noise
    // (PR #2451 R1).
    const dbDown: RefResolvers = {
      ...resolvers,
      getAskState: async () => {
        throw new Error("DB unavailable");
      },
      getMemoryState: async () => {
        throw new Error("DB unavailable");
      },
      getWorkspaceState: async () => {
        throw new Error("DB unavailable");
      },
    };
    const [result] = await resolveRefs([MEMORY_UUID], dbDown);
    // The dedup this test was written for is retired: no cause is returned at
    // all now, so a repeated one cannot be repeated. What replaced it is the
    // property asserted here — one bounded sentence, whatever the stores said.
    expect(result?.error).toBe(
      "the uuid lookup did not complete against 3 of 3 stores — " +
        "this ref's existence is unknown, not disproven"
    );
    expect(result?.error).not.toMatch(/DB unavailable/);
  });
});

// mt#4142. `found: false` answered two questions at once — did the lookup
// COMPLETE, and did it MATCH — so an unreachable backend was indistinguishable
// from a ref that does not exist. ADR-035 rule 5 names that obligation
// (data-plane honesty); rule 4 supplies the word `unavailable`.
describe("outcome discriminates the three non-found cases", () => {
  const DRIZZLE_SHAPED =
    'Failed query: select "id", "short_id", "state" from "asks" ' +
    'where "asks"."short_id" = $1 limit $2\nparams: ask#8520,1';

  test("a driver message never reaches the result", async () => {
    const leaky: RefResolvers = {
      ...resolvers,
      getAskState: async () => {
        throw new Error(DRIZZLE_SHAPED);
      },
    };
    const [result] = await resolveRefs(["ask#8520"], leaky);

    expect(result?.outcome).toBe("unavailable");
    // Each fragment separately: a filter that dropped only one of them would
    // still be leaking, and asserting the whole string would not say which.
    for (const fragment of ["Failed query:", "params:", "select ", '"asks"', "$1"]) {
      expect(result?.error).not.toContain(fragment);
    }
    expect(result?.error).toMatch(/existence is unknown/);
  });

  test("absent, unavailable and unparseable are told apart in ONE call", async () => {
    const askDown: RefResolvers = {
      ...resolvers,
      getTaskStatus: async (id: string) => {
        if (id === "mt#500") throw new Error(DRIZZLE_SHAPED);
        return { found: false };
      },
    };
    const [absent, unavailable, unparseable, found] = await resolveRefs(
      ["mt#404", "mt#500", "garbage!", "ask#6448"],
      askDown
    );

    expect(absent).toMatchObject({ found: false, outcome: "absent" });
    expect(absent?.error).toBeUndefined();
    expect(unavailable).toMatchObject({ found: false, outcome: "unavailable" });
    expect(unparseable).toMatchObject({ found: false, outcome: "unparseable" });
    expect(found).toMatchObject({ found: true, outcome: "found" });

    // The point of the discriminator: `found` alone collapses the first three.
    expect(new Set([absent, unavailable, unparseable].map((r) => r?.found))).toEqual(
      new Set([false])
    );
    expect([absent, unavailable, unparseable].map((r) => r?.outcome)).toEqual([
      "absent",
      "unavailable",
      "unparseable",
    ]);
  });

  test("the rendered label distinguishes them too, not just the JSON", () => {
    const base = { ref: "x", kind: "task" as const, id: "x" };
    const label = (r: Partial<RefStatusResult>) =>
      renderOutcomeLabel({ ...base, found: false, outcome: "absent", ...r } as RefStatusResult);

    expect(label({ outcome: "absent" })).toBe("NOT FOUND");
    expect(label({ outcome: "unavailable", error: "backend down" })).toMatch(/^UNKNOWN/);
    expect(label({ outcome: "unparseable", error: "bad shape" })).toMatch(/^BAD REF/);
    expect(label({ found: true, outcome: "found", status: "TODO", title: "T" })).toBe("TODO  T");

    // The specific regression: an unreachable backend must not render the words
    // that assert the ref does not exist.
    expect(label({ outcome: "unavailable", error: "backend down" })).not.toMatch(/NOT FOUND/);
  });

  // PR #3041 R1: `status` is optional on ResolvedRef, so a hit without one used
  // to interpolate the literal string "undefined" into the status column.
  test("a found ref with no status does not render the word undefined", () => {
    const label = renderOutcomeLabel({
      ref: "mt#1",
      kind: "task",
      id: "mt#1",
      found: true,
      outcome: "found",
      title: "A task",
    });
    expect(label).not.toMatch(/undefined/);
    expect(label).toBe("FOUND  A task");
  });
});

describe("completion-manifest integrity", () => {
  // Regression guard for the generator (and evidence for PR #2009 review
  // rounds R1/R3, which asserted a duplicate top-level `refs` entry from the
  // cumulative diff — the block MOVED between commits, it was never
  // duplicated): the generated manifest must declare `refs` exactly once,
  // anywhere in the tree.
  test("the generated manifest declares exactly one refs command", async () => {
    const manifest = (await import("../../../generated/completion-manifest.json")) as {
      subcommands?: unknown[];
    };
    const countRefs = (nodes: unknown[]): number =>
      nodes.reduce((count: number, node) => {
        const rec = node as { name?: string; subcommands?: unknown[] };
        return (
          count +
          (rec.name === "refs" ? 1 : 0) +
          (Array.isArray(rec.subcommands) ? countRefs(rec.subcommands) : 0)
        );
      }, 0);
    expect(countRefs(manifest.subcommands ?? [])).toBe(1);
  });
});
