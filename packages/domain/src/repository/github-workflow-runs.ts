/**
 * GitHub Actions workflow-run operations.
 *
 * Provides:
 *   - listWorkflowRuns  — list workflow runs for a repo with optional filters
 *   - viewWorkflowRunLogs — download and decode logs for a specific run ID
 *
 * Auth goes through `gh.getToken()` (TokenProvider-aware), consistent with
 * the rest of the GitHub subinterface family.
 *
 * GitHub API reference:
 *   https://docs.github.com/en/rest/actions/workflow-runs
 *   https://docs.github.com/en/rest/actions/workflow-runs#download-workflow-run-logs
 */

import { MinskyError } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { handleOctokitError } from "./github-error-handler";
import { type GitHubContext, createOctokit } from "./github-pr-operations";
import { inflateRawSync } from "node:zlib";

// ── Public types ──────────────────────────────────────────────────────────

/** A single workflow run entry. */
export interface WorkflowRun {
  /** GitHub's numeric run ID. */
  id: number;
  /** Display name of the workflow. */
  name: string | null;
  /** The commit SHA that triggered this run. */
  head_sha: string;
  /** Branch name the run was triggered on. */
  head_branch: string | null;
  /**
   * Run lifecycle status.
   * One of: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending"
   */
  status: string | null;
  /**
   * Terminal outcome when status === "completed".
   * One of: "success" | "failure" | "neutral" | "cancelled" | "skipped" |
   *         "timed_out" | "action_required" | "stale" | null
   */
  conclusion: string | null;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 last-update timestamp. */
  updated_at: string;
  /** Web URL for the run detail page. */
  html_url: string;
}

/** Options for listing workflow runs. */
export interface ListWorkflowRunsOptions {
  /** Filter by workflow file name (e.g. "ci.yml") or numeric ID. */
  workflow?: string;
  /** Filter by branch name. */
  branch?: string;
  /**
   * Filter by lifecycle status.
   * One of: "completed" | "action_required" | "cancelled" | "failure" |
   *         "neutral" | "skipped" | "stale" | "success" | "timed_out" |
   *         "in_progress" | "queued" | "requested" | "waiting" | "pending"
   */
  status?: string;
  /** Maximum results to return (default: 30, max: 100). */
  perPage?: number;
}

// Valid status values accepted by the GitHub Actions API.
const VALID_WORKFLOW_STATUSES = new Set([
  "action_required",
  "cancelled",
  "completed",
  "failure",
  "in_progress",
  "neutral",
  "pending",
  "queued",
  "requested",
  "skipped",
  "stale",
  "success",
  "timed_out",
  "waiting",
]);

type WorkflowStatus =
  | "action_required"
  | "cancelled"
  | "completed"
  | "failure"
  | "in_progress"
  | "neutral"
  | "pending"
  | "queued"
  | "requested"
  | "skipped"
  | "stale"
  | "success"
  | "timed_out"
  | "waiting";

function asWorkflowStatus(s: string | undefined): WorkflowStatus | undefined {
  if (!s) return undefined;
  if (VALID_WORKFLOW_STATUSES.has(s)) return s as WorkflowStatus;
  return undefined;
}

// ── Implementation ────────────────────────────────────────────────────────

/**
 * List workflow runs for the repository, with optional workflow/branch/status
 * filters.
 *
 * When `options.workflow` is provided, the call is dispatched to the
 * workflow-scoped endpoint (`listWorkflowRuns`); otherwise it uses the
 * repository-wide endpoint (`listWorkflowRunsForRepo`).
 *
 * @param gh   — GitHub context (owner, repo, token resolver)
 * @param options — optional filter parameters
 * @param octokitOverride — optional DI-injected Octokit for testing
 */
export async function listWorkflowRuns(
  gh: GitHubContext,
  options: ListWorkflowRunsOptions = {},
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<WorkflowRun[]> {
  try {
    const octokit = octokitOverride ?? createOctokit(await gh.getToken());
    const perPage = options.perPage ?? 30;
    const status = asWorkflowStatus(options.status);

    let rawRuns: unknown[];

    if (options.workflow) {
      // Workflow-scoped endpoint
      const resp = await octokit.rest.actions.listWorkflowRuns({
        owner: gh.owner,
        repo: gh.repo,
        workflow_id: options.workflow,
        ...(options.branch ? { branch: options.branch } : {}),
        ...(status ? { status } : {}),
        per_page: perPage,
      });
      rawRuns = resp.data.workflow_runs;
    } else {
      // Repo-wide endpoint
      const resp = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner: gh.owner,
        repo: gh.repo,
        ...(options.branch ? { branch: options.branch } : {}),
        ...(status ? { status } : {}),
        per_page: perPage,
      });
      rawRuns = resp.data.workflow_runs;
    }

    return rawRuns.map((r) => {
      const run = r as Record<string, unknown>;
      return {
        id: run["id"] as number,
        name: (run["name"] as string | null) ?? null,
        head_sha: run["head_sha"] as string,
        head_branch: (run["head_branch"] as string | null) ?? null,
        status: (run["status"] as string | null) ?? null,
        conclusion: (run["conclusion"] as string | null) ?? null,
        created_at: run["created_at"] as string,
        updated_at: run["updated_at"] as string,
        html_url: run["html_url"] as string,
      };
    });
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "list workflow runs",
      owner: gh.owner,
      repo: gh.repo,
    });
    // handleOctokitError always throws; this satisfies TypeScript
    throw error;
  }
}

/**
 * Download and decode the logs for a specific workflow run.
 *
 * The GitHub API returns a redirect to a ZIP archive. This function follows
 * the redirect, downloads the ZIP, and extracts the log content as a single
 * text blob. When the ZIP contains multiple files, they are concatenated with
 * a header separating each file.
 *
 * Falls back to returning the raw content as a base64-encoded string if
 * decompression fails (e.g., if the content is not actually a ZIP).
 *
 * @param gh    — GitHub context (owner, repo, token resolver)
 * @param runId — numeric workflow run ID
 * @param octokitOverride — optional DI-injected Octokit for testing
 */
export async function viewWorkflowRunLogs(
  gh: GitHubContext,
  runId: number,
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<string> {
  if (!runId || runId <= 0) {
    throw new MinskyError("viewWorkflowRunLogs: runId must be a positive integer");
  }

  try {
    const octokit = octokitOverride ?? createOctokit(await gh.getToken());

    // The API returns a 302 redirect to the ZIP download URL; Octokit follows it
    // and returns the binary content.
    const resp = await octokit.rest.actions.downloadWorkflowRunLogs({
      owner: gh.owner,
      repo: gh.repo,
      run_id: runId,
    });

    // Convert whatever Octokit returns to a Uint8Array for uniform processing.
    // The downloadWorkflowRunLogs API returns different shapes depending on
    // the Octokit version and request adapter (Uint8Array, string, or ArrayBuffer).
    const rawData: Uint8Array | string | ArrayBuffer | null = resp.data as
      | Uint8Array
      | string
      | ArrayBuffer
      | null;
    let bytes: Uint8Array;

    if (rawData instanceof Uint8Array) {
      bytes = rawData;
    } else if (typeof rawData === "string") {
      bytes = new TextEncoder().encode(rawData);
    } else if (rawData instanceof ArrayBuffer) {
      bytes = new Uint8Array(rawData);
    } else if (rawData != null) {
      // Fallback: stringify whatever arrived
      bytes = new TextEncoder().encode(JSON.stringify(rawData));
    } else {
      bytes = new Uint8Array(0);
    }

    log.debug("Downloaded workflow run logs", {
      runId,
      owner: gh.owner,
      repo: gh.repo,
      byteLength: bytes.byteLength,
    });

    // Attempt to unzip and extract text content.
    try {
      const text = extractZipText(bytes);
      return text;
    } catch (unzipErr) {
      log.debug("ZIP extraction failed — returning base64 fallback", {
        runId,
        error: unzipErr instanceof Error ? unzipErr.message : String(unzipErr),
      });
      // Consumer-side decode: return as base64 so the content isn't lost.
      // Use Buffer.from(uint8Array).toString("base64") rather than
      // btoa(String.fromCharCode(...)) — the spread-based form throws RangeError
      // ("Maximum call stack size exceeded") for Uint8Arrays larger than
      // ~65k–100k bytes, and real Actions log ZIPs are routinely 200KB–10MB.
      // mt#1957 PR #1185 reviewer-bot finding.
      const base64 = uint8ArrayToBase64(bytes);
      return `[base64-encoded ZIP — decode with: Buffer.from(data, 'base64')]\n${base64}`;
    }
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "download workflow run logs",
      owner: gh.owner,
      repo: gh.repo,
    });
    throw error;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Convert a Uint8Array to a base64-encoded string without spread-stack overflow.
 *
 * Replaces the `btoa(String.fromCharCode(...bytes))` pattern, which throws
 * `RangeError: Maximum call stack size exceeded` when the byte array exceeds
 * ~65k–100k bytes — fatal for real Actions log ZIPs (200KB–10MB).
 *
 * Strategy: build the binary-string in 32KB chunks using
 * `String.fromCharCode.apply(null, slice)` — keeps the per-call argument count
 * bounded under V8's apply limit (~120K args), then base64-encode the full
 * binary string with `btoa`. Linear time, no recursion, no `Buffer` required
 * (the project's TypeScript Buffer signature does not accept Uint8Array).
 *
 * mt#1957 PR #1185 reviewer-bot finding.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

/**
 * Extract text content from a ZIP Uint8Array.
 *
 * Parses ZIP local file headers (signature 0x04034b50) and extracts entries as
 * UTF-8 text: STORED (method 0) directly, and DEFLATE (method 8) via
 * `node:zlib` `inflateRawSync` (ZIP method 8 is raw DEFLATE; Bun implements
 * Node's zlib, so no extra dependency is needed). GitHub Actions log ZIPs use
 * DEFLATE, so that is the common path.
 *
 * If a DEFLATE entry fails to inflate, its raw bytes are returned as a base64
 * placeholder so content is never silently lost. Other compression methods keep
 * a placeholder. (mt#2343)
 */
function extractZipText(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: string[] = [];
  const decoder = new TextDecoder("utf-8");

  let offset = 0;
  const LOCAL_HEADER_SIG = 0x04034b50;

  while (offset + 30 <= bytes.byteLength) {
    // Check local file header signature (little-endian)
    const sigVal = view.getUint32(offset, true);
    if (sigVal !== LOCAL_HEADER_SIG) {
      offset++;
      continue;
    }

    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraFieldLength = view.getUint16(offset + 28, true);

    const headerSize = 30 + fileNameLength + extraFieldLength;
    const fileNameBytes = bytes.slice(offset + 30, offset + 30 + fileNameLength);
    const fileName = decoder.decode(fileNameBytes);
    const dataOffset = offset + headerSize;

    if (dataOffset + compressedSize > bytes.byteLength) {
      break; // truncated archive
    }

    const compressedData = bytes.slice(dataOffset, dataOffset + compressedSize);
    let entryText: string;

    if (compressionMethod === 0) {
      // STORED — no compression
      entryText = decoder.decode(compressedData);
    } else if (compressionMethod === 8) {
      // DEFLATE — ZIP method 8 is raw DEFLATE; decompress synchronously via
      // node:zlib (implemented by Bun, no extra dependency). Fall back to the
      // base64 placeholder only if inflation throws, so a malformed entry never
      // silently loses content (mt#2343).
      try {
        entryText = decoder.decode(inflateRawSync(compressedData));
      } catch (err) {
        const base64 = uint8ArrayToBase64(compressedData);
        entryText = `[DEFLATE entry could not be inflated (${
          err instanceof Error ? err.message : String(err)
        }) — decode: base64 then inflate-raw]\n${base64}`;
      }
    } else {
      entryText = `[unsupported compression method ${compressionMethod}]`;
    }

    if (parts.length > 0) {
      parts.push(`\n--- ${fileName} ---\n`);
    } else {
      parts.push(`--- ${fileName} ---\n`);
    }
    parts.push(entryText);

    offset = dataOffset + compressedSize;
  }

  if (parts.length === 0) {
    throw new Error("No entries found in ZIP archive");
  }

  return parts.join("");
}
