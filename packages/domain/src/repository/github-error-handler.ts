/**
 * Shared Octokit error-handling utilities for GitHub backend operations.
 *
 * Extracts the repeated pattern of classifying HTTP status codes and
 * Octokit response payloads into user-friendly MinskyError messages.
 */

import { MinskyError, getErrorMessage } from "../errors/index";
import { getLastGithubRateLimitSnapshot } from "./github-rate-limit-state";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// ── HTML-body sanitization (mt#2888) ─────────────────────────────────────
//
// GitHub occasionally serves a 5xx (or other) response as an HTML error
// page (the "Unicorn" page — ~5KB of markup with base64-inlined images)
// instead of JSON. `@octokit/request`'s fetch wrapper folds a non-JSON
// string response body DIRECTLY into the thrown `RequestError`'s `.message`
// (see `toErrorMessage`/`getResponseData` in
// `@octokit/request/dist-src/fetch-wrapper.js`: `if (typeof data ===
// "string") return data;`) — so without this guard, the raw markup flows
// straight through `classifyOctokitError` into every `handleOctokitError`
// branch that echoes `info.message` (the 5xx branch's `Error:
// ${info.message}` line in particular), burning agent context and burying
// the actual signal. Originating incident: mt#2888, 2026-07-16 — `gh api`'s
// own JSON-decode failure surfaced this class independently (`invalid
// character '<' looking for beginning of value`); the Octokit path exhibits
// the SAME underlying GitHub behavior, but Octokit's fetch layer swallows
// the parse failure and keeps the raw body as the message instead of
// erroring, so it needs this dedicated sanitization pass.
const HTML_BODY_PATTERN = /<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i;

/**
 * True when `text` looks like an HTML document body rather than a GitHub
 * API JSON/plain-text error message. Only inspects a bounded prefix — an
 * HTML document's doctype/opening tags always appear at the very start.
 */
export function looksLikeHtmlBody(text: string): boolean {
  if (!text) return false;
  return HTML_BODY_PATTERN.test(safeTruncate(text, 500, "head"));
}

/**
 * Replace an HTML-body message with a short, safe placeholder naming the
 * byte length — never echoes the markup itself. Callers that need the HTTP
 * status for classification already have it via `OctokitErrorInfo.status`,
 * independent of this sanitization (status is extracted separately from
 * `error.status` / `error.response.status`, not parsed out of the message).
 */
export function sanitizeOctokitMessage(message: string): string {
  if (!looksLikeHtmlBody(message)) return message;
  return `<non-JSON HTML error page from GitHub, ${message.length} chars — see HTTP status for classification>`;
}

// ── Structured error info extracted from an Octokit error ──────────────

export interface OctokitErrorInfo {
  /** HTTP status code, if present */
  status?: number;
  /**
   * True when the error carries a `response` — i.e. GitHub actually sent one.
   *
   * Load-bearing for the 5xx branch (mt#3221). `@octokit/request`'s fetch wrapper
   * synthesizes `status: 500` for EVERY transport-level failure (DNS failure, connection
   * refused, TLS error, abort), rethrowing as `new RequestError(message, 500, { request })`
   * with no `response`; every path that throws for a response GitHub actually SENT passes
   * `response: octokitResponse`. So this flag — not the status — is what distinguishes
   * "GitHub returned a server error" from "the request never reached GitHub."
   */
  hasResponse: boolean;
  /** Top-level error message */
  message: string;
  /** Lowercased message for quick substring checks */
  messageLower: string;
  /** Array of structured GitHub error objects (from response.data.errors) */
  ghErrors: Record<string, unknown>[];
  /** Concatenated, lowercased text of ghMessage + ghErrors fields */
  ghErrorsText: string;
  /** GitHub response message (response.data.message) */
  ghMessage: string;
  /**
   * Path portion of the request that produced this error, when available
   * (mt#4692).
   *
   * Sourced from `RequestError.request.url` — a DOCUMENTED public field
   * (`@octokit/request-error`'s own README shows `error.request` alongside
   * `.status`/`.response` as the intended inspection surface). Every
   * `@octokit/request` error is constructed with it: both a real HTTP
   * response (`throw new RequestError(toErrorMessage(data), status, {
   * response, request: requestOptions })`) and a synthesized transport
   * failure (`throw new RequestError(message, 500, { request:
   * requestOptions })`) pass `request: requestOptions` — see
   * `@octokit/request/dist-src/fetch-wrapper.js`. `undefined` for error
   * shapes that never went through Octokit's request layer (a plain
   * `Error`, or a hand-constructed status error in a test) — callers must
   * treat that absence as "no evidence," not as "definitely repo-level" or
   * "definitely sub-resource."
   */
  requestPath?: string;
}

/**
 * Extract the pathname from an Octokit `RequestError.request.url`, when the
 * value is a well-formed absolute URL. Returns `undefined` on anything else
 * (not a string, empty, unparseable) rather than throwing — this is
 * best-effort evidence, not a required field.
 */
function extractRequestPath(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length === 0) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Extract structured information from an Octokit / GitHub API error.
 *
 * Works whether the value is an Octokit RequestError, a plain Error,
 * or an unknown value.
 */
interface OctokitErrorShape {
  status?: number;
  response?: {
    status?: number;
    data?: {
      message?: unknown;
      errors?: Record<string, unknown>[];
    };
  };
  /** Present on every `@octokit/request` `RequestError` — see `requestPath` above. */
  request?: {
    url?: unknown;
  };
}

export function classifyOctokitError(error: unknown): OctokitErrorInfo {
  const anyErr = error as OctokitErrorShape; // Octokit errors have dynamic shape not covered by standard types
  const rawMessage: string = error instanceof Error ? error.message : String(error);
  const message: string = sanitizeOctokitMessage(rawMessage);
  const status: number | undefined = anyErr?.status ?? anyErr?.response?.status;
  const hasResponse: boolean = anyErr?.response != null;
  const ghData = anyErr?.response?.data;
  const rawGhMessage: string = typeof ghData?.message === "string" ? ghData.message : "";
  const ghMessage: string = sanitizeOctokitMessage(rawGhMessage);
  const ghErrors: Record<string, unknown>[] = Array.isArray(ghData?.errors) ? ghData.errors : [];
  const ghErrorsText: string = `${ghMessage || ""} ${ghErrors
    .map((e) => [e?.["message"], e?.["code"], e?.["field"]].filter(Boolean).join(" "))
    .join(" ")}`.toLowerCase();
  const requestPath: string | undefined = extractRequestPath(anyErr?.request?.url);

  return {
    status,
    hasResponse,
    message,
    messageLower: message.toLowerCase(),
    ghErrors,
    ghErrorsText,
    ghMessage,
    requestPath,
  };
}

/**
 * Placeholder for the trailing detail line when GitHub supplied no usable text.
 *
 * An EMPTY `Error:` line is worse than no line: it reads as "the tool has nothing to say"
 * when the truth is "the server said nothing," and it gives the reader no way to tell those
 * apart. Naming the absence explicitly is what makes the difference legible (mt#3171).
 *
 * Kept SHORT (PR #2313 R1): this string is excerpted into one-line summaries by
 * `withOriginalMessage` at the adapter layer, where a long parenthetical crowds out the
 * headline it is attached to.
 */
export const NO_DETAIL_PLACEHOLDER = "(no message from GitHub)";

/**
 * Pick the most informative human-readable detail available for a failed request.
 *
 * Preference order, most-specific first:
 *   1. `ghMessage` — GitHub's OWN `response.data.message`. The server's account of what went
 *      wrong is strictly more useful than the client library's, which is often a generic
 *      restatement of the status line.
 *   2. A display rendering of `ghErrors` (`response.data.errors[]`) — also SERVER-supplied,
 *      so it outranks the client-side `.message` below.
 *   3. `message` — the Error object's own `.message`, the client library's account.
 *
 * The ordering principle is server-before-client (PR #2313 R1): both (1) and (2) come from
 * GitHub's response body; (3) is whatever Octokit chose to put on the Error. The original
 * implementation put (3) second, which contradicted that principle and this task's own SC1.
 *
 * NOTE on (2): this re-renders `ghErrors` rather than reusing {@link OctokitErrorInfo.ghErrorsText},
 * because that field is lowercased and space-joined for SUBSTRING MATCHING — displaying it would
 * show the user mangled text. Matching text and display text are different products of the same
 * source. (SC1 originally named `ghErrorsText` directly; the spec was corrected to name the
 * display rendering, since the matching field is unfit for display.)
 *
 * Returns null when every candidate is empty, so callers can decide how to render the absence.
 *
 * mt#3171: before this existed, the 5xx branch interpolated `info.message` directly. During the
 * 2026-07-24 GitHub outage that field was an empty string while `ghMessage` held the server's
 * actual text — so the surfaced error ended in a bare `Error:` and the useful detail, already
 * parsed and sitting one field away, was never shown.
 */
export function selectErrorDetail(info: OctokitErrorInfo): string | null {
  if (typeof info.ghMessage === "string" && info.ghMessage.trim().length > 0) {
    return info.ghMessage.trim();
  }

  const structured = info.ghErrors
    .map((e) => [e?.["message"], e?.["code"], e?.["field"]].filter(Boolean).join(" ").trim())
    .filter((s) => s.length > 0);
  if (structured.length > 0) {
    return structured.join("; ");
  }

  if (typeof info.message === "string" && info.message.trim().length > 0) {
    return info.message.trim();
  }

  return null;
}

/** Build the trailing `Error: …` line, never bare. See {@link NO_DETAIL_PLACEHOLDER}. */
export function formatErrorDetailLine(info: OctokitErrorInfo): string {
  return `Error: ${selectErrorDetail(info) ?? NO_DETAIL_PLACEHOLDER}`;
}

// ── Context passed to the error handler so messages are specific ────────

/**
 * What a GitHub-backed failure actually WAS, carried as data on the thrown
 * error (mt#3249).
 *
 * Before this existed, `handleOctokitError` computed the classification, threw
 * it away into prose, and the adapter layer reconstructed it by regex-matching
 * that prose (`merge-error-classification.ts` recovers the status with
 * `/\(HTTP (5\d\d)\)/` and matches the exact headline string). That round-trip
 * — class → string → class — made operator-facing WORDING a parsed API:
 * mt#2890 had to put the status into the message purely so the classifier
 * could read it back, and every later change to this file (mt#3171, mt#3221)
 * had to prove it did not disturb the headline.
 *
 * Consumers should prefer this field and fall back to string matching only for
 * errors that do not carry it (non-Octokit origins, or anything not yet
 * migrated).
 *
 * `respondedByServer` mirrors {@link OctokitErrorInfo.hasResponse}: it is the
 * difference between "GitHub returned this status" and "the request never got
 * a response" (mt#3221), which the status alone cannot express since Octokit
 * synthesizes `500` for transport failures.
 */
export type OctokitFailureKind =
  | "auth"
  | "rate-limit"
  | "permission"
  | "not-found"
  | "degraded"
  | "network"
  | "merge-blocked"
  | "self-approval"
  | "unclassified";

export interface OctokitFailureClass {
  kind: OctokitFailureKind;
  /** HTTP status when one is known. */
  status?: number;
  /** True when GitHub actually sent a response (see {@link OctokitErrorInfo.hasResponse}). */
  respondedByServer: boolean;
}

/**
 * A `MinskyError` that additionally carries {@link OctokitFailureClass}.
 *
 * Extends `MinskyError` rather than replacing it so every existing
 * `instanceof MinskyError` check — including `github-pr-operations.ts`'s
 * rethrow guard and this module's own tests — keeps passing unchanged.
 *
 * **The original error is always passed as `cause`** (mt#3169). This handler
 * replaces the thrown value, so without it the upstream payload —
 * `response.data.documentation_url`, the raw `errors[]`, the request's
 * method/URL — is destroyed at the throw and no caller can ever print it. That
 * is precisely why `session_pr_create`'s advertised `--debug` had nothing to
 * show: the detail was gone before the adapter saw the error, so the fix had to
 * restore the chain before it could render anything.
 */
export class GitHubApiError extends MinskyError {
  constructor(
    message: string,
    public readonly classification: OctokitFailureClass,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

/** Build the classification for a throw site from the already-parsed info. */
function classOf(
  kind: OctokitFailureKind,
  info: Pick<OctokitErrorInfo, "status" | "hasResponse">
): OctokitFailureClass {
  // `typeof === "number"`, not `!== undefined` (PR #2351 R1): `status` is typed
  // `number | undefined` but derives from `anyErr?.status ?? anyErr?.response?.status`
  // over an `unknown` error, so a shape carrying explicit nulls yields `null` at
  // runtime. `!== undefined` would let that through and a consumer stringifying
  // it would emit the literal "null" as a status.
  return {
    kind,
    ...(typeof info.status === "number" ? { status: info.status } : {}),
    respondedByServer: info.hasResponse,
  };
}

export interface ErrorContext {
  /** Human-readable operation name, e.g. "create pull request" */
  operation: string;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** PR number when applicable */
  prNumber?: number;
  /** Source branch (for create PR) */
  sourceBranch?: string;
  /** Base branch (for create PR) */
  baseBranch?: string;
}

/**
 * True when `requestPath` names a resource BENEATH the repository root —
 * something with its own identity a 404 could independently be about (a
 * workflow file, a branch name, a label, a file path) — rather than the
 * repo container itself or a bare, identifier-less collection directly
 * under it (mt#4692).
 *
 * `pulls.create`'s path is `/repos/{owner}/{repo}/pulls` — there is no PR
 * number yet, so "pulls" is the ONLY thing in the path beyond owner/repo,
 * and it is a fixed literal from Octokit's endpoint template, not a
 * caller-supplied value. Nothing there can independently fail to resolve,
 * so a 404 can only be explained by the repo/owner segment — genuinely
 * "repo-level." A path one level deeper
 * (`/actions/workflows/{workflow_id}/runs`, `/branches/{branch}/protection`,
 * `/labels/{name}`) names a specific nested resource whose own
 * non-existence explains the 404 — reaching that endpoint at all already
 * proves the repo resolved, so App coverage is already disproven by the
 * request that failed.
 *
 * Undetermined (no path evidence at all) returns `false` — i.e. "not
 * sub-resource," the same as the exact-repo-root case. This is
 * deliberately the SAME answer for two different reasons: it preserves
 * mt#4680's original behavior (which had no path evidence and always
 * showed the hint on a non-PR 404) for every error shape that carries no
 * request info, and it only narrows the hint on POSITIVE evidence of a
 * sub-resource path, never on the absence of evidence.
 *
 * **Locates `/repos/{owner}/{repo}` rather than anchoring at the start of
 * the path (mt#4692 PR #3421 R1).** `createOctokit` here always talks to
 * github.com, but `error.request.url` is a general Octokit contract — the
 * client accepts a `baseUrl` override, and Octokit's own docs use exactly
 * this shape for GitHub Enterprise Server: `new Octokit({ baseUrl:
 * "https://HOSTNAME/api/v3" })`, which puts an `/api/v3` (or any other
 * host-specific mount path) BEFORE `/repos/...` in the resolved URL.
 * Anchoring the match at the start of the path would silently fall through
 * to "no evidence" for every GHE request — the exact false-positive class
 * this task exists to remove, reappearing on a deployment shape the tests
 * never exercised. Scanning for the segment wherever it occurs handles a
 * GHE mount prefix, or any other proxy/gateway prefix, without needing to
 * enumerate them — the same "no hardcoded list to drift" reasoning as the
 * rest of this discriminator (see the file-level doc comment above).
 */
function requestAddressesSubResource(requestPath: string | undefined): boolean {
  if (!requestPath) return false;
  const match = requestPath.match(/\/repos\/[^/]+\/[^/]+(\/.*)?$/);
  if (!match) return false;
  const tail = (match[1] ?? "").replace(/^\/+|\/+$/g, "");
  if (tail === "") return false;
  return tail.includes("/");
}

// ── The main dispatcher ─────────────────────────────────────────────────

/**
 * Throw a user-friendly MinskyError based on the classified Octokit error.
 *
 * Call this from a catch block *after* any operation-specific handling.
 * It covers the common HTTP-status patterns (401, 403, 404, 422, 429,
 * network errors) so each call-site doesn't have to duplicate them.
 *
 * Always throws — the return type `never` lets callers write:
 *   `throw handleOctokitError(error, ctx);`
 * even though the function itself throws, to satisfy control-flow analysis.
 */
export function handleOctokitError(error: unknown, ctx: ErrorContext): never {
  const info = classifyOctokitError(error);

  // ── Authentication (401 / bad credentials) ──────────────────────
  if (
    info.status === 401 ||
    info.messageLower.includes("401") ||
    info.messageLower.includes("bad credentials") ||
    info.messageLower.includes("unauthorized")
  ) {
    throw new GitHubApiError(
      `GitHub Authentication Failed\n\n` +
        `Your GitHub token is invalid or expired.\n\n` +
        `To fix this:\n` +
        `  1. Generate a new Personal Access Token at ` +
        `https://github.com/settings/tokens\n` +
        `  2. Set it as GITHUB_TOKEN or GH_TOKEN environment variable\n` +
        `  3. Ensure the token has 'repo' and 'pull_requests' permissions\n\n` +
        `Repository: ${ctx.owner}/${ctx.repo}`,
      classOf("auth", info),
      error
    );
  }

  // ── Rate limiting (checked BEFORE 403: GitHub's primary rate limits are
  // HTTP 403 with a "rate limit" message, and the 403 branch below matches
  // any 403 — ordering is load-bearing; PR #2005 R-final finding, mt#2890) ──
  if (
    info.status === 429 ||
    info.messageLower.includes("429") ||
    info.messageLower.includes("rate limit")
  ) {
    // mt#2888: fold the last-observed `x-ratelimit-reset` into the message
    // when available, so the reset time survives into
    // `withOriginalMessage`'s one-line excerpt at the adapter layer instead
    // of a bare "wait a few minutes" with no concrete time.
    const snapshot = getLastGithubRateLimitSnapshot();
    const resetSuffix = snapshot ? ` (resets ${snapshot.reset})` : "";
    throw new GitHubApiError(
      `GitHub Rate Limit Exceeded${resetSuffix}\n\n` +
        `You've hit GitHub's API rate limit.\n\n` +
        `To fix this:\n` +
        `  - Wait a few minutes before trying again\n` +
        `  - Use a GitHub token for higher rate limits`,
      classOf("rate-limit", info),
      error
    );
  }

  // ── Permission denied (403 / forbidden) ─────────────────────────
  if (
    (info.status === 403 ||
      info.messageLower.includes("403") ||
      info.messageLower.includes("forbidden")) &&
    !info.messageLower.includes("422")
  ) {
    throw new GitHubApiError(
      `GitHub Permission Denied\n\n` +
        `You don't have permission to ${ctx.operation} in ` +
        `${ctx.owner}/${ctx.repo}.\n\n` +
        `To fix this:\n` +
        `  - Ensure you have write access to the repository\n` +
        `  - Verify your GitHub token has sufficient permissions\n\n` +
        `Repository: https://github.com/${ctx.owner}/${ctx.repo}`,
      classOf("permission", info),
      error
    );
  }

  // ── Not found (404) ─────────────────────────────────────────────
  if (
    info.status === 404 ||
    info.messageLower.includes("404") ||
    info.messageLower.includes("not found")
  ) {
    // mt#4692: reaching a SUB-RESOURCE endpoint (a workflow file, a branch,
    // a label, ...) already proves the repo resolved — see
    // `requestAddressesSubResource`. Only checked when there is no PR
    // number, since the PR-level branch below is a separate, already-narrow
    // carve-out.
    const isSubResource404 = !ctx.prNumber && requestAddressesSubResource(info.requestPath);

    const subject = ctx.prNumber
      ? `Pull request #${ctx.prNumber} was not found in ${ctx.owner}/${ctx.repo}.`
      : isSubResource404
        ? `Could not ${ctx.operation} in ${ctx.owner}/${ctx.repo} — the resource was not found.`
        : `The repository ${ctx.owner}/${ctx.repo} was not found, or the Minsky GitHub App ` +
          `installation does not cover it.`;
    const prSuffix = ctx.prNumber ? `/pull/${ctx.prNumber}` : "";

    // mt#4680: a repo-level 404 has TWO indistinguishable causes on an
    // App-authenticated call — the repository genuinely does not exist, or it
    // exists and the installation was never granted access to it. GitHub
    // returns the same 404 for both (it will not confirm the existence of a
    // repo the caller cannot see), so the message must name both rather than
    // asserting the first. Naming only "not found" sent an operator looking
    // for a typo when the actual cause was a missing grant.
    //
    // mt#4692: that argument does NOT hold for a sub-resource 404 — the
    // request that failed already proves the repo/installation resolved, so
    // naming App coverage there would be the exact false lead this hint
    // exists to remove, one call site deeper.
    const appHint =
      ctx.prNumber || isSubResource404
        ? ""
        : `  - Check whether the Minsky GitHub App installation covers ` +
          `${ctx.owner}/${ctx.repo} — an ungranted repo returns this same 404.\n` +
          `    Grant it under Settings -> Applications -> Installed GitHub Apps -> Repository access,\n` +
          `    or run \`minsky setup\`, which now reports coverage.\n`;

    throw new GitHubApiError(
      `GitHub Not Found\n\n${subject}\n\n` +
        `To fix this:\n` +
        `  - Verify the repository/PR exists and is accessible\n` +
        `  - Check if the repository is private and you have access\n${
          appHint
        }\nhttps://github.com/${ctx.owner}/${ctx.repo}${prSuffix}`,
      classOf("not-found", info),
      error
    );
  }

  // ── Server-side degradation (5xx GitHub actually responded with) ──
  //
  // mt#2890: distinct from the generic fallback below so the status code
  // survives into the message text — the fallback's `getErrorMessage(error)`
  // typically does NOT include the numeric status, which downstream
  // classifiers (workflow-commands.ts's merge-error classifier) rely on to
  // tell a real GitHub-side outage apart from a merge conflict or a rate
  // limit.
  //
  // mt#3221: `hasResponse` is a correctness guard, not a refinement. Octokit
  // synthesizes `status: 500` for every transport-level failure, so without it
  // the operator's OWN connectivity failure renders as "GitHub API
  // degraded/unavailable" and `classifyMergeError` records a GitHub outage —
  // pointing the operator at githubstatus.com for a fault on their end.
  //
  // Trade-off, taken deliberately: a genuine GitHub 5xx re-thrown through a
  // wrapper that preserved only `.status` would lose `.response` and route to
  // the network branch instead. No such wrapper exists on any current path —
  // every `handleOctokitError` call site passes the raw caught error — and
  // claiming a GitHub outage from an error carrying no evidence GitHub
  // responded is the same unearned-cause assertion mt#3171 removed from this
  // branch's own text.
  const isServer5xx =
    info.status !== undefined && info.status >= 500 && info.status < 600 && info.hasResponse;

  // A 5xx WITHOUT a response is Octokit's synthesized transport failure — it
  // belongs in the network branch below, where the guidance actually matches.
  const isSynthesizedTransport5xx =
    info.status !== undefined && info.status >= 500 && info.status < 600 && !info.hasResponse;

  if (isServer5xx) {
    throw new GitHubApiError(
      `GitHub API degraded/unavailable (HTTP ${info.status})\n\n` +
        `GitHub's API returned a server error for this request. A 5xx is a server-side ` +
        `failure; it does not, by itself, establish whether your request, credentials, or ` +
        `repository state were involved.\n\n` +
        `To fix this:\n` +
        `  - Check GitHub status: https://www.githubstatus.com/\n` +
        `  - Retry the operation in a few minutes\n\n${formatErrorDetailLine(info)}`,
      classOf("degraded", info),
      error
    );
  }

  // ── Network / connectivity ──────────────────────────────────────
  //
  // mt#3221: a status-LESS error whose message merely mentions a gateway
  // timeout stays here deliberately, rather than being promoted to the
  // degraded branch above. With neither a status nor a response there is no
  // evidence GitHub responded at all, so naming it a GitHub outage would
  // assert precisely what cannot be established — and matching `5xx` out of
  // message text would additionally misfire on ordinary prose, since `500` is
  // a common round number in a way `403`/`404` are not.
  if (
    isSynthesizedTransport5xx ||
    info.messageLower.includes("network") ||
    info.messageLower.includes("timeout") ||
    info.messageLower.includes("enotfound")
  ) {
    throw new GitHubApiError(
      `Network Connection Error\n\n` +
        `Unable to connect to GitHub API.\n\n` +
        `To fix this:\n` +
        `  - Check your internet connection\n` +
        `  - Verify GitHub is accessible (https://githubstatus.com)\n` +
        `  - Try again in a few moments\n\n${formatErrorDetailLine(info)}`,
      classOf("network", info),
      error
    );
  }

  // ── Self-approval ───────────────────────────────────────────────
  if (
    info.messageLower.includes("can not approve your own pull request") ||
    info.messageLower.includes("cannot approve your own pull request")
  ) {
    const prLink = ctx.prNumber
      ? `PR: https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.prNumber}\n\n`
      : "";
    throw new GitHubApiError(
      `Cannot Approve Your Own Pull Request\n\n` +
        `GitHub prevents authors from approving their own PR.\n\n` +
        `${prLink}Next steps:\n` +
        `  - Request a review from a maintainer\n` +
        `  - Have another collaborator approve the PR`,
      classOf("self-approval", info),
      error
    );
  }

  // ── Fallback ────────────────────────────────────────────────────
  throw new GitHubApiError(
    `Failed to ${ctx.operation}: ${getErrorMessage(error)}`,
    classOf("unclassified", info),
    error
  );
}

/**
 * Handle 422 validation errors for PR creation specifically.
 *
 * Separated because only createPullRequest needs the fine-grained
 * "already exists" / "no commits between" sub-classification.
 */
export function handleCreatePR422(info: OctokitErrorInfo, ctx: ErrorContext): void {
  if (info.status !== 422 && !info.messageLower.includes("422")) {
    return; // not a 422
  }

  const text = info.ghErrorsText || info.messageLower;

  // No commits between base and head
  if (text.includes("no commits between") || text.includes("no changes")) {
    throw new MinskyError(
      `No Changes to Create PR\n\n` +
        `No differences found between ` +
        `${ctx.sourceBranch} and ${ctx.baseBranch}.\n\n` +
        `To fix this:\n` +
        `  - Make sure your changes are committed to ${ctx.sourceBranch}\n` +
        `  - Push your branch: git push origin ${ctx.sourceBranch}\n` +
        `  - Verify you're on the correct branch: git branch`
    );
  }

  // PR already exists
  if (
    text.includes("already exists") ||
    info.ghErrors.some((e) =>
      String(e?.["message"] || e?.["code"] || "")
        .toLowerCase()
        .includes("already exists")
    )
  ) {
    throw new MinskyError(
      `Pull Request Already Exists\n\n` +
        `A pull request from ${ctx.sourceBranch} to ` +
        `${ctx.baseBranch} already exists.\n\n` +
        `Options:\n` +
        `  - Update the existing PR instead of creating a new one\n` +
        `  - Use a different branch name\n` +
        `  - Close the existing PR if it's no longer needed\n\n` +
        `Check: https://github.com/${ctx.owner}/${ctx.repo}/pulls`
    );
  }

  // Generic 422
  throw new MinskyError(
    `GitHub Validation Failed\n\n` + `${info.ghMessage || "Unprocessable Entity"}`
  );
}

/**
 * Handle 405/422 merge-specific errors with optional diagnosis.
 *
 * Returns `true` if a MinskyError was thrown (it always throws when it
 * matches), `false` if the status didn't match.
 */
export function handleMerge405or422(
  info: OctokitErrorInfo,
  ctx: ErrorContext,
  diagnosis?: string
): void {
  const isMergeBlock =
    info.status === 405 ||
    info.status === 422 ||
    info.messageLower.includes("405") ||
    info.messageLower.includes("422") ||
    info.messageLower.includes("merge conflicts");

  if (!isMergeBlock) {
    return;
  }

  const body = diagnosis
    ? diagnosis
    : `Common causes:\n` +
      `  - Merge conflicts that need to be resolved\n` +
      `  - Branch protection rules requiring reviews\n` +
      `  - Required status checks not passing\n` +
      `  - PR is not in an open state`;

  // No cause available here: this helper receives the already-parsed `info`,
  // not the original error (its callers hold that). Threading it would mean a
  // signature change across callers for a path `--debug` does not exercise —
  // mt#3169 scopes the cause chain to `handleOctokitError`.
  throw new GitHubApiError(
    `Pull Request Cannot Be Merged\n\n` +
      `Pull request #${ctx.prNumber} cannot be merged automatically.\n\n` +
      `${body}\n\n` +
      `Visit the PR to resolve: ` +
      `https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.prNumber}`,
    classOf("merge-blocked", info)
  );
}
