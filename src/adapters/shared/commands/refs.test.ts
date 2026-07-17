import { describe, test, expect } from "bun:test";
import { classifyRef, resolveRefs, type RefResolvers } from "./refs";

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

  test("ask uuids", () => {
    const uuid = "38b1c0de-1234-4abc-8def-000000000001";
    expect(classifyRef(uuid)).toEqual({ raw: uuid, kind: "ask", id: uuid });
  });

  test("unknown formats are explicit", () => {
    expect(classifyRef("not-a-ref").kind).toBe("unknown");
    expect(classifyRef("mt#").kind).toBe("unknown");
  });
});

describe("resolveRefs", () => {
  const resolvers: RefResolvers = {
    getTaskStatus: async (id) =>
      id === "mt#404" ? { found: false } : { found: true, status: "DONE", title: `Task ${id}` },
    getChangesetStatus: async (n) =>
      n === "404" ? { found: false } : { found: true, status: "open", title: `PR ${n}` },
    getAskState: async () => ({ found: true, status: "closed", title: "An ask" }),
  };

  test("resolves 6 mixed refs (3 tasks, 2 PRs, 1 ask) in one call", async () => {
    const uuid = "38b1c0de-1234-4abc-8def-000000000001";
    const results = await resolveRefs(["mt#1", "mt#2", "mt#3", "100", "PR #200", uuid], resolvers);

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
    expect(results[0]).toMatchObject({ found: false, error: "GitHub unreachable" });
    expect(results[1]?.found).toBe(true);
  });

  test("unknown refs report the format error", async () => {
    const results = await resolveRefs(["garbage!"], resolvers);
    expect(results[0]?.found).toBe(false);
    expect(results[0]?.error).toMatch(/unrecognized ref format/);
  });
});
