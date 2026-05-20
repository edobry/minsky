/**
 * Unit tests for github-workflow-runs.ts (mt#1957).
 *
 * Uses Octokit DI (octokitOverride) to assert call shape, endpoint
 * dispatch (workflow-scoped vs repo-wide), and field mapping.
 */

import { describe, expect, test, mock } from "bun:test";
import { listWorkflowRuns, viewWorkflowRunLogs, type WorkflowRun } from "./github-workflow-runs";
import { MinskyError } from "../../errors/index";

const TEST_GH = {
  owner: "test-owner",
  repo: "test-repo",
  getToken: async () => "test-token",
};

const METHOD_LIST_RUNS = "listWorkflowRuns";

function rawRun(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 26132756066,
    name: "CI",
    head_sha: "7af90f4867a3d65efd4aab429e98e09c6d2db0db",
    head_branch: "main",
    status: "completed",
    conclusion: "failure",
    created_at: "2026-05-20T00:01:05Z",
    updated_at: "2026-05-20T00:02:15Z",
    html_url: "https://github.com/edobry/minsky/actions/runs/26132756066",
    ...overrides,
  };
}

function buildMockOctokit(opts: { runs?: Array<Record<string, unknown>> } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const runs = opts.runs ?? [rawRun()];

  return {
    rest: {
      actions: {
        listWorkflowRuns: mock(async (params: Record<string, unknown>) => {
          calls.push({ method: "listWorkflowRuns", params });
          return { data: { workflow_runs: runs } };
        }),
        listWorkflowRunsForRepo: mock(async (params: Record<string, unknown>) => {
          calls.push({ method: "listWorkflowRunsForRepo", params });
          return { data: { workflow_runs: runs } };
        }),
        downloadWorkflowRunLogs: mock(async (params: Record<string, unknown>) => {
          calls.push({ method: "downloadWorkflowRunLogs", params });
          // STORED ZIP entry with content "hello\n"
          const data = new Uint8Array([
            0x50,
            0x4b,
            0x03,
            0x04, // local header sig
            0x14,
            0x00,
            0x00,
            0x00, // version + flags
            0x00,
            0x00, // compression method 0 (STORED)
            0x00,
            0x00,
            0x00,
            0x00, // mod time + date
            0x00,
            0x00,
            0x00,
            0x00, // CRC
            0x06,
            0x00,
            0x00,
            0x00, // compressed size = 6
            0x06,
            0x00,
            0x00,
            0x00, // uncompressed size = 6
            0x05,
            0x00, // filename length = 5
            0x00,
            0x00, // extra field length = 0
            0x6c,
            0x6f,
            0x67,
            0x2e,
            0x74, // "log.t"
            0x68,
            0x65,
            0x6c,
            0x6c,
            0x6f,
            0x0a, // "hello\n"
          ]);
          return { data };
        }),
      },
    },
    calls,
  };
}

describe(METHOD_LIST_RUNS, () => {
  test("dispatches to listWorkflowRunsForRepo when no workflow filter", async () => {
    const oct = buildMockOctokit();
    const result: WorkflowRun[] = await listWorkflowRuns(
      TEST_GH,
      { branch: "main", perPage: 10 },
      oct as unknown as Parameters<typeof listWorkflowRuns>[2]
    );
    expect(result).toHaveLength(1);
    expect(oct.calls[0]?.method).toBe("listWorkflowRunsForRepo");
    expect(oct.calls[0]?.params).toMatchObject({
      owner: "test-owner",
      repo: "test-repo",
      branch: "main",
      per_page: 10,
    });
  });

  test("dispatches to listWorkflowRuns when workflow filter is provided", async () => {
    const oct = buildMockOctokit();
    await listWorkflowRuns(
      TEST_GH,
      { workflow: "ci.yml", branch: "main" },
      oct as unknown as Parameters<typeof listWorkflowRuns>[2]
    );
    expect(oct.calls[0]?.method).toBe(METHOD_LIST_RUNS);
    expect(oct.calls[0]?.params).toMatchObject({
      workflow_id: "ci.yml",
      branch: "main",
    });
  });

  test("maps raw API fields to the WorkflowRun interface", async () => {
    const oct = buildMockOctokit();
    const result = await listWorkflowRuns(
      TEST_GH,
      {},
      oct as unknown as Parameters<typeof listWorkflowRuns>[2]
    );
    const run = result[0];
    if (!run) throw new Error("expected at least one run in result");
    expect(run.id).toBe(26132756066);
    expect(run.name).toBe("CI");
    expect(run.head_sha).toBe("7af90f4867a3d65efd4aab429e98e09c6d2db0db");
    expect(run.head_branch).toBe("main");
    expect(run.status).toBe("completed");
    expect(run.conclusion).toBe("failure");
    expect(run.html_url).toContain("actions/runs/26132756066");
  });

  test("invalid status filter is silently dropped (not forwarded to API)", async () => {
    const oct = buildMockOctokit();
    await listWorkflowRuns(
      TEST_GH,
      { status: "not-a-real-status" },
      oct as unknown as Parameters<typeof listWorkflowRuns>[2]
    );
    expect(oct.calls[0]?.params).not.toHaveProperty("status");
  });

  test("valid status filter (e.g. 'failure') is forwarded", async () => {
    const oct = buildMockOctokit();
    await listWorkflowRuns(
      TEST_GH,
      { status: "failure" },
      oct as unknown as Parameters<typeof listWorkflowRuns>[2]
    );
    expect(oct.calls[0]?.params.status).toBe("failure");
  });

  test("returns empty array when no runs match", async () => {
    const oct = buildMockOctokit({ runs: [] });
    const result = await listWorkflowRuns(
      TEST_GH,
      {},
      oct as unknown as Parameters<typeof listWorkflowRuns>[2]
    );
    expect(result).toEqual([]);
  });
});

describe("viewWorkflowRunLogs", () => {
  test("downloads logs and extracts STORED ZIP entry text", async () => {
    const oct = buildMockOctokit();
    const result = await viewWorkflowRunLogs(
      TEST_GH,
      26132756066,
      oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2]
    );
    expect(oct.calls[0]?.method).toBe("downloadWorkflowRunLogs");
    expect(oct.calls[0]?.params).toMatchObject({
      owner: "test-owner",
      repo: "test-repo",
      run_id: 26132756066,
    });
    // The fixture ZIP contains a single STORED file "log.t" with content "hello\n"
    expect(result).toContain("log.t");
    expect(result).toContain("hello");
  });

  test("throws MinskyError when runId is 0 or negative", async () => {
    const oct = buildMockOctokit();
    await expect(
      viewWorkflowRunLogs(TEST_GH, 0, oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2])
    ).rejects.toThrow(MinskyError);
    await expect(
      viewWorkflowRunLogs(TEST_GH, -1, oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2])
    ).rejects.toThrow(MinskyError);
  });
});
