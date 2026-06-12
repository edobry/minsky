/**
 * Unit tests for github-workflow-runs.ts (mt#1957).
 *
 * Uses Octokit DI (octokitOverride) to assert call shape, endpoint
 * dispatch (workflow-scoped vs repo-wide), and field mapping.
 */

import { describe, expect, test, mock } from "bun:test";
import { listWorkflowRuns, viewWorkflowRunLogs, type WorkflowRun } from "./github-workflow-runs";
import { MinskyError } from "../errors/index";
import { deflateRawSync } from "node:zlib";

const TEST_GH = {
  owner: "test-owner",
  repo: "test-repo",
  getToken: async () => "test-token",
};

const METHOD_LIST_RUNS = "listWorkflowRuns";

/**
 * Build a minimal single-entry ZIP (local file header + data) with the given
 * compression method. extractZipText only reads sig / method / compressedSize /
 * fileNameLength / extraFieldLength, so the other header fields are zeroed.
 */
function buildSingleEntryZip(filename: string, data: Uint8Array, method: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(filename);
  const header = new Uint8Array(30);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, 0x04034b50, true); // local file header signature
  dv.setUint16(8, method, true); // compression method
  dv.setUint32(18, data.length, true); // compressed size
  dv.setUint32(22, data.length, true); // uncompressed size (unread by extractZipText)
  dv.setUint16(26, nameBytes.length, true); // filename length
  dv.setUint16(28, 0, true); // extra field length
  const out = new Uint8Array(30 + nameBytes.length + data.length);
  out.set(header, 0);
  out.set(nameBytes, 30);
  out.set(data, 30 + nameBytes.length);
  return out;
}

function octokitReturningZip(zip: Uint8Array) {
  return {
    rest: {
      actions: {
        downloadWorkflowRunLogs: mock(async () => ({ data: zip })),
      },
    },
  };
}

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

  test("handles ≥200KB ZIP bodies without RangeError (PR #1185 review fix)", async () => {
    // Regression: pre-fix code used `btoa(String.fromCharCode(...bytes))` which
    // overflows V8's call stack for buffers ≥ ~100KB. Real GitHub Actions log
    // ZIPs are routinely 200KB–10MB, so the base64 fallback path was effectively
    // broken in production. The fix uses chunked encoding (32KB chunks via
    // String.fromCharCode.apply). This test exercises the path with a 200KB
    // buffer that does NOT start with a ZIP local-header signature, forcing
    // extractZipText() to throw and the outer base64 fallback to fire.
    const largeNonZipPayload = new Uint8Array(200 * 1024).fill(0x42);
    const oct = {
      rest: {
        actions: {
          downloadWorkflowRunLogs: mock(async () => ({ data: largeNonZipPayload })),
        },
      },
    };
    const result = await viewWorkflowRunLogs(
      TEST_GH,
      26132756066,
      oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2]
    );
    // The fallback path returns the base64 wrapper.
    expect(result).toContain("[base64-encoded ZIP");
    // Sanity-check encoding: 200KB of 0x42 → "Q" repeated in base64.
    expect(result).toContain("Q");
    // No stack overflow — getting this far is the regression assertion.
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

  test("inflates DEFLATE (method 8) entries to readable text (mt#2343)", async () => {
    const content = "step 1: build\nstep 2: boot\nstep 3: probe /health\n";
    const compressed = new Uint8Array(deflateRawSync(Buffer.from(content, "utf8")));
    const zip = buildSingleEntryZip("0_job.txt", compressed, 8);
    const oct = octokitReturningZip(zip);
    const result = await viewWorkflowRunLogs(
      TEST_GH,
      26132756066,
      oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2]
    );
    expect(result).toContain("0_job.txt");
    expect(result).toContain("step 1: build");
    expect(result).toContain("step 3: probe /health");
    // Must NOT leak the un-inflated placeholder.
    expect(result).not.toContain("DEFLATE entry could not be inflated");
    expect(result).not.toContain("decode: base64 then inflate-raw");
  });

  test("falls back to base64 placeholder when a DEFLATE entry cannot be inflated", async () => {
    // Method 8 declared, but the bytes are not valid raw DEFLATE → inflate throws.
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const zip = buildSingleEntryZip("0_job.txt", garbage, 8);
    const oct = octokitReturningZip(zip);
    const result = await viewWorkflowRunLogs(
      TEST_GH,
      26132756066,
      oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2]
    );
    expect(result).toContain("DEFLATE entry could not be inflated");
  });
});
