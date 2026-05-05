/**
 * Session PR Check Run Submit Subcommand
 *
 * Posts a GitHub Check Run for the pull request associated with a Minsky
 * session, compiling a list of reviewer findings into check-run annotations.
 *
 * This is the machine-shaped surface that complements the human-shaped
 * review-comment surface (session.pr.review.submit). Both surfaces are
 * posted independently; this subcommand covers only the check-run path.
 *
 * Severity mapping:
 *   [BLOCKING]     → annotation_level: "failure"
 *   [NON-BLOCKING] → annotation_level: "warning"
 *   (any other)    → annotation_level: "notice"
 *
 * Conclusion derivation:
 *   any "failure" annotation → "failure"
 *   only "warning" annotations → "neutral"
 *   no annotations → "success"
 *
 * Pagination: GitHub allows 50 annotations per output update; the underlying
 * forge method handles pagination automatically.
 *
 * Identity: the check run is posted under the service-account / bot identity
 * via `getToken()` (TokenProvider-aware), matching the review identity.
 *
 * @see mt#1346
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { createRepositoryBackend, RepositoryBackendType } from "../../repository/index";
import type { RepositoryBackendConfig } from "../../repository/index";
import {
  mapSeverityToAnnotationLevel,
  deriveConclusion,
  type CheckRunAnnotation,
  type AnnotationLevel,
} from "../../repository/github-checks-run";

// ── Public types ──────────────────────────────────────────────────────────

export interface SessionPrCheckRunSubmitDependencies {
  sessionDB: SessionProviderInterface;
}

/**
 * A single reviewer finding passed to the tool.
 *
 * `severity` is the raw tag from the reviewer output (e.g. "BLOCKING",
 * "NON-BLOCKING", or any other string for informational findings).
 */
export interface ReviewFinding {
  /** Relative file path the finding refers to. */
  path: string;
  /** Start line (1-based). */
  startLine: number;
  /** End line (1-based, inclusive). Defaults to startLine when omitted. */
  endLine?: number;
  /**
   * Severity tag from the reviewer output.
   * "BLOCKING" → failure; "NON-BLOCKING" → warning; anything else → notice.
   */
  severity: string;
  /** Short title for the annotation (shown in the GitHub Files Changed view). */
  title: string;
  /** Full finding message / explanation. */
  message: string;
  /** Optional raw details (code snippets, stack traces, etc.) */
  rawDetails?: string;
}

export interface SessionPrCheckRunSubmitParams {
  /** Session UUID or task-based alias (e.g. "mt#847") */
  sessionId?: string;
  /** Task ID — used when no explicit sessionId is provided */
  task?: string;
  /** Repository path filter */
  repo?: string;
  /**
   * List of reviewer findings to compile into check-run annotations.
   * An empty list produces a check run with conclusion "success" and no
   * annotations.
   */
  findings: ReviewFinding[];
  /**
   * Optional override for the check run name.
   * Defaults to "minsky-reviewer/findings".
   */
  checkRunName?: string;
}

export interface SessionPrCheckRunSubmitResult {
  /** GitHub check-run ID of the created check run. */
  checkRunId: number;
  /** Web URL for the check run detail page. */
  htmlUrl: string;
  /** Derived conclusion ("failure" | "neutral" | "success"). */
  conclusion: "failure" | "neutral" | "success";
  /** Total number of annotations posted. */
  annotationCount: number;
  /** PR number the check run is attached to. */
  prNumber: number;
  /** Session that was used to find the PR. */
  sessionId: string;
}

// ── Constants ─────────────────────────────────────────────────────────────

/** Default check run name — stable identifier for branch-protection config. */
export const DEFAULT_CHECK_RUN_NAME = "minsky-reviewer/findings";

// ── Implementation ────────────────────────────────────────────────────────

/**
 * Submit a GitHub Check Run for the pull request associated with a Minsky
 * session, compiling the supplied findings list into check-run annotations.
 */
export async function sessionPrCheckRunSubmit(
  params: SessionPrCheckRunSubmitParams,
  deps: SessionPrCheckRunSubmitDependencies
): Promise<SessionPrCheckRunSubmitResult> {
  const { sessionDB } = deps;

  // ── Resolve session ────────────────────────────────────────────────
  const resolvedContext = await resolveSessionContextWithFeedback({
    sessionId: params.sessionId,
    task: params.task,
    repo: params.repo,
    sessionProvider: sessionDB,
    allowAutoDetection: true,
  });

  const sessionRecord = await sessionDB.getSession(resolvedContext.sessionId);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
  }

  // ── Only GitHub-backed sessions are supported ──────────────────────
  if (sessionRecord.backendType !== "github") {
    throw new ValidationError(
      `session.pr.check_run.submit only supports GitHub-backed sessions. ` +
        `This session uses backend: ${sessionRecord.backendType ?? "unknown"}`
    );
  }

  // ── Require an existing PR ─────────────────────────────────────────
  const prNumber = sessionRecord.pullRequest?.number;
  if (!prNumber) {
    throw new ResourceNotFoundError(
      `No pull request found for session '${resolvedContext.sessionId}'. ` +
        `Use 'minsky session pr create' to create a PR first.`
    );
  }

  // ── Validate findings before doing any I/O ────────────────────────
  // GitHub Checks API requires end_line >= start_line; an inverted range
  // produces a 422 rejection for the entire create call.
  for (const finding of params.findings) {
    if (finding.endLine !== undefined && finding.endLine < finding.startLine) {
      throw new ValidationError(
        `Finding at path '${finding.path}' has endLine (${finding.endLine}) less than ` +
          `startLine (${finding.startLine}). GitHub Checks API requires endLine >= startLine.`
      );
    }
  }

  // ── Build the backend ──────────────────────────────────────────────
  const config: RepositoryBackendConfig = {
    type: RepositoryBackendType.GITHUB,
    repoUrl: sessionRecord.repoUrl,
  };
  const backend = await createRepositoryBackend(config, sessionDB);

  if (!backend.review.submitCheckRun) {
    throw new MinskyError(
      "The repository backend for this session does not support submitCheckRun. " +
        "Only GitHub-backed sessions support check run submission."
    );
  }

  // ── Map findings to annotations ────────────────────────────────────
  const annotations: CheckRunAnnotation[] = params.findings.map((finding) => ({
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine ?? finding.startLine,
    annotationLevel: mapSeverityToAnnotationLevel(finding.severity),
    title: finding.title,
    message: finding.message,
    ...(finding.rawDetails !== undefined ? { rawDetails: finding.rawDetails } : {}),
  }));

  // ── Derive conclusion from annotation levels ───────────────────────
  const levels: AnnotationLevel[] = annotations.map((a) => a.annotationLevel);
  const conclusion = deriveConclusion(levels);

  const checkRunName = params.checkRunName ?? DEFAULT_CHECK_RUN_NAME;

  // ── Build summary text ─────────────────────────────────────────────
  const blockingCount = levels.filter((l) => l === "failure").length;
  const nonBlockingCount = levels.filter((l) => l === "warning").length;
  const infoCount = levels.filter((l) => l === "notice").length;

  const summaryParts: string[] = [];
  if (blockingCount > 0) summaryParts.push(`${blockingCount} blocking`);
  if (nonBlockingCount > 0) summaryParts.push(`${nonBlockingCount} non-blocking`);
  if (infoCount > 0) summaryParts.push(`${infoCount} informational`);
  const summaryText =
    annotations.length === 0
      ? "No findings — all checks passed."
      : `${annotations.length} finding${annotations.length === 1 ? "" : "s"}: ${summaryParts.join(", ")}.`;

  log.debug("Submitting check run via Minsky", {
    sessionId: resolvedContext.sessionId,
    prNumber,
    checkRunName,
    conclusion,
    annotationCount: annotations.length,
  });

  // ── Submit the check run (backend resolves head SHA + handles pagination) ──
  const result = await backend.review.submitCheckRun(prNumber, {
    name: checkRunName,
    status: "completed",
    conclusion,
    output: {
      title: `minsky-reviewer: ${annotations.length} finding${annotations.length === 1 ? "" : "s"}`,
      summary: summaryText,
      annotations,
    },
  });

  return {
    checkRunId: result.checkRunId,
    htmlUrl: result.htmlUrl,
    conclusion,
    annotationCount: annotations.length,
    prNumber,
    sessionId: resolvedContext.sessionId,
  };
}
