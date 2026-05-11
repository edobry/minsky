import { describe, expect, it } from "bun:test";
import { tasksTable, taskSpecsTable } from "../../../domain/storage/schemas/task-embeddings";
import {
  taskRelationshipsTable,
  PARENT_RELATIONSHIP_TYPE,
} from "../../../domain/storage/schemas/task-relationships";
import {
  buildAuditResult,
  fetchChildSnapshots,
  listEpicChildIds,
  type AuditDb,
} from "./epic-decomposition";
import type { EpicStalenessCandidate } from "../../../domain/detectors/epic-decomposition-staleness";

// ---------------------------------------------------------------------------
// Test helpers: in-memory db stub
// ---------------------------------------------------------------------------

/** Test stub for the AuditDb interface — captures select queries and returns canned rows. */
function makeStubDb(opts: {
  relationships?: Array<{ from: string; to: string; type: string }>;
  tasks?: Array<{
    id: string;
    title: string | null;
    status: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
  }>;
  specs?: Array<{ taskId: string; content: string }>;
}): AuditDb {
  const relationships = opts.relationships ?? [];
  const tasks = opts.tasks ?? [];
  const specs = opts.specs ?? [];

  // The drizzle fluent API: db.select(...).from(table).where(condition)
  // We don't replicate the query engine; we identify the target table by
  // identity and return the appropriate filtered shape based on which `from`
  // is invoked. The `where` clause is opaque — tests construct stubs scoped
  // tightly enough that filtering by table identity is sufficient.

  return {
    select(fields?: any) {
      void fields;
      return {
        from(table: any) {
          if (table === taskRelationshipsTable) {
            return {
              where(_condition: any) {
                return relationships.map((r) => ({ from: r.from }));
              },
            };
          }
          if (table === tasksTable) {
            return {
              where(_condition: any) {
                return tasks;
              },
            };
          }
          if (table === taskSpecsTable) {
            return {
              where(_condition: any) {
                return specs;
              },
            };
          }
          return { where: () => [] };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// listEpicChildIds
// ---------------------------------------------------------------------------

describe("listEpicChildIds", () => {
  it("returns child ids from the parent-edge query", async () => {
    const db = makeStubDb({
      relationships: [
        { from: "mt#100", to: "mt#999", type: PARENT_RELATIONSHIP_TYPE },
        { from: "mt#101", to: "mt#999", type: PARENT_RELATIONSHIP_TYPE },
      ],
    });
    const ids = await listEpicChildIds(db, "mt#999");
    expect(ids.sort()).toEqual(["mt#100", "mt#101"]);
  });

  it("returns empty array when no children exist", async () => {
    const db = makeStubDb({ relationships: [] });
    const ids = await listEpicChildIds(db, "mt#999");
    expect(ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchChildSnapshots
// ---------------------------------------------------------------------------

describe("fetchChildSnapshots", () => {
  it("returns empty when no ids supplied (no DB roundtrip needed)", async () => {
    const db = makeStubDb({});
    const snapshots = await fetchChildSnapshots(db, []);
    expect(snapshots).toEqual([]);
  });

  it("joins task rows and spec content by id", async () => {
    const db = makeStubDb({
      tasks: [
        {
          id: "mt#100",
          title: "child A",
          status: "TODO",
          createdAt: new Date("2026-04-01"),
          updatedAt: new Date("2026-04-02"),
        },
        {
          id: "mt#101",
          title: "child B",
          status: "DONE",
          createdAt: new Date("2026-04-01"),
          updatedAt: new Date("2026-05-01"),
        },
      ],
      specs: [
        { taskId: "mt#100", content: "## Scope\n**In scope:**\n- src/foo.ts" },
        { taskId: "mt#101", content: "## Scope\n**In scope:**\n- src/foo.ts" },
      ],
    });
    const snapshots = await fetchChildSnapshots(db, ["mt#100", "mt#101"]);
    expect(snapshots).toHaveLength(2);
    const byId = new Map(snapshots.map((s) => [s.id, s]));
    expect(byId.get("mt#100")?.title).toBe("child A");
    expect(byId.get("mt#100")?.status).toBe("TODO");
    expect(byId.get("mt#100")?.spec).toContain("src/foo.ts");
    expect(byId.get("mt#101")?.status).toBe("DONE");
  });

  it("handles missing spec gracefully (empty string)", async () => {
    const db = makeStubDb({
      tasks: [
        {
          id: "mt#100",
          title: "no-spec",
          status: "TODO",
          createdAt: new Date("2026-04-01"),
          updatedAt: new Date("2026-04-02"),
        },
      ],
      specs: [],
    });
    const snapshots = await fetchChildSnapshots(db, ["mt#100"]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.spec).toBe("");
  });

  it("coerces null status/title to defaults", async () => {
    const db = makeStubDb({
      tasks: [{ id: "mt#100", title: null, status: null, createdAt: null, updatedAt: null }],
      specs: [],
    });
    const snapshots = await fetchChildSnapshots(db, ["mt#100"]);
    expect(snapshots[0]?.title).toBe("");
    expect(snapshots[0]?.status).toBe("TODO");
    expect(snapshots[0]?.createdAt).toBeUndefined();
    expect(snapshots[0]?.updatedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildAuditResult
// ---------------------------------------------------------------------------

describe("buildAuditResult", () => {
  it("groups candidates by todoChildId", () => {
    const candidates: EpicStalenessCandidate[] = [
      {
        todoChildId: "mt#100",
        todoChildTitle: "todo A",
        todoChildStatus: "TODO",
        todoChildCreatedAt: new Date("2026-04-01"),
        deliveringSiblingId: "mt#200",
        deliveringSiblingTitle: "delivery 1",
        deliveringSiblingDeliveredAt: new Date("2026-05-01"),
        overlap: {
          filePaths: ["src/foo.ts"],
          identifiers: [],
          keywords: [],
          signalTypeCount: 1,
          totalTokenCount: 1,
        },
      },
      {
        todoChildId: "mt#100",
        todoChildTitle: "todo A",
        todoChildStatus: "TODO",
        todoChildCreatedAt: new Date("2026-04-01"),
        deliveringSiblingId: "mt#201",
        deliveringSiblingTitle: "delivery 2",
        deliveringSiblingDeliveredAt: new Date("2026-05-02"),
        overlap: {
          filePaths: [],
          identifiers: ["doThing"],
          keywords: [],
          signalTypeCount: 1,
          totalTokenCount: 1,
        },
      },
      {
        todoChildId: "mt#101",
        todoChildTitle: "todo B",
        todoChildStatus: "PLANNING",
        todoChildCreatedAt: undefined,
        deliveringSiblingId: "mt#200",
        deliveringSiblingTitle: "delivery 1",
        deliveringSiblingDeliveredAt: new Date("2026-05-01"),
        overlap: {
          filePaths: [],
          identifiers: [],
          keywords: ["reviewer"],
          signalTypeCount: 1,
          totalTokenCount: 1,
        },
      },
    ];

    const result = buildAuditResult("mt#999", 25, candidates);
    expect(result.epicId).toBe("mt#999");
    expect(result.totalChildren).toBe(25);
    expect(Object.keys(result.candidatesByTodoChild).sort()).toEqual(["mt#100", "mt#101"]);

    const m100 = result.candidatesByTodoChild["mt#100"];
    expect(m100?.deliveringSiblings).toHaveLength(2);
    expect(m100?.deliveringSiblings.map((s) => s.id).sort()).toEqual(["mt#200", "mt#201"]);

    const m101 = result.candidatesByTodoChild["mt#101"];
    expect(m101?.deliveringSiblings).toHaveLength(1);
    expect(m101?.todoChildCreatedAt).toBeUndefined();
  });

  it("returns empty mapping when no candidates", () => {
    const result = buildAuditResult("mt#999", 10, []);
    expect(Object.keys(result.candidatesByTodoChild)).toHaveLength(0);
    expect(result.totalChildren).toBe(10);
  });

  it("includes detector id and version for audit traceability", () => {
    const result = buildAuditResult("mt#999", 0, []);
    expect(result.detectorId).toBe("epic-decomposition-staleness");
    expect(result.detectorVersion).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});
