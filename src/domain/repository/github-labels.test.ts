/**
 * Unit tests for github-labels.ts (mt#1957).
 *
 * Uses Octokit DI (octokitOverride) to assert call shape and mapping —
 * follows the github-checks-run.test.ts pattern. No module-level mocks
 * (custom/no-global-module-mocks forbids them).
 */

import { describe, expect, test, mock } from "bun:test";
import { createLabel, listLabels, updateLabel, deleteLabel, type Label } from "./github-labels";
import { MinskyError } from "../../errors/index";

const TEST_GH = {
  owner: "test-owner",
  repo: "test-repo",
  getToken: async () => "test-token",
};

function rawLabel(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 12345,
    name: "bug",
    color: "d73a4a",
    description: "Something isn't working",
    default: true,
    ...overrides,
  };
}

function buildMockOctokit(
  opts: {
    labelsByPage?: Array<Array<Record<string, unknown>>>;
  } = {}
) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const labelsByPage = opts.labelsByPage ?? [[rawLabel()]];

  const octokit = {
    rest: {
      issues: {
        createLabel: mock(async (params: Record<string, unknown>) => {
          calls.push({ method: "createLabel", params });
          return { data: rawLabel({ name: params.name }) };
        }),
        listLabelsForRepo: mock(async (params: Record<string, unknown>) => {
          calls.push({ method: "listLabelsForRepo", params });
          const page = (params.page as number) - 1;
          return { data: labelsByPage[page] ?? [] };
        }),
        updateLabel: mock(async (params: Record<string, unknown>) => {
          calls.push({ method: "updateLabel", params });
          return {
            data: rawLabel({
              name: (params.new_name as string | undefined) ?? params.name,
            }),
          };
        }),
        deleteLabel: mock(async (params: Record<string, unknown>) => {
          calls.push({ method: "deleteLabel", params });
          return { data: {} };
        }),
      },
    },
    calls,
  };
  return octokit;
}

describe("createLabel", () => {
  test("creates a label and returns it mapped to the Label interface", async () => {
    const oct = buildMockOctokit();
    const result: Label = await createLabel(
      TEST_GH,
      { name: "p0", color: "b60205", description: "severity 0" },
      oct as unknown as Parameters<typeof createLabel>[2]
    );
    expect(result.name).toBe("p0");
    expect(result.color).toBe("d73a4a");
    expect(oct.calls.length).toBe(1);
    expect(oct.calls[0]?.method).toBe("createLabel");
    expect(oct.calls[0]?.params).toMatchObject({
      owner: "test-owner",
      repo: "test-repo",
      name: "p0",
      color: "b60205",
      description: "severity 0",
    });
  });

  test("description is omitted from the payload when not provided", async () => {
    const oct = buildMockOctokit();
    await createLabel(
      TEST_GH,
      { name: "p0", color: "b60205" },
      oct as unknown as Parameters<typeof createLabel>[2]
    );
    expect(oct.calls[0]?.params).not.toHaveProperty("description");
  });

  test("throws MinskyError when name is empty", async () => {
    const oct = buildMockOctokit();
    await expect(
      createLabel(
        TEST_GH,
        { name: "", color: "b60205" },
        oct as unknown as Parameters<typeof createLabel>[2]
      )
    ).rejects.toThrow(MinskyError);
  });

  test("throws MinskyError when color is empty", async () => {
    const oct = buildMockOctokit();
    await expect(
      createLabel(
        TEST_GH,
        { name: "p0", color: "" },
        oct as unknown as Parameters<typeof createLabel>[2]
      )
    ).rejects.toThrow(MinskyError);
  });
});

describe("listLabels", () => {
  test("collects labels from a single page", async () => {
    const oct = buildMockOctokit({
      labelsByPage: [[rawLabel({ id: 1, name: "bug" }), rawLabel({ id: 2, name: "p0" })]],
    });
    const result = await listLabels(
      TEST_GH,
      {},
      oct as unknown as Parameters<typeof listLabels>[2]
    );
    expect(result).toHaveLength(2);
    expect(result.map((l) => l.name)).toEqual(["bug", "p0"]);
    expect(oct.calls.length).toBe(1);
  });

  test("paginates: collects from two pages and stops when last page is short", async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => rawLabel({ id: i + 1, name: `l${i + 1}` }));
    const page2 = [rawLabel({ id: 4, name: "l4" })];
    const oct = buildMockOctokit({ labelsByPage: [page1, page2] });
    // perPage=3 means page1 is "full" so a second fetch happens; page2 has 1 → stop.
    const result = await listLabels(
      TEST_GH,
      { perPage: 3 },
      oct as unknown as Parameters<typeof listLabels>[2]
    );
    expect(result).toHaveLength(4);
    expect(oct.calls.length).toBe(2);
    expect(oct.calls[0]?.params.page).toBe(1);
    expect(oct.calls[1]?.params.page).toBe(2);
  });

  test("returns empty array when repo has no labels", async () => {
    const oct = buildMockOctokit({ labelsByPage: [[]] });
    const result = await listLabels(
      TEST_GH,
      {},
      oct as unknown as Parameters<typeof listLabels>[2]
    );
    expect(result).toEqual([]);
  });
});

describe("updateLabel", () => {
  test("uses currentName as the lookup key and new_name to rename", async () => {
    const oct = buildMockOctokit();
    await updateLabel(
      TEST_GH,
      "bug",
      { name: "issue", color: "ff0000" },
      oct as unknown as Parameters<typeof updateLabel>[3]
    );
    expect(oct.calls[0]?.params).toMatchObject({
      owner: "test-owner",
      repo: "test-repo",
      name: "bug",
      new_name: "issue",
      color: "ff0000",
    });
  });

  test("omits fields that are not provided in params", async () => {
    const oct = buildMockOctokit();
    await updateLabel(
      TEST_GH,
      "bug",
      { color: "ff0000" },
      oct as unknown as Parameters<typeof updateLabel>[3]
    );
    const params = oct.calls[0]?.params ?? {};
    expect(params).not.toHaveProperty("new_name");
    expect(params).not.toHaveProperty("description");
    expect(params.color).toBe("ff0000");
  });

  test("throws MinskyError when currentName is empty", async () => {
    const oct = buildMockOctokit();
    await expect(
      updateLabel(
        TEST_GH,
        "",
        { color: "ff0000" },
        oct as unknown as Parameters<typeof updateLabel>[3]
      )
    ).rejects.toThrow(MinskyError);
  });
});

describe("deleteLabel", () => {
  test("calls deleteLabel with the correct owner/repo/name", async () => {
    const oct = buildMockOctokit();
    await deleteLabel(TEST_GH, "bug", oct as unknown as Parameters<typeof deleteLabel>[2]);
    expect(oct.calls[0]?.method).toBe("deleteLabel");
    expect(oct.calls[0]?.params).toMatchObject({
      owner: "test-owner",
      repo: "test-repo",
      name: "bug",
    });
  });

  test("throws MinskyError when name is empty", async () => {
    const oct = buildMockOctokit();
    await expect(
      deleteLabel(TEST_GH, "", oct as unknown as Parameters<typeof deleteLabel>[2])
    ).rejects.toThrow(MinskyError);
  });
});
