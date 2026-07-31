/**
 * GitHub Actions workflow-run operations.
 *
 * Provides:
 *   - listWorkflowRuns  — list workflow runs for a repo with optional filters
 *   - viewWorkflowRunLogs — download and decode logs for a specific run ID
 *   - rerunWorkflowRun — re-run a completed run (all jobs, or just failed jobs)
 *
 * Auth goes through `gh.getToken()` (TokenProvider-aware), consistent with
 * the rest of the GitHub subinterface family.
 *
 * GitHub API reference:
 *   https://docs.github.com/en/rest/actions/workflow-runs
 *   https://docs.github.com/en/rest/actions/workflow-runs#download-workflow-run-logs
 *   https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-workflow
 *   https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-workflow-run-and-return-the-run-attempt
 *   https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run
 */

import { MinskyError } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { handleOctokitError, classifyOctokitError } from "./github-error-handler";
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

// ── rerunWorkflowRun ──────────────────────────────────────────────────────

/** Options controlling how a workflow run is re-run. */
export interface RerunWorkflowRunOptions {
  /**
   * When true, re-run the ENTIRE workflow (every job), via
   * `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`.
   *
   * Default `false`: re-run only the FAILED jobs, via
   * `POST .../rerun-failed-jobs` — the narrower default (retry only what
   * actually failed) chosen for mt#2775's motivating case: a single unrelated
   * flaky job on an otherwise-green required check.
   */
  fullRerun?: boolean;
}

/** Result of a rerun request. */
export interface RerunWorkflowRunResult {
  /** The run ID that was re-run (echoed back for convenience). */
  runId: number;
  /** Which endpoint was used to satisfy the request. */
  mode: "rerun-failed-jobs" | "full-rerun";
  /**
   * GitHub's own run-attempt counter (`run_attempt`), read via a best-effort
   * refetch immediately after the rerun request succeeds. Surfaces how many
   * times this run has already been attempted so callers/reviewers can see
   * repeated retries at a glance (mt#2775 guard-posture decision: the tool
   * itself is left unrestricted, but every result carries this count for
   * visibility rather than silently allowing unlimited retry-until-green).
   *
   * `undefined` when the refetch itself failed — this is a best-effort
   * observability read; a failure here must never fail the rerun call that
   * already succeeded.
   */
  rerunCount?: number;
  /** Direct link to the run, for the caller to watch progress. */
  htmlUrl?: string;
}

/**
 * Re-run a workflow run by its numeric ID.
 *
 * Dispatches to one of two GitHub endpoints depending on `options.fullRerun`:
 *   - `false` (default): `POST .../rerun-failed-jobs` — re-runs only the jobs
 *     that failed on the prior attempt.
 *   - `true`: `POST .../rerun` — re-runs every job in the workflow.
 *
 * Both endpoints require the "Actions" repository permission (write) on the
 * authenticated GitHub App / token — a fine-grained scope distinct from
 * "Contents" or "Pull requests". Reruns are only valid for runs in a
 * COMPLETED state (queued/in_progress runs cannot be re-run) and are subject
 * to GitHub's own limits: reruns are only accepted within 30 days of the
 * run's initial creation, and a single run can be re-run at most 50 times
 * (full reruns and failed-jobs reruns combined) — GitHub itself is the
 * backstop against unbounded retry-until-green on a single run.
 *
 * @param gh    — GitHub context (owner, repo, token resolver)
 * @param runId — numeric workflow run ID
 * @param options — rerun mode (default: failed-jobs only)
 * @param octokitOverride — optional DI-injected Octokit for testing
 */
export async function rerunWorkflowRun(
  gh: GitHubContext,
  runId: number,
  options: RerunWorkflowRunOptions = {},
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<RerunWorkflowRunResult> {
  if (!runId || runId <= 0) {
    throw new MinskyError("rerunWorkflowRun: runId must be a positive integer");
  }

  const octokit = octokitOverride ?? createOctokit(await gh.getToken());
  const mode: "rerun-failed-jobs" | "full-rerun" = options.fullRerun
    ? "full-rerun"
    : "rerun-failed-jobs";

  try {
    if (options.fullRerun) {
      await octokit.rest.actions.reRunWorkflow({
        owner: gh.owner,
        repo: gh.repo,
        run_id: runId,
      });
    } else {
      await octokit.rest.actions.reRunWorkflowFailedJobs({
        owner: gh.owner,
        repo: gh.repo,
        run_id: runId,
      });
    }
  } catch (error) {
    throw classifyRerunError(error, gh, runId);
  }

  // Best-effort refetch for rerunCount/htmlUrl observability (mt#2775 guard
  // posture). A failure here must never fail the rerun call that already
  // succeeded — the rerun was accepted regardless of whether we can report
  // its attempt count back to the caller.
  let rerunCount: number | undefined;
  let htmlUrl: string | undefined;
  try {
    const resp = await octokit.rest.actions.getWorkflowRun({
      owner: gh.owner,
      repo: gh.repo,
      run_id: runId,
    });
    const raw = resp.data as Record<string, unknown>;
    rerunCount =
      typeof raw["run_attempt"] === "number" ? (raw["run_attempt"] as number) : undefined;
    htmlUrl = typeof raw["html_url"] === "string" ? (raw["html_url"] as string) : undefined;
  } catch (refetchError) {
    log.debug("rerunWorkflowRun: post-rerun refetch failed (non-fatal)", {
      runId,
      error: refetchError instanceof Error ? refetchError.message : String(refetchError),
    });
  }

  return { runId, mode, rerunCount, htmlUrl };
}

/**
 * Classify a rerun-specific Octokit error into a structured, actionable
 * MinskyError. Handles the three failure modes named in mt#2775's spec
 * before falling back to the shared `handleOctokitError` classifier:
 *
 *   1. Missing "Actions" (write) permission — GitHub returns 403 with
 *      "Resource not accessible by integration" (the standard GitHub App
 *      insufficient-scope error text, consistent across the Actions/Checks
 *      REST surface) when the token lacks the scope this endpoint requires.
 *   2. Run not in a completed state — GitHub returns 403 with
 *      "This workflow is already running" when the run is still
 *      queued/in_progress (reruns are only valid for completed runs).
 *   3. Nonexistent run ID — 404.
 *
 * Always throws.
 */
function classifyRerunError(error: unknown, gh: GitHubContext, runId: number): never {
  const info = classifyOctokitError(error);

  // ── Missing "Actions" write permission ──────────────────────────
  if (
    info.status === 403 &&
    (info.messageLower.includes("resource not accessible by integration") ||
      info.ghErrorsText.includes("resource not accessible by integration"))
  ) {
    throw new MinskyError(
      `GitHub Permission Denied: Missing "Actions" Write Permission\n\n` +
        `Rerunning a workflow run requires the "Actions" repository permission ` +
        `(write) on the GitHub App / token Minsky is configured with. The ` +
        `current token does not have it.\n\n` +
        `To fix this:\n` +
        `  - Grant the "Actions" repository permission (Read and write) to the ` +
        `GitHub App installed on ${gh.owner}/${gh.repo}\n` +
        `    (App settings -> Permissions & events -> Repository permissions -> Actions)\n` +
        `  - Accept the updated permission set on the installation if GitHub prompts for it\n\n` +
        `Reference: GitHub REST docs for "Re-run a workflow" / "Re-run failed jobs from a ` +
        `workflow run" (https://docs.github.com/en/rest/actions/workflow-runs) — required ` +
        `fine-grained/App permission: Actions (write).\n\n` +
        `Run: https://github.com/${gh.owner}/${gh.repo}/actions/runs/${runId}`
    );
  }

  // ── Run not in a completed state ────────────────────────────────
  if (
    info.status === 403 &&
    (info.messageLower.includes("already running") || info.ghErrorsText.includes("already running"))
  ) {
    throw new MinskyError(
      `Cannot Rerun: Workflow Run Is Not Completed\n\n` +
        `Run ${runId} in ${gh.owner}/${gh.repo} is still queued or in progress. ` +
        `GitHub only allows reruns of runs in a COMPLETED state.\n\n` +
        `To fix this:\n` +
        `  - Wait for the run to finish, then retry\n` +
        `  - Check current status via forge.ci_run_list, or the run URL below\n\n` +
        `Run: https://github.com/${gh.owner}/${gh.repo}/actions/runs/${runId}`
    );
  }

  // ── Nonexistent run ──────────────────────────────────────────────
  if (
    info.status === 404 ||
    info.messageLower.includes("404") ||
    info.messageLower.includes("not found")
  ) {
    throw new MinskyError(
      `Workflow Run Not Found\n\n` +
        `No workflow run with id ${runId} was found in ${gh.owner}/${gh.repo}.\n\n` +
        `To fix this:\n` +
        `  - Verify the run id with forge.ci_run_list\n` +
        `  - Confirm the run has not aged out of GitHub's retention window`
    );
  }

  // ── Fallback to the shared classifier (auth/rate-limit/network/etc.) ────
  handleOctokitError(error, {
    operation: `rerun workflow run ${runId}`,
    owner: gh.owner,
    repo: gh.repo,
  });
  // handleOctokitError always throws; this satisfies TypeScript
  throw error;
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
 * Maximum decompressed size per ZIP entry (zip-bomb / DoS guard, mt#2343 R1).
 *
 * `inflateRawSync` with no bound lets a tiny crafted DEFLATE stream expand to
 * arbitrarily large output (memory blowup + event-loop stall). GitHub Actions
 * per-step logs are typically KB–low-MB; even a very verbose step is tens of MB,
 * so 64 MB per entry keeps real logs readable while bounding a bomb (which targets
 * GB+ expansion). On exceed, zlib throws `ERR_BUFFER_TOO_LARGE` and we fall back to
 * the base64 placeholder rather than dropping content.
 */
const MAX_DECOMPRESSED_ENTRY_BYTES = 64 * 1024 * 1024;

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** Fixed-size portion of a central-directory file header (before name/extra/comment). */
const CENTRAL_DIR_ENTRY_FIXED_SIZE = 46;
/** General-purpose bit 11: the entry's filename and comment fields are UTF-8. */
const GPBF_FILENAME_UTF8 = 0x0800;
/** Fixed size of the end-of-central-directory record (before the comment). */
const EOCD_FIXED_SIZE = 22;
/** Max comment length a conformant EOCD record can carry (uint16). */
const MAX_EOCD_COMMENT_LENGTH = 65535;

/**
 * Decode bytes as latin1 (one byte -> U+00xx). Used for filenames when GPBF
 * bit 11 is unset: the ZIP spec mandates IBM CP437 there, which has no
 * TextDecoder label — latin1 shares its full ASCII range (all GitHub run-log
 * filenames), so high bytes decode approximately rather than as U+FFFD noise.
 * Hand-rolled instead of `new TextDecoder("latin1")` because stricter
 * TextDecoder `Encoding` typings (services/reviewer's tsc) reject that label.
 */
function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i] as number);
  }
  return out;
}

interface CentralDirEntry {
  fileName: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/**
 * Locate the End Of Central Directory (EOCD) record by scanning backward from
 * the end of the archive.
 *
 * The EOCD's own `comment length` field must make the record end exactly at
 * `bytes.byteLength` — this disambiguates a genuine EOCD signature from an
 * accidental 4-byte match inside compressed entry data or a comment field.
 * Returns -1 if no EOCD is found (not a valid ZIP, or ZIP64 — see the
 * function-level known-limitation note on `extractZipText`).
 */
function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const minPos = Math.max(0, bytes.byteLength - EOCD_FIXED_SIZE - MAX_EOCD_COMMENT_LENGTH);
  for (let pos = bytes.byteLength - EOCD_FIXED_SIZE; pos >= minPos; pos--) {
    if (view.getUint32(pos, true) === EOCD_SIG) {
      const commentLength = view.getUint16(pos + 20, true);
      if (pos + EOCD_FIXED_SIZE + commentLength === bytes.byteLength) {
        return pos;
      }
    }
  }
  return -1;
}

/**
 * Read every central-directory file header starting at `centralDirOffset`.
 *
 * Central-directory entries carry the AUTHORITATIVE compressed/uncompressed
 * sizes — unlike local file headers, which are zeroed when the archive was
 * written in streaming mode (see `extractZipText`'s doc comment). Entries
 * whose signature doesn't match at the expected position stop the walk
 * early (defensive: a corrupt/truncated central directory yields whatever
 * entries were read cleanly, rather than throwing away all of them).
 */
function readCentralDirectoryEntries(
  bytes: Uint8Array,
  view: DataView,
  centralDirOffset: number,
  totalEntries: number
): CentralDirEntry[] {
  const utf8Decoder = new TextDecoder("utf-8");
  const entries: CentralDirEntry[] = [];
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (offset + CENTRAL_DIR_ENTRY_FIXED_SIZE > bytes.byteLength) break;
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIG) break;

    const gpFlag = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const fileNameBytes = bytes.slice(
      offset + CENTRAL_DIR_ENTRY_FIXED_SIZE,
      offset + CENTRAL_DIR_ENTRY_FIXED_SIZE + fileNameLength
    );
    entries.push({
      fileName:
        gpFlag & GPBF_FILENAME_UTF8
          ? utf8Decoder.decode(fileNameBytes)
          : decodeLatin1(fileNameBytes),
      compressionMethod,
      compressedSize,
      localHeaderOffset,
    });

    offset += CENTRAL_DIR_ENTRY_FIXED_SIZE + fileNameLength + extraFieldLength + commentLength;
  }

  return entries;
}

/**
 * Decode a single entry's compressed bytes to text, given its authoritative
 * (central-directory-sourced) compression method and compressed size.
 *
 * Locates the entry's data by reading its OWN local header's filename/extra
 * lengths (these may legitimately differ from the central directory's copy)
 * to compute the data start offset, then slices `compressedSize` bytes from
 * there — `compressedSize` itself always comes from the central directory,
 * never the local header (which is 0 for streamed entries; see
 * `extractZipText`).
 */
function decodeCentralDirEntry(
  bytes: Uint8Array,
  view: DataView,
  entry: CentralDirEntry,
  decoder: TextDecoder
): string {
  const { localHeaderOffset, compressionMethod, compressedSize, fileName } = entry;

  if (
    localHeaderOffset + 30 > bytes.byteLength ||
    view.getUint32(localHeaderOffset, true) !== LOCAL_HEADER_SIG
  ) {
    return `[local file header for ${fileName} not found at offset ${localHeaderOffset} — archive may be truncated]`;
  }

  const localFileNameLength = view.getUint16(localHeaderOffset + 26, true);
  const localExtraFieldLength = view.getUint16(localHeaderOffset + 28, true);
  const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;

  if (dataOffset + compressedSize > bytes.byteLength) {
    return `[entry ${fileName} data (offset ${dataOffset}, length ${compressedSize}) extends past end of archive — truncated]`;
  }

  const compressedData = bytes.slice(dataOffset, dataOffset + compressedSize);

  if (compressionMethod === 0) {
    // STORED — no compression
    return decoder.decode(compressedData);
  } else if (compressionMethod === 8) {
    // DEFLATE — ZIP method 8 is raw DEFLATE; decompress synchronously via
    // node:zlib (implemented by Bun, no extra dependency), bounded by
    // MAX_DECOMPRESSED_ENTRY_BYTES (zip-bomb guard). Fall back to the base64
    // placeholder if inflation throws (corrupt stream or over the cap) so a
    // malformed/hostile entry never silently loses content (mt#2343).
    try {
      return decoder.decode(
        inflateRawSync(compressedData, { maxOutputLength: MAX_DECOMPRESSED_ENTRY_BYTES })
      );
    } catch (err) {
      const base64 = uint8ArrayToBase64(compressedData);
      return `[DEFLATE entry could not be inflated (${
        err instanceof Error ? err.message : String(err)
      }) — decode: base64 then inflate-raw]\n${base64}`;
    }
  }
  return `[unsupported compression method ${compressionMethod}]`;
}

/**
 * Extract text content from a ZIP Uint8Array.
 *
 * Reads the ZIP CENTRAL DIRECTORY (via the End-Of-Central-Directory record,
 * signature 0x06054b50) rather than walking local file headers in order —
 * the central directory carries the AUTHORITATIVE compressed/uncompressed
 * sizes for every entry, whereas local file headers do not when the archive
 * was written in streaming mode.
 *
 * GitHub Actions run-log archives ARE written in streaming mode: every entry
 * sets general-purpose bit 3 ("sizes unknown at header-write time; written
 * in a trailing data descriptor instead"), and its local header's compressed/
 * uncompressed size fields are both 0 (mt#2678 — confirmed by inspecting a
 * live archive: `generalPurposeFlag & 0x0008 !== 0`, local `compressedSize
 * === 0`, true size recovered from the entry's data-descriptor trailer /
 * central directory). The prior implementation read sizes from the local
 * header, so it always sliced a 0-byte "compressed" region and fed that to
 * `inflateRawSync`, which reliably throws `unexpected end of file` — this
 * bug fired on 100% of entries in 100% of runs, matching the reported
 * symptom exactly. Reading sizes from the central directory instead (as any
 * general-purpose ZIP reader does) fixes this without needing to understand
 * or scan for the optional data-descriptor trailer at all.
 *
 * Extracts entries as UTF-8 text: STORED (method 0) directly, and DEFLATE
 * (method 8) via `node:zlib` `inflateRawSync` (ZIP method 8 is raw DEFLATE;
 * Bun implements Node's zlib, so no extra dependency is needed). GitHub
 * Actions log ZIPs use DEFLATE, so that is the common path.
 *
 * Inflation is bounded by `MAX_DECOMPRESSED_ENTRY_BYTES` (zip-bomb guard). It is
 * synchronous deliberately: this function and its caller (`viewWorkflowRunLogs`)
 * are already sync, the per-entry output is capped, and inflating a capped buffer
 * is fast (tens of ms); an async/worker refactor would ripple through the call
 * chain for no real-world latency win here.
 *
 * If a DEFLATE entry fails to inflate (corrupt stream OR over the cap), its raw
 * bytes are returned as a base64 placeholder so content is never silently lost.
 * Other compression methods keep a placeholder. (mt#2343)
 *
 * Known limitation: ZIP64 (archives/entries needing 64-bit size fields, which
 * would set the EOCD's entry-count/central-dir-size/offset fields to the
 * 0xFFFFFFFF/0xFFFF sentinel values and require reading a ZIP64 EOCD locator)
 * is not handled. GitHub's run-log archives are per-run, text-only, and small
 * (KB–low-single-digit-MB in practice), so this has not been observed to bite;
 * if it ever does, `findEndOfCentralDirectory` still finds the (32-bit) EOCD
 * record, but `readCentralDirectoryEntries` would read sentinel/truncated
 * values for that entry.
 */
function extractZipText(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8");

  const eocdOffset = findEndOfCentralDirectory(bytes, view);
  if (eocdOffset === -1) {
    throw new Error("ZIP end-of-central-directory record not found");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (centralDirOffset + centralDirSize > eocdOffset) {
    throw new Error("ZIP central directory extends past end-of-central-directory record");
  }

  const entries = readCentralDirectoryEntries(bytes, view, centralDirOffset, totalEntries);
  if (entries.length === 0) {
    throw new Error("No entries found in ZIP archive");
  }

  const parts: string[] = [];
  for (const entry of entries) {
    const entryText = decodeCentralDirEntry(bytes, view, entry, decoder);
    if (parts.length > 0) {
      parts.push(`\n--- ${entry.fileName} ---\n`);
    } else {
      parts.push(`--- ${entry.fileName} ---\n`);
    }
    parts.push(entryText);
  }

  return parts.join("");
}
