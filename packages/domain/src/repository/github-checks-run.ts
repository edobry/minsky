/**
 * GitHub Check Run operations.
 *
 * Contains:
 * - submitCheckRun — create (and page-update) a check run with annotations
 *
 * Routes through the service-account / bot token via `gh.getToken()`
 * (TokenProvider-aware), matching the identity model used by submitReview.
 *
 * GitHub API reference:
 *   https://docs.github.com/en/rest/checks/runs
 *
 * Pagination note: GitHub accepts at most 50 annotations per output update
 * call. When the annotation count exceeds 50, this module issues one initial
 * create call with the first 50 annotations, then iterates through the
 * remainder with update calls, each carrying the next batch of up to 50.
 */

import { MinskyError } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { handleOctokitError } from "./github-error-handler";
import { type GitHubContext, createOctokit } from "./github-pr-operations";

// ── Public types ──────────────────────────────────────────────────────────

/** Severity level for a single check-run annotation. */
export type AnnotationLevel = "failure" | "warning" | "notice";

/**
 * A single annotation entry in a check-run output.
 *
 * Maps to the GitHub REST API `annotations[]` shape inside `output`.
 */
export interface CheckRunAnnotation {
  /** Relative path of the file the annotation refers to. */
  path: string;
  /** First line of the annotated range (1-based, inclusive). */
  startLine: number;
  /** Last line of the annotated range (1-based, inclusive). */
  endLine: number;
  /** Severity level. */
  annotationLevel: AnnotationLevel;
  /** Short title displayed next to the annotation. */
  title: string;
  /** Full annotation message body. */
  message: string;
  /** Raw details — optional extended context (code snippets, stack traces, etc.) */
  rawDetails?: string;
}

/**
 * Output block for a check run.
 *
 * `title` and `summary` are always required; `annotations` are optional
 * but when provided are paged in chunks of at most 50 per API call.
 */
export interface CheckRunOutput {
  /** Short title for the check run output (shown in GitHub UI). */
  title: string;
  /** Markdown summary displayed below the title. */
  summary: string;
  /** Optional list of file annotations. */
  annotations?: CheckRunAnnotation[];
}

/**
 * Options for creating / updating a check run.
 *
 * The `name` must be stable across updates for GitHub to associate subsequent
 * calls with the same logical check run. Using the same name on `create` and
 * `update` is required.
 */
export interface SubmitCheckRunOptions {
  /** Check run name — must be stable for branch-protection integration. */
  name: string;
  /**
   * Current lifecycle status.
   * Use `"completed"` when conclusion is also provided.
   */
  status: "queued" | "in_progress" | "completed";
  /**
   * Final verdict. Required when `status === "completed"`.
   */
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out";
  /** Output block containing title, summary, and optional annotations. */
  output: CheckRunOutput;
}

/** Result returned after a check run has been created (and paged). */
export interface SubmitCheckRunResult {
  /** GitHub check-run ID of the created/updated check run. */
  checkRunId: number;
  /** Web URL for the check run detail page. */
  htmlUrl: string;
}

// ── Constants ─────────────────────────────────────────────────────────────

/** Maximum annotations GitHub accepts per create/update call. */
const MAX_ANNOTATIONS_PER_CALL = 50;

// ── Implementation ────────────────────────────────────────────────────────

/**
 * Create a GitHub Check Run for the given `ref` (commit SHA or branch name),
 * posting all annotations with automatic pagination if there are more than 50.
 *
 * When the `annotations` array has more than 50 entries:
 *  1. The first 50 are included in the initial `checks.create` call.
 *  2. Subsequent batches of up to 50 are posted via `checks.update` calls,
 *     keeping `status` / `conclusion` identical on every update so the
 *     final state is consistent.
 *
 * Auth goes through `gh.getToken()`, which honours the TokenProvider's
 * service account when one is configured, posting the check run under
 * the bot identity.
 *
 * @param gh   — GitHub context (owner, repo, token resolver)
 * @param ref  — commit SHA or branch name the check run is attached to
 * @param options — check run configuration
 */
export async function submitCheckRun(
  gh: GitHubContext,
  ref: string,
  options: SubmitCheckRunOptions,
  /**
   * Optional dependency injection for testing — allows callers to supply a
   * pre-built Octokit instance instead of constructing one from gh.getToken().
   * Production callers always omit this; the default path resolves the token
   * via TokenProvider as usual. The custom no-global-module-mocks rule
   * forbids module-level mock.module() patches, so DI is the canonical seam.
   */
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<SubmitCheckRunResult> {
  if (!ref || ref.trim().length === 0) {
    throw new MinskyError("submitCheckRun: ref (commit SHA or branch name) is required");
  }

  const annotations = options.output.annotations ?? [];

  try {
    const octokit = octokitOverride ?? createOctokit(await gh.getToken());

    // Split annotations into batches of at most 50.
    const firstBatch = annotations.slice(0, MAX_ANNOTATIONS_PER_CALL);
    const remainingBatches = chunkArray(
      annotations.slice(MAX_ANNOTATIONS_PER_CALL),
      MAX_ANNOTATIONS_PER_CALL
    );

    // ── Initial create call ─────────────────────────────────────────
    const createResponse = await octokit.rest.checks.create({
      owner: gh.owner,
      repo: gh.repo,
      name: options.name,
      head_sha: ref,
      status: options.status,
      ...(options.conclusion ? { conclusion: options.conclusion } : {}),
      output: {
        title: options.output.title,
        summary: options.output.summary,
        ...(firstBatch.length > 0 ? { annotations: firstBatch.map(mapAnnotation) } : {}),
      },
    });

    const checkRunId = createResponse.data.id;
    const htmlUrl = createResponse.data.html_url ?? "";

    log.info("GitHub check run created", {
      checkRunId,
      name: options.name,
      ref,
      conclusion: options.conclusion,
      totalAnnotations: annotations.length,
      batchCount: 1 + remainingBatches.length,
      owner: gh.owner,
      repo: gh.repo,
    });

    // ── Pagination: update calls for the remaining batches ──────────
    for (let i = 0; i < remainingBatches.length; i++) {
      const batch = remainingBatches[i];
      if (!batch || batch.length === 0) continue;

      await octokit.rest.checks.update({
        owner: gh.owner,
        repo: gh.repo,
        check_run_id: checkRunId,
        status: options.status,
        ...(options.conclusion ? { conclusion: options.conclusion } : {}),
        output: {
          title: options.output.title,
          summary: options.output.summary,
          annotations: batch.map(mapAnnotation),
        },
      });

      log.debug("GitHub check run annotations batch uploaded", {
        checkRunId,
        batchIndex: i + 1,
        batchSize: batch.length,
        owner: gh.owner,
        repo: gh.repo,
      });
    }

    return { checkRunId, htmlUrl };
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "submit check run",
      owner: gh.owner,
      repo: gh.repo,
    });
    // handleOctokitError always throws; this satisfies TypeScript
    throw error;
  }
}

// ── Severity mapping ──────────────────────────────────────────────────────

/**
 * Map a reviewer finding severity tag to a GitHub annotation level.
 *
 * Accepted input values (case-insensitive tag from the reviewer output):
 *   - "BLOCKING"      → "failure"
 *   - "NON-BLOCKING"  → "warning"
 *   - anything else   → "notice"
 */
export function mapSeverityToAnnotationLevel(severity: string): AnnotationLevel {
  const upper = severity.toUpperCase().trim();
  if (upper === "BLOCKING") return "failure";
  if (upper === "NON-BLOCKING") return "warning";
  return "notice";
}

/**
 * Derive the check-run conclusion from a list of annotation levels.
 *
 * Rules:
 *   - Any "failure" annotation  → conclusion "failure"
 *   - Only "warning" annotations (no failures) → conclusion "neutral"
 *   - No annotations (empty list) → conclusion "success"
 */
export function deriveConclusion(levels: AnnotationLevel[]): "failure" | "neutral" | "success" {
  if (levels.includes("failure")) return "failure";
  if (levels.length > 0) return "neutral";
  return "success";
}

// ── Internal helpers ──────────────────────────────────────────────────────

/** Split an array into chunks of at most `size` elements. */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Map our internal CheckRunAnnotation to the Octokit REST API shape. */
function mapAnnotation(a: CheckRunAnnotation): {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
  raw_details?: string;
} {
  return {
    path: a.path,
    start_line: a.startLine,
    end_line: a.endLine,
    annotation_level: a.annotationLevel,
    title: a.title,
    message: a.message,
    ...(a.rawDetails !== undefined ? { raw_details: a.rawDetails } : {}),
  };
}
