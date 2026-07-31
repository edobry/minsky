/**
 * Unit tests for github-workflow-runs.ts (mt#1957).
 *
 * Uses Octokit DI (octokitOverride) to assert call shape, endpoint
 * dispatch (workflow-scoped vs repo-wide), and field mapping.
 */

import { describe, expect, test, mock } from "bun:test";
import {
  listWorkflowRuns,
  viewWorkflowRunLogs,
  rerunWorkflowRun,
  type WorkflowRun,
} from "./github-workflow-runs";
import { MinskyError } from "../errors/index";
import { deflateRawSync } from "node:zlib";

const TEST_GH = {
  owner: "test-owner",
  repo: "test-repo",
  getToken: async () => "test-token",
};

const METHOD_LIST_RUNS = "listWorkflowRuns";

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

interface ZipEntrySpec {
  filename: string;
  data: Uint8Array;
  method: number;
  /**
   * When true, emulate GitHub Actions' streaming ZIP writer (mt#2678): the
   * local header's general-purpose bit 3 is set and its compressed/
   * uncompressed size fields are ZEROED, matching real GitHub run-log
   * archives. extractZipText must recover the real size from the central
   * directory (which always carries authoritative sizes), not the local
   * header. Defaults to false (sizes present in the local header).
   */
  streamed?: boolean;
  /**
   * When true, set general-purpose bit 11 (filename/comment are UTF-8) in
   * both headers. When false/absent, the ZIP spec mandates CP437 filenames —
   * the parser approximates those as latin1.
   */
  utf8Flag?: boolean;
  /**
   * Raw filename bytes override for non-UTF-8 encodings (TextEncoder can only
   * produce UTF-8). `filename` is still used for readability in assertions.
   */
  filenameBytes?: Uint8Array;
}

/**
 * Build a minimal, spec-compliant ZIP archive: local file headers + data,
 * followed by a central directory and an end-of-central-directory (EOCD)
 * record. `extractZipText` (mt#2678) reads sizes from the central directory,
 * so a fixture without one no longer parses — this builder always emits one.
 */
function buildZip(entries: ZipEntrySpec[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const localOffsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = entry.filenameBytes ?? new TextEncoder().encode(entry.filename);
    const header = new Uint8Array(30);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    // general purpose flag: bit 3 = data descriptor, bit 11 = UTF-8 filename
    dv.setUint16(6, (entry.streamed ? 0x0008 : 0) | (entry.utf8Flag ? 0x0800 : 0), true);
    dv.setUint16(8, entry.method, true); // compression method
    const localSize = entry.streamed ? 0 : entry.data.length;
    dv.setUint32(18, localSize, true); // compressed size
    dv.setUint32(22, localSize, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true); // filename length
    dv.setUint16(28, 0, true); // extra field length

    localOffsets.push(offset);
    localParts.push(header, nameBytes, entry.data);
    offset += header.length + nameBytes.length + entry.data.length;

    if (entry.streamed) {
      // Trailing data descriptor: signature + crc32 (unused by our parser) +
      // compressed size + uncompressed size.
      const dd = new Uint8Array(16);
      const ddv = new DataView(dd.buffer);
      ddv.setUint32(0, 0x08074b50, true);
      ddv.setUint32(4, 0, true); // crc32 (not verified by extractZipText)
      ddv.setUint32(8, entry.data.length, true);
      ddv.setUint32(12, entry.data.length, true);
      localParts.push(dd);
      offset += dd.length;
    }
  }

  const localSection = concatUint8Arrays(localParts);
  const centralDirOffset = localSection.length;
  const centralParts: Uint8Array[] = [];

  entries.forEach((entry, i) => {
    const nameBytes = entry.filenameBytes ?? new TextEncoder().encode(entry.filename);
    const central = new Uint8Array(46);
    const dv = new DataView(central.buffer);
    dv.setUint32(0, 0x02014b50, true); // central file header signature
    dv.setUint16(8, entry.utf8Flag ? 0x0800 : 0, true); // general purpose flag (bit 11 = UTF-8 filename)
    dv.setUint16(10, entry.method, true); // compression method
    dv.setUint32(20, entry.data.length, true); // compressed size (authoritative)
    dv.setUint32(24, entry.data.length, true); // uncompressed size (authoritative)
    dv.setUint16(28, nameBytes.length, true); // filename length
    dv.setUint32(42, localOffsets[i] as number, true); // relative offset of local header
    centralParts.push(central, nameBytes);
  });

  const centralSection = concatUint8Arrays(centralParts);

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true); // EOCD signature
  edv.setUint16(8, entries.length, true); // entries on this disk
  edv.setUint16(10, entries.length, true); // total entries
  edv.setUint32(12, centralSection.length, true); // central directory size
  edv.setUint32(16, centralDirOffset, true); // central directory offset

  return concatUint8Arrays([localSection, centralSection, eocd]);
}

/** Build a spec-compliant single-entry ZIP (see {@link buildZip}). */
function buildSingleEntryZip(
  filename: string,
  data: Uint8Array,
  method: number,
  streamed = false
): Uint8Array {
  return buildZip([{ filename, data, method, streamed }]);
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

/** Marker emitted by extractZipText's DEFLATE-inflate fallback (corrupt or over-cap). */
const DEFLATE_FALLBACK_MARKER = "DEFLATE entry could not be inflated";

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
          const data = buildSingleEntryZip("log.t", new TextEncoder().encode("hello\n"), 0);
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

  test("decodes streamed (data-descriptor) DEFLATE entries via the central directory (mt#2678)", async () => {
    // Emulates GitHub Actions' actual run-log ZIP format: general-purpose bit 3
    // set, local header compressed/uncompressed sizes ZEROED, real size only
    // recoverable from the central directory (which buildZip always emits).
    // Before mt#2678, extractZipText read sizes from the local header only,
    // so this exact shape produced "[DEFLATE entry could not be inflated
    // (unexpected end of file)]" on every entry, every run.
    const content = "2026-07-08T20:39:26Z Current runner version: '2.335.1'\n";
    const compressed = new Uint8Array(deflateRawSync(Buffer.from(content, "utf8")));
    const zip = buildSingleEntryZip("0_monitor.txt", compressed, 8, /* streamed */ true);
    const oct = octokitReturningZip(zip);
    const result = await viewWorkflowRunLogs(
      TEST_GH,
      26132756066,
      oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2]
    );
    expect(result).toContain("0_monitor.txt");
    expect(result).toContain("Current runner version");
    expect(result).not.toContain(DEFLATE_FALLBACK_MARKER);
  });

  test("decodes a real captured GitHub Actions run-log archive (mt#2678 recorded-fixture regression)", async () => {
    // Recorded fixture: the actual ZIP bytes GitHub returned for a live
    // Post-Deploy Health Monitor run on edobry/minsky main (run 28974111562,
    // captured 2026-07-08 while diagnosing mt#2678). Confirmed independently
    // valid via the system `unzip -l` tool (10 entries) before being checked
    // in. This is the acceptance test's "captured real log-archive response
    // body" fixture — it pins the fix against the actual streamed-ZIP shape
    // GitHub emits, not just a synthetic approximation of it.
    const fixturePath = new URL("./__fixtures__/gh-actions-run-log.zip", import.meta.url);
    const zipBytes = new Uint8Array(await Bun.file(fixturePath).arrayBuffer());
    const oct = octokitReturningZip(zipBytes);
    const result = await viewWorkflowRunLogs(
      TEST_GH,
      28974111562,
      oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2]
    );
    // Filenames from every one of the archive's 10 entries.
    expect(result).toContain("0_monitor.txt");
    expect(result).toContain("monitor/system.txt");
    expect(result).toContain("monitor/1_Set up job.txt");
    expect(result).toContain("monitor/11_Complete job.txt");
    // Real decoded step-log content, not the DEFLATE-failure placeholder.
    expect(result).toContain("Current runner version");
    expect(result).toContain("##[group]Runner Image Provisioner");
    expect(result).not.toContain(DEFLATE_FALLBACK_MARKER);
    expect(result).not.toContain("[base64-encoded ZIP");
  });

  test("decodes filenames as UTF-8 when general-purpose bit 11 is set", async () => {
    const data = new TextEncoder().encode("step output\n");
    const zip = buildZip([{ filename: "monitor/1_étape.txt", data, method: 0, utf8Flag: true }]);
    const oct = octokitReturningZip(zip);
    const result = await viewWorkflowRunLogs(
      TEST_GH,
      26132756066,
      oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2]
    );
    expect(result).toContain("monitor/1_étape.txt");
    expect(result).toContain("step output");
  });

  test("decodes filenames as latin1 (CP437 approximation) when bit 11 is unset", async () => {
    // "café.txt" with é as the single byte 0xE9 — a legacy (non-UTF-8) name.
    // Decoding these bytes as UTF-8 would produce U+FFFD ("caf�.txt").
    const filenameBytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]);
    const data = new TextEncoder().encode("legacy name entry\n");
    const zip = buildZip([{ filename: "café.txt", filenameBytes, data, method: 0 }]);
    const oct = octokitReturningZip(zip);
    const result = await viewWorkflowRunLogs(
      TEST_GH,
      26132756066,
      oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2]
    );
    expect(result).toContain("café.txt");
    expect(result).not.toContain("�");
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
    expect(result).toContain(DEFLATE_FALLBACK_MARKER);
  });

  test("caps decompression (zip-bomb guard): >64MB expansion aborts to base64 fallback (mt#2343 R1)", async () => {
    // A tiny DEFLATE stream that expands past MAX_DECOMPRESSED_ENTRY_BYTES (64MB):
    // 64MB+1 zero bytes compress to a few KB. The cap must abort inflation
    // (ERR_BUFFER_TOO_LARGE) and fall back to base64 rather than allocating it.
    const bombSource = new Uint8Array(64 * 1024 * 1024 + 1); // zeros
    const compressed = new Uint8Array(deflateRawSync(Buffer.from(bombSource.buffer)));
    expect(compressed.length).toBeLessThan(1024 * 1024); // sanity: tiny compressed payload
    const zip = buildSingleEntryZip("0_bomb.txt", compressed, 8);
    const oct = octokitReturningZip(zip);
    const result = await viewWorkflowRunLogs(
      TEST_GH,
      26132756066,
      oct as unknown as Parameters<typeof viewWorkflowRunLogs>[2]
    );
    // Aborted into the fallback — not 64MB of decoded text.
    expect(result).toContain(DEFLATE_FALLBACK_MARKER);
  });
});

describe("rerunWorkflowRun (mt#2775)", () => {
  /** An Octokit-shaped error: `.status` + `.message` is exactly what classifyOctokitError reads. */
  function octokitError(status: number, message: string): Error & { status: number } {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    return err;
  }

  function buildRerunMockOctokit(
    opts: {
      rerunError?: Error;
      getWorkflowRunError?: Error;
      runAttempt?: number;
      htmlUrl?: string;
    } = {}
  ) {
    const calls: { method: string; params: Record<string, unknown> }[] = [];

    return {
      rest: {
        actions: {
          reRunWorkflow: mock(async (params: Record<string, unknown>) => {
            calls.push({ method: "reRunWorkflow", params });
            if (opts.rerunError) throw opts.rerunError;
            return { status: 201, data: undefined };
          }),
          reRunWorkflowFailedJobs: mock(async (params: Record<string, unknown>) => {
            calls.push({ method: "reRunWorkflowFailedJobs", params });
            if (opts.rerunError) throw opts.rerunError;
            return { status: 201, data: undefined };
          }),
          getWorkflowRun: mock(async (params: Record<string, unknown>) => {
            calls.push({ method: "getWorkflowRun", params });
            if (opts.getWorkflowRunError) throw opts.getWorkflowRunError;
            return {
              data: {
                run_attempt: opts.runAttempt ?? 2,
                html_url:
                  opts.htmlUrl ??
                  `https://github.com/test-owner/test-repo/actions/runs/${params["run_id"]}`,
              },
            };
          }),
        },
      },
      calls,
    };
  }

  test("defaults to rerun-failed-jobs and surfaces rerunCount from the post-rerun refetch", async () => {
    const oct = buildRerunMockOctokit({ runAttempt: 3 });
    const result = await rerunWorkflowRun(
      TEST_GH,
      26132756066,
      {},
      oct as unknown as Parameters<typeof rerunWorkflowRun>[3]
    );
    expect(oct.calls[0]?.method).toBe("reRunWorkflowFailedJobs");
    expect(oct.calls[0]?.params).toMatchObject({
      owner: "test-owner",
      repo: "test-repo",
      run_id: 26132756066,
    });
    expect(result.mode).toBe("rerun-failed-jobs");
    expect(result.runId).toBe(26132756066);
    expect(result.rerunCount).toBe(3);
    expect(result.htmlUrl).toContain("actions/runs/26132756066");
  });

  test("fullRerun:true dispatches to the full-rerun endpoint", async () => {
    const oct = buildRerunMockOctokit();
    const result = await rerunWorkflowRun(
      TEST_GH,
      26132756066,
      { fullRerun: true },
      oct as unknown as Parameters<typeof rerunWorkflowRun>[3]
    );
    expect(oct.calls[0]?.method).toBe("reRunWorkflow");
    expect(oct.calls[0]?.params).toMatchObject({
      owner: "test-owner",
      repo: "test-repo",
      run_id: 26132756066,
    });
    expect(result.mode).toBe("full-rerun");
  });

  test("throws MinskyError when runId is 0 or negative", async () => {
    const oct = buildRerunMockOctokit();
    await expect(
      rerunWorkflowRun(TEST_GH, 0, {}, oct as unknown as Parameters<typeof rerunWorkflowRun>[3])
    ).rejects.toThrow(MinskyError);
    await expect(
      rerunWorkflowRun(TEST_GH, -1, {}, oct as unknown as Parameters<typeof rerunWorkflowRun>[3])
    ).rejects.toThrow(MinskyError);
  });

  test("nonexistent runId surfaces a structured 'Workflow Run Not Found' error", async () => {
    const oct = buildRerunMockOctokit({
      rerunError: octokitError(404, "Not Found"),
    });
    await expect(
      rerunWorkflowRun(
        TEST_GH,
        999999999,
        {},
        oct as unknown as Parameters<typeof rerunWorkflowRun>[3]
      )
    ).rejects.toThrow(/Workflow Run Not Found/);
  });

  test("missing 'Actions' write permission surfaces a structured, actionable error naming the permission", async () => {
    const oct = buildRerunMockOctokit({
      rerunError: octokitError(403, "Resource not accessible by integration"),
    });
    await expect(
      rerunWorkflowRun(
        TEST_GH,
        26132756066,
        {},
        oct as unknown as Parameters<typeof rerunWorkflowRun>[3]
      )
    ).rejects.toThrow(/Missing "Actions" Write Permission/);
    // Must name the specific permission and the fix, not a generic 403 message.
    await expect(
      rerunWorkflowRun(
        TEST_GH,
        26132756066,
        {},
        oct as unknown as Parameters<typeof rerunWorkflowRun>[3]
      )
    ).rejects.toThrow(/Actions.*repository permission.*write/is);
  });

  test("rerunning a non-completed run surfaces a structured 'not completed' error", async () => {
    const oct = buildRerunMockOctokit({
      rerunError: octokitError(403, "This workflow is already running"),
    });
    await expect(
      rerunWorkflowRun(
        TEST_GH,
        26132756066,
        {},
        oct as unknown as Parameters<typeof rerunWorkflowRun>[3]
      )
    ).rejects.toThrow(/Workflow Run Is Not Completed/);
  });

  test("a failed post-rerun refetch does not fail the rerun itself (rerunCount undefined)", async () => {
    const oct = buildRerunMockOctokit({
      getWorkflowRunError: new Error("network blip"),
    });
    const result = await rerunWorkflowRun(
      TEST_GH,
      26132756066,
      {},
      oct as unknown as Parameters<typeof rerunWorkflowRun>[3]
    );
    expect(result.runId).toBe(26132756066);
    expect(result.rerunCount).toBeUndefined();
    expect(result.htmlUrl).toBeUndefined();
  });

  test("generic errors (e.g. 401) still fall back to the shared classifier", async () => {
    const oct = buildRerunMockOctokit({
      rerunError: octokitError(401, "Bad credentials"),
    });
    await expect(
      rerunWorkflowRun(
        TEST_GH,
        26132756066,
        {},
        oct as unknown as Parameters<typeof rerunWorkflowRun>[3]
      )
    ).rejects.toThrow(/GitHub Authentication Failed/);
  });
});
