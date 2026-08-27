/**
 * GitHub API client for the reviewer service.
 *
 * Uses the minsky-reviewer App's installation token to fetch PR context and
 * post reviews. Authenticates via @octokit/auth-app (JWT → installation
 * token, short-lived, refreshes automatically).
 *
 * Distinct from Minsky's existing TokenProvider; deliberately so, because
 * the reviewer service lives in its own deployment boundary.
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { ReviewerConfig } from "./config";
import { isBotReviewerEntry, type PriorReview } from "./prior-review-summary";
import { withTimeout } from "./with-timeout";
import { log } from "./logger";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * Default GitHub-API timeout used when these helpers are called without an
 * explicit value (tests, scripts that don't load config). Matches the
 * production default in `config.ts` (`REVIEWER_GITHUB_TIMEOUT_MS`); kept in
 * sync manually because the test surface that calls these helpers directly
 * doesn't load config.
 *
 * mt#1086.
 */
const DEFAULT_GITHUB_TIMEOUT_MS = 30_000;

export async function createOctokit(config: ReviewerConfig): Promise<Octokit> {
  // mt#2717: install `createAppAuth` as the Octokit `authStrategy` rather than
  // extracting a static installation-token STRING. The prior form —
  //   const { token } = await auth({ type: "installation" });
  //   return new Octokit({ auth: token });
  // — pinned the client to `@octokit/auth-token` (a static strategy) holding a
  // token GitHub expires after ~60 minutes. Any client reused past that mark
  // (both sweepers cache one for the whole process lifetime) then returns
  // `401 "Bad credentials"` on EVERY subsequent call and never self-recovers —
  // the merge-state sweeper alone logged 1,730 such failures in one ~15.5h
  // deployment window. The webhook review path escaped only because it builds a
  // fresh Octokit per review, never crossing the 1h boundary.
  //
  // The `authStrategy` form is the canonical `@octokit/auth-app` usage: the auth
  // hook runs per request and `@octokit/auth-app` "transparently creates an
  // installation access token the first time it is needed and refreshes it when
  // it expires" (cached and reused until ~59 min, then refreshed). This makes a
  // single long-lived reused instance correct — exactly what both sweepers want.
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    },
  });
}

export interface PullRequestContext {
  number: number;
  title: string;
  body: string;
  /** Base repository owner (where the PR targets). Same as `headOwner` for in-repo PRs. */
  owner: string;
  /** Base repository name. Same as `headRepo` for in-repo PRs. */
  repo: string;
  /**
   * Head repository owner. For PRs from forks, this differs from `owner`.
   * `headSha` only exists in the head repo for forked PRs; tool calls that
   * want to read at HEAD must use these coordinates to avoid 404s.
   */
  headOwner: string;
  /** Head repository name. See `headOwner` for fork handling. */
  headRepo: string;
  /** True when the PR originates from a different repo (a fork). */
  isForkedPR: boolean;
  branchName: string;
  baseBranch: string;
  diff: string;
  headSha: string;
  /**
   * List of file paths changed by this PR (relative to repo root).
   * Used by the scope classifier (mt#1188) to determine docs-only / test-only.
   * Derived from `fileEntries` for backward compatibility.
   */
  filesChanged: string[];
  /**
   * Per-file entries with patch, additions, deletions, and status (mt#2120).
   * Used by chunked review to build per-chunk prompts from per-file patches.
   */
  fileEntries: PrFileEntry[];
  /**
   * Authoritative changed-files count from the PR API (`pulls.get` →
   * `changed_files`). The classifier compares this against
   * `filesChanged.length` to detect listFiles truncation (cap exceeded, error
   * fallback, etc.) and downgrade to `normal` rather than classify on a
   * partial view.
   */
  changedFilesCount: number;
}

/**
 * Hard limit on the number of changed files fetched per PR to avoid runaway
 * pagination on PRs that touch thousands of files (GitHub caps at 3000 files
 * per PR but the classifier's heuristics work on far fewer). When the cap is
 * hit we return [] so the scope classifier falls through to conservative
 * `normal` scope rather than classifying on partial data.
 */
export const MAX_FILES_FETCHED = 1000;

export interface PrFileEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previousFilename?: string;
}

/**
 * Fetch the list of files changed by a PR, following Link headers via
 * octokit.paginate. Returns per-file entries with patch, additions,
 * deletions, and status. The `patch` field is omitted by GitHub for
 * files >1MB or binary files.
 *
 * Safety cap: if more than MAX_FILES_FETCHED files are returned the cap is
 * exceeded and [] is returned (scope classifier falls through to normal).
 * On any error an empty array is also returned; both cases emit a structured
 * JSON log so the failure is observable in the service logs.
 *
 * Exported for tests.
 */
export async function fetchListFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS
): Promise<PrFileEntry[]> {
  let allFiles: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    previous_filename?: string;
  }>;
  try {
    allFiles = await withTimeout("github.pulls.listFiles", timeoutMs, (signal) =>
      octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
        request: { signal },
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.info("pr_scope_listfiles_error", {
      event: "pr_scope_listfiles_error",
      owner,
      repo,
      pr: prNumber,
      error: message,
    });
    return [];
  }

  if (allFiles.length > MAX_FILES_FETCHED) {
    log.info("pr_scope_files_cap_exceeded", {
      event: "pr_scope_files_cap_exceeded",
      owner,
      repo,
      pr: prNumber,
      fileCount: allFiles.length,
      cap: MAX_FILES_FETCHED,
    });
    return [];
  }

  return allFiles.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
    ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
  }));
}

export async function fetchPullRequestContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  // mt#1086: per-call timeout — applied independently to each of the three
  // parallel sub-requests, so the overall wall-clock is bounded by
  // max(timeoutMs) rather than 3*timeoutMs.
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS
): Promise<PullRequestContext> {
  const [prResponse, diffResponse, fileEntries] = await Promise.all([
    // mt#1086 PR #969 R2 BLOCKING #1: propagate AbortSignal to Octokit
    // via `request: { signal }` so abort actually cancels the request.
    withTimeout("github.pulls.get", timeoutMs, (signal) =>
      octokit.rest.pulls.get({ owner, repo, pull_number: prNumber, request: { signal } })
    ),
    withTimeout("github.pulls.get.diff", timeoutMs, (signal) =>
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber,
        mediaType: { format: "diff" },
        request: { signal },
      })
    ),
    fetchListFiles(octokit, owner, repo, prNumber, timeoutMs),
  ]);

  const pr = prResponse.data;
  // mediaType: { format: "diff" } makes Octokit return the body as a raw
  // string at runtime even though the typed response is PullRequest. String()
  // safely coerces the runtime value without the as-unknown double cast.
  const diff = String(diffResponse.data);

  // Head repository coords may differ from base coords for forked PRs.
  // pr.head.repo is null in rare cases (deleted fork); fall back to base.
  const headOwner = pr.head.repo?.owner.login ?? owner;
  const headRepo = pr.head.repo?.name ?? repo;
  const isForkedPR = headOwner !== owner || headRepo !== repo;

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    owner,
    repo,
    headOwner,
    headRepo,
    isForkedPR,
    branchName: pr.head.ref,
    baseBranch: pr.base.ref,
    diff,
    headSha: pr.head.sha,
    filesChanged: fileEntries.map((f) => f.filename),
    fileEntries,
    changedFilesCount: pr.changed_files,
  };
}

export interface SubmittedReview {
  id: number;
  htmlUrl: string;
}

/**
 * A single inline comment to submit as part of a review.
 * When `inReplyTo` is set this comment is a reply to an existing comment;
 * GitHub anchors it to the parent comment's location (path/line/side are ignored).
 */
export interface ReviewInlineComment {
  /** File path of the comment anchor (relative to repo root). */
  path: string;
  /** Line number in the diff the comment anchors to (1-based). */
  line: number;
  /** Comment body text. */
  body: string;
  /**
   * Which side of the diff the line refers to. Defaults to `"RIGHT"` (the new
   * version of the file). GitHub's `pulls.createReview` requires `side` when
   * anchoring by `line` — defaulting is not guaranteed, so we always send it
   * when `inReplyTo` is undefined. When `inReplyTo` IS set GitHub anchors via
   * the parent comment and ignores `side`.
   */
  side?: "LEFT" | "RIGHT";
  /**
   * When present, this comment is a reply to the existing review comment with
   * this database ID. Obtain the ID from `fetchReviewThreads` comments[].databaseId.
   */
  inReplyTo?: number;
}

export async function submitReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body: string,
  // mt#1086: per-call timeout. Optional + defaulted (see fetchListFiles
  // for rationale).
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS,
  // mt#1345: optional inline comments with optional in_reply_to wiring.
  inlineComments?: ReviewInlineComment[]
): Promise<SubmittedReview> {
  // mt#3852: split replies out of the review payload BEFORE building it.
  //
  // `createReview`'s comments[] elements are GraphQL `DraftPullRequestReviewComment`,
  // which has no reply field and REQUIRES an anchor. The old reply variant sent
  // `{ body, in_reply_to }` with path/line deliberately omitted, so GitHub rejected
  // all three at once — `inReplyTo` not a field, `path` null, `position` null — and
  // 422'd the ENTIRE review, losing every finding in it. `in_reply_to` is a real
  // documented parameter, but of `createReviewComment` (POST /pulls/{n}/comments),
  // not of `createReview`; mt#1345 applied it to the wrong endpoint. Replies now go
  // to the dedicated replies endpoint after the review lands.
  const all = inlineComments ?? [];
  const replies = all.filter((c) => c.inReplyTo !== undefined);
  const anchorable: ReviewInlineComment[] = [];
  /** Findings whose anchor is unusable; folded into the review body below. */
  const degraded: ReviewInlineComment[] = [];
  for (const c of all) {
    if (c.inReplyTo !== undefined) continue;
    // Validate the anchor locally so a malformed comment cannot 422 the whole
    // review. Dropping one comment loses one finding; the pre-mt#3852 behavior
    // lost the entire review, and surfaced only as an opaque 422 after a full
    // model pass had already been spent.
    const missing: string[] = [];
    if (typeof c.path !== "string" || c.path.length === 0) missing.push("path");
    if (typeof c.line !== "number" || !Number.isFinite(c.line) || c.line < 1) missing.push("line");
    if (missing.length > 0) {
      // PR #2722 R2 BLOCKING: DEGRADE, don't drop. mt#3852's SC2 says an
      // unanchorable finding becomes a body-level finding; the first pass
      // dropped it and documented the deviation instead, which loses reviewer
      // output silently — a smaller version of the whole-review loss this task
      // exists to end.
      log.warn("reviewer.inline_comment_degraded_to_body", {
        pr: prNumber,
        missing,
        path: c.path ?? null,
        line: c.line ?? null,
      });
      degraded.push(c);
      continue;
    }
    // PR #2722 R1 BLOCKING: `side` needs the same treatment. Its TS type is
    // `"LEFT" | "RIGHT"`, but every field on this interface arrives from PARSED
    // MODEL OUTPUT at runtime, where the compiler guarantees nothing — the same
    // reason path/line are checked above. An out-of-enum `side` 422s the whole
    // review exactly like a null anchor did.
    //
    // Coerced rather than dropped: an unusable `side` still leaves a usable
    // anchor, and "RIGHT" is what omitting it already means, so the finding
    // survives instead of being discarded over a field that carries the least
    // information of the three.
    if (c.side !== undefined && c.side !== "LEFT" && c.side !== "RIGHT") {
      log.warn("reviewer.inline_comment_side_coerced", {
        pr: prNumber,
        path: c.path,
        line: c.line,
        received: String(c.side),
        coercedTo: "RIGHT",
      });
      anchorable.push({ ...c, side: "RIGHT" });
      continue;
    }
    anchorable.push(c);
  }

  // PR #2722 R2: fold degraded findings into the review body so an unusable
  // anchor costs the finding its LOCATION, not its existence. Appended after
  // the caller's body — including the provenance HTML comment, which readers
  // locate by marker rather than by position, so trailing content is safe.
  const finalBody =
    degraded.length === 0
      ? body
      : [
          body,
          "",
          "---",
          "",
          "**Findings that could not be anchored to a line** — reported here so they are not lost:",
          "",
          ...degraded.map((c) => {
            const where =
              typeof c.path === "string" && c.path.length > 0 ? `\`${c.path}\`` : "_unknown file_";
            return `- ${where}: ${c.body}`;
          }),
        ].join("\n");

  // mt#1086 PR #969 R2 BLOCKING #1: propagate AbortSignal via request: { signal }.
  const response = await withTimeout("github.pulls.createReview", timeoutMs, (signal) => {
    // Map the already-validated anchorable comments to Octokit's shape.
    //
    // ONE branch now (mt#3852). The second branch this comment used to describe
    // — inReplyTo set, path/line/side omitted — is the defect: `createReview`
    // has no reply field, so that payload 422'd the whole review. Replies are
    // partitioned out above and posted separately.
    //
    // `side` still defaults to "RIGHT" because the GitHub API does not guarantee
    // a default, and sending without it risks the same review-wide 422.
    const comments =
      anchorable.length > 0
        ? anchorable.map((c) => ({
            path: c.path,
            line: c.line,
            side: c.side ?? "RIGHT",
            body: c.body,
          }))
        : undefined;

    // mt#3852: the mt#1782 cast used to exist because this array was a UNION —
    // a reply variant carrying `in_reply_to` (which Octokit's `createReview`
    // signature rightly does not declare) plus an anchored variant. Octokit's
    // type was correct and the union was the bug: `createReview` never accepted
    // `in_reply_to`, and the note here claiming it did is what kept the defect
    // legible-looking for three rounds.
    //
    // PR #2722 R1: the cast is still REQUIRED, so do not read the above as
    // saying it is now vestigial. `side` widens to `string` through the map,
    // while Octokit wants the literal union — that is what the cast bridges.
    // It no longer hides a structurally wrong element, which is the part that
    // mattered; it still hides a literal-widening, which is the ordinary kind.
    type CreateReviewParams = NonNullable<Parameters<typeof octokit.rest.pulls.createReview>[0]>;
    return octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      event,
      body: finalBody,
      ...(comments !== undefined ? { comments: comments as CreateReviewParams["comments"] } : {}),
      request: { signal },
    });
  });

  // mt#3852: post replies AFTER the review lands, via the dedicated endpoint
  // (POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies).
  //
  // Ordering is deliberate: the review is the primary artifact, and a reply
  // failure must not cost it. Each reply is independent — one failing does not
  // stop the rest, and none of them fails the call. A dropped reply degrades to
  // "the bot did not answer that thread"; a thrown one would discard a review
  // that already succeeded, which is the failure mode this task exists to end.
  for (const c of replies) {
    // PR #2722 R1: same class as the anchor validation above — `inReplyTo` is
    // typed `number` but arrives from parsed model output, so the type is not a
    // runtime guarantee. A non-numeric id would reach GitHub as a malformed
    // comment_id; check it here rather than casting and hoping.
    const commentId = c.inReplyTo;
    if (typeof commentId !== "number" || !Number.isInteger(commentId) || commentId < 1) {
      log.warn("reviewer.inline_reply_dropped_bad_id", {
        pr: prNumber,
        received: String(c.inReplyTo),
      });
      continue;
    }
    try {
      await withTimeout("github.pulls.createReplyForReviewComment", timeoutMs, (signal) =>
        octokit.rest.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: prNumber,
          comment_id: commentId,
          body: c.body,
          request: { signal },
        })
      );
    } catch (err) {
      log.warn("reviewer.inline_reply_failed", {
        pr: prNumber,
        inReplyTo: c.inReplyTo,
        error: getLoggableErrorSummary(err),
      });
    }
  }

  return {
    id: response.data.id,
    htmlUrl: response.data.html_url,
  };
}

/**
 * Hard limit on the number of reviews fetched per PR to avoid runaway pagination
 * on pathological PRs with hundreds of reviews. listReviews returns oldest-first,
 * so we take the first MAX_REVIEWS_FETCHED (oldest) and log a warning when truncated.
 */
const MAX_REVIEWS_FETCHED = 500;

/**
 * Fetch prior reviews on a PR posted by the reviewer bot.
 *
 * Filters to reviews from the ALLOWED_REVIEWER_BOT_LOGINS allowlist that also
 * contain the Chinese-wall marker. Drops DISMISSED and PENDING reviews.
 * Returns the remaining reviews sorted ascending by submittedAt (oldest first),
 * ready for summarizePriorReviews.
 *
 * Uses octokit.paginate to fetch all pages (GitHub's listReviews caps at 100
 * per page). Capped at MAX_REVIEWS_FETCHED (500) to avoid runaway fetches on
 * pathological PRs; a warning is logged when the cap is hit.
 *
 * Filter logic lives in isBotReviewerEntry (prior-review-summary.ts) so it
 * can be tested without importing @octokit dependencies.
 */
export async function fetchPriorReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  // mt#1086: per-call timeout. Optional + defaulted (see fetchListFiles).
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS
): Promise<PriorReview[]> {
  // paginate fetches all pages automatically. listReviews returns oldest-first.
  // mt#1086 PR #969 R2 BLOCKING #1: propagate AbortSignal via request: { signal }.
  const allReviews = await withTimeout("github.pulls.listReviews", timeoutMs, (signal) =>
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      request: { signal },
    })
  );

  let rawReviews = allReviews;
  if (rawReviews.length > MAX_REVIEWS_FETCHED) {
    log.warn("reviewer.prior_reviews_cap_exceeded", {
      event: "reviewer.prior_reviews_cap_exceeded",
      pr: prNumber,
      count: rawReviews.length,
      cap: MAX_REVIEWS_FETCHED,
    });
    rawReviews = rawReviews.slice(0, MAX_REVIEWS_FETCHED);
  }

  const reviews = rawReviews
    .map(
      (r): PriorReview => ({
        id: r.id,
        state: r.state as PriorReview["state"],
        submittedAt: r.submitted_at ?? new Date(0).toISOString(),
        commitId: r.commit_id ?? "",
        userLogin: r.user?.login ?? "",
        // GitHub's Reviews API returns null for empty approve/comment bodies.
        // Coalesce to "" so downstream body.includes(...) in
        // isBotReviewerEntry doesn't throw on PRs containing empty reviews.
        body: r.body ?? "",
      })
    )
    .filter((r) => isBotReviewerEntry(r))
    // Sort ascending by submittedAt — oldest first
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

  return reviews;
}

/**
 * A single commit on the PR, as needed for author-response context (mt#2836).
 */
export interface PullRequestCommit {
  sha: string;
  message: string;
  /** ISO timestamp; undefined when GitHub omits it (rare, defensive). */
  authoredAt?: string;
}

/**
 * Cap mirroring MAX_REVIEWS_FETCHED — pathological PRs (hundreds of commits)
 * should not blow up the fetch or the downstream prompt/recovery-pass budget.
 */
const MAX_COMMITS_FETCHED = 500;

/**
 * Fetch commit messages pushed to a PR since a given timestamp (mt#2836).
 *
 * Used to give the reviewer author-response context on re-review rounds: a
 * commit message responding to a prior finding (e.g. "fix(mt#X): add PG17
 * transcript proving GREATEST ignores NULL arguments") is evidence the model
 * should weigh before re-asserting the same BLOCKING finding — see
 * refutation-recovery.ts, which consumes this fetch's output.
 *
 * `sinceIso` is typically the most recent prior review's `submittedAt`.
 * Filtering is done on the commit's own authored/committed date rather than
 * by SHA-diffing against the prior review's `commitId`, so a rebase or
 * force-push that changes SHAs without changing intent still resolves
 * correctly. Note the deliberate contrast with `fetchIncrementalDiffSince`
 * (mt#3471), which resolves by SHA instead: over-including an unrelated commit
 * MESSAGE is harmless to a topical-overlap heuristic, whereas silently scoping
 * a review's DIFF to the wrong commit range is not, so that path prefers a
 * loud 404 to a lenient match. When `sinceIso` is omitted, all commits on the PR are returned
 * (bounded by MAX_COMMITS_FETCHED) — used for the first-review case where
 * there is no prior review to bound against, though callers typically skip
 * calling this at all in that case (there is nothing to respond to yet).
 */
export async function fetchCommitMessagesSince(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  sinceIso?: string,
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS
): Promise<PullRequestCommit[]> {
  const allCommits = await withTimeout("github.pulls.listCommits", timeoutMs, (signal) =>
    octokit.paginate(octokit.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      request: { signal },
    })
  );

  let rawCommits = allCommits;
  if (rawCommits.length > MAX_COMMITS_FETCHED) {
    log.warn("reviewer.commits_since_review_cap_exceeded", {
      event: "reviewer.commits_since_review_cap_exceeded",
      pr: prNumber,
      count: rawCommits.length,
      cap: MAX_COMMITS_FETCHED,
    });
    rawCommits = rawCommits.slice(0, MAX_COMMITS_FETCHED);
  }

  const commits: PullRequestCommit[] = rawCommits
    .map((c): PullRequestCommit => {
      const authoredAt = c.commit.committer?.date ?? c.commit.author?.date ?? undefined;
      return {
        sha: c.sha,
        message: c.commit.message ?? "",
        ...(authoredAt !== undefined ? { authoredAt } : {}),
      };
    })
    .filter((c) => {
      if (sinceIso === undefined) return true;
      // Defensive: a commit with no resolvable date is included rather than
      // silently dropped — better to over-include (the refutation matcher
      // in refutation-recovery.ts is a topical-overlap heuristic, tolerant
      // of extra unrelated commit messages) than to lose a genuine response.
      if (c.authoredAt === undefined) return true;
      return c.authoredAt > sinceIso;
    });

  return commits;
}

/** One changed file between two commits, as needed by the resolution classifier (mt#3300). */
export interface ChangedFileEntry {
  filename: string;
}

/**
 * GitHub's "Compare two commits" endpoint caps the `files` array at 300
 * entries per response and does not paginate further (documented API
 * behavior; there is no explicit truncation flag in the response schema).
 * mt#3300 R1 non-blocking: a response that hits this cap MAY be truncated —
 * silently treating it as complete could miss the finding's cited file (it
 * could be file #301+) and manufacture a false `resolved-without-code-change`
 * verdict. `fetchChangedFilesSince` treats a hit-the-cap response as
 * ambiguous (returns `undefined`, the same "cannot determine" signal as an
 * API failure) rather than ever letting a possibly-incomplete file list
 * assert "untouched" — the classifier must fail toward ambiguity, never
 * toward an "argued out" accusation.
 */
const GITHUB_COMPARE_FILES_CAP = 300;

/**
 * Fetch the list of files changed between two commits via GitHub's compare
 * API (mt#3300 SC#1).
 *
 * Used to determine whether a prior BLOCKING finding's cited file was
 * touched by any commit since the finding's review round — the diff-mining
 * signal `resolution-classifier.ts`'s `classifyOutstandingFindings` uses to
 * distinguish `fixed-by-code-change` from `resolved-without-code-change`.
 * File-level only (matches the mt#3300 spec's literal "touched the finding's
 * cited file" — no line-range precision).
 *
 * Returns `[]` immediately when `baseSha === headSha` (nothing to compare).
 * Returns `undefined` on any API failure (e.g. the base/head pair is
 * unreachable after a force-push rewrote history), a possibly-truncated
 * response (see `GITHUB_COMPARE_FILES_CAP`), or a range containing a merge
 * commit (see below) — callers must treat this as "cannot determine," never as
 * "no files changed."
 *
 * ## Why a merge commit in range yields "cannot determine" (mt#3663)
 *
 * `baseSha` is a commit on the PR branch, so `base...head` collapses to
 * `base..head` and a merge-from-main commit in that range contributes every
 * file the BASE BRANCH touched, indistinguishably from files this PR's author
 * touched. The caller's question is whether the PR ADDRESSED a finding, and a
 * base-branch edit to the finding's cited file is not an answer to it — so the
 * range stops carrying the signal the caller needs.
 *
 * Filtering the file list against the PR's own file list does NOT rescue this:
 * a merge-from-main routinely touches the very files the PR touches (that is
 * what a conflict resolution IS), so the cited file survives any such filter
 * while the only edit to it came from the base branch. There is no cheap way to
 * recover the PR-authored subset from one compare call, and the classifier's
 * standing rule is to fail toward ambiguity rather than toward an unsupported
 * "argued out" accusation — so this returns `undefined` and the caller records
 * `unknown`.
 *
 * This is deliberately a DIFFERENT remedy from the one `incremental-diff-scope.ts`
 * applies to the same wrong-base compare: that consumer asks "what should the
 * model be shown," which the PR's own merge-base entries answer exactly; this
 * one asks "did the author change this file," which they cannot answer at all.
 */
export async function fetchChangedFilesSince(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS
): Promise<ReadonlyArray<ChangedFileEntry> | undefined> {
  if (baseSha === headSha) return [];

  try {
    const resp = await withTimeout("github.repos.compareCommits", timeoutMs, (signal) =>
      octokit.rest.repos.compareCommits({
        owner,
        repo,
        base: baseSha,
        head: headSha,
        request: { signal },
      })
    );
    const files = resp.data.files ?? [];
    if (files.length >= GITHUB_COMPARE_FILES_CAP) {
      log.warn("reviewer.compare_commits_possibly_truncated", {
        event: "reviewer.compare_commits_possibly_truncated",
        owner,
        repo,
        baseSha,
        headSha,
        fileCount: files.length,
      });
      return undefined;
    }
    const mergeCommits = (resp.data.commits ?? []).filter((c) => (c.parents?.length ?? 0) > 1);
    if (mergeCommits.length > 0) {
      log.info("reviewer.compare_commits_merge_in_range", {
        event: "reviewer.compare_commits_merge_in_range",
        owner,
        repo,
        baseSha,
        headSha,
        mergeCommitCount: mergeCommits.length,
        fileCount: files.length,
      });
      return undefined;
    }
    return files.map((f) => ({ filename: f.filename }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("reviewer.compare_commits_failed", {
      event: "reviewer.compare_commits_failed",
      owner,
      repo,
      baseSha,
      headSha,
      error: message,
    });
    return undefined;
  }
}

/**
 * The diff of the commits a PR gained since a given base SHA, in both the
 * forms the review pipeline consumes (mt#3471).
 */
export interface IncrementalDiffResult {
  /** Raw unified diff, as produced by GitHub's own diff media type. */
  diff: string;
  /** Per-file entries for the same commit range, for chunked-review packing. */
  fileEntries: PrFileEntry[];
}

/**
 * Fetch the diff of the commits added between `baseSha` and `headSha` (mt#3471).
 *
 * Used to give a re-review round (R>=2) only the delta pushed since the last
 * posted review, instead of re-sending the entire PR diff every round. `baseSha`
 * is the prior review's `commit_id` — resolving by SHA rather than by commit
 * date means a rebase that rewrites author/committer dates cannot silently
 * produce a wrong scope: an unreachable base yields a clean 404, which routes
 * to the caller's full-diff fallback.
 *
 * Both forms come from the same `compare` call so they cannot disagree about
 * the commit range: the raw diff (GitHub's `application/vnd.github.diff` media
 * type, so the prompt sees byte-identical formatting to `pr.diff`) and the JSON
 * `files` array (which `runChunkedReview` packs per file).
 *
 * Returns `undefined` — meaning "cannot scope; use the full diff" — when:
 *   - `baseSha` is empty or equals `headSha` (no new commits to review);
 *   - either request fails (force-push made the base unreachable; GitHub 5xx on
 *     a large comparison, which its docs call out explicitly);
 *   - the `files` array hit `GITHUB_COMPARE_FILES_CAP` and may be truncated;
 *   - the comparison resolves but carries no diff text.
 * It never returns a partial or empty scope — narrowing a review to nothing is
 * strictly worse than reviewing the full diff again.
 */
export async function fetchIncrementalDiffSince(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS
): Promise<IncrementalDiffResult | undefined> {
  if (!baseSha || baseSha === headSha) return undefined;

  try {
    const [diffResponse, jsonResponse] = await Promise.all([
      withTimeout("github.repos.compareCommits.diff", timeoutMs, (signal) =>
        octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          owner,
          repo,
          basehead: `${baseSha}...${headSha}`,
          mediaType: { format: "diff" },
          request: { signal },
        })
      ),
      withTimeout("github.repos.compareCommits", timeoutMs, (signal) =>
        octokit.rest.repos.compareCommits({
          owner,
          repo,
          base: baseSha,
          head: headSha,
          request: { signal },
        })
      ),
    ]);

    const files = jsonResponse.data.files ?? [];
    if (files.length >= GITHUB_COMPARE_FILES_CAP) {
      log.warn("reviewer.incremental_diff_possibly_truncated", {
        event: "reviewer.incremental_diff_possibly_truncated",
        owner,
        repo,
        baseSha,
        headSha,
        fileCount: files.length,
      });
      return undefined;
    }

    // mediaType: { format: "diff" } makes Octokit return the body as a raw
    // string at runtime even though the typed response is the comparison object.
    const diff = String(diffResponse.data);
    if (!diff.trim()) return undefined;

    return {
      diff,
      fileEntries: files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
        ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
      })),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("reviewer.incremental_diff_failed", {
      event: "reviewer.incremental_diff_failed",
      owner,
      repo,
      baseSha,
      headSha,
      error: message,
    });
    return undefined;
  }
}

/**
 * Normalize a user-supplied path for the GitHub Contents API.
 *
 * The GitHub API expects an empty string for the repository root. Callers
 * (and the tool prompt) sometimes pass ".", "./", or "/" instead. Also strip
 * a leading "./" prefix so "./src/foo" and "src/foo" behave identically.
 *
 * Exported for tests.
 */
export function normalizeContentPath(path: string): string {
  if (path === "." || path === "./" || path === "/" || path === "") return "";
  // Strip a leading "./" prefix so "./src/foo" and "src/foo" behave identically.
  if (path.startsWith("./")) path = path.slice(2);
  // Strip ALL leading slashes (LLMs commonly supply absolute-like paths like
  // "/src/foo.ts" — the Contents API expects relative, and a leading slash
  // produces a 404).
  while (path.startsWith("/")) path = path.slice(1);
  // Strip ALL trailing slashes (getContent treats dir paths the same
  // with/without; multiple trailing slashes like "src/foo//" must also
  // normalize).
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

/**
 * Entry types reported by the GitHub Contents API.
 *
 * Beyond `file` and `dir`, the API also surfaces `symlink` (a git symbolic
 * link entry) and `submodule` (a git submodule). Earlier revisions silently
 * filtered the latter two; mt#1216 surfaces them so the reviewer can see
 * symlinked configs and submodule references when verifying repo structure.
 */
export type DirEntryType = "file" | "dir" | "symlink" | "submodule";

export interface DirEntry {
  name: string;
  type: DirEntryType;
}

/**
 * Structured result from `readFileAtRef`.
 *
 * Truncation rides as a boolean flag rather than a string prefix on the
 * content (mt#1216 — the prefix broke downstream parsing when the truncated
 * file itself was JSON or another structured format). Binary files return a
 * placeholder kind so the model doesn't burn context on raw UTF-8 garbage.
 */
export type ReadFileResult =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "binary"; size: number; truncated: boolean };

/**
 * Heuristic binary detection: scan the first `sampleBytes` of the buffer for
 * null bytes. Files with a NUL in their first ~8KB are treated as binary —
 * the same heuristic file(1) and most tooling use. Decoding such a file as
 * UTF-8 produces lossy garbage that wastes the model's context budget.
 */
function isBinaryBuffer(buf: Buffer, sampleBytes = 8192): boolean {
  const limit = Math.min(buf.length, sampleBytes);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Extract a numeric HTTP status from an Octokit RequestError-shaped value.
 * Returns undefined when err is not a status-bearing object.
 */
function getErrorStatus(err: unknown): number | undefined {
  if (err instanceof Error && "status" in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * Read the content of a file at a specific git ref.
 *
 * Returns a discriminated union:
 *   - `{ kind: "text", content, truncated }` for text files (truncated=true
 *     when GitHub's Contents API returned a partial snippet for a >~1MB file)
 *   - `{ kind: "binary", size }` for files whose decoded content contains
 *     null bytes in the first 8KB (common heuristic)
 *   - `null` when the file does not exist (404)
 *
 * Throws on unexpected errors (permissions, malformed response, etc.).
 */
export async function readFileAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  // mt#1086: per-call timeout. Optional + defaulted (see fetchListFiles).
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS,
  // mt#1086 PR #969 R2 BLOCKING #2: optional caller-provided AbortSignal.
  // When the OpenAI tool loop wraps the tool call in its own withTimeout,
  // it passes that signal through here so abort actually cancels the
  // Octokit request rather than leaving it running in the background.
  // Combined with the internal withTimeout's signal via AbortSignal.any
  // — whichever fires first wins.
  callerSignal?: AbortSignal
): Promise<ReadFileResult | null> {
  const normalizedPath = normalizeContentPath(path);
  try {
    const response = await withTimeout("github.repos.getContent.file", timeoutMs, (innerSignal) => {
      const signal =
        callerSignal !== undefined ? AbortSignal.any([innerSignal, callerSignal]) : innerSignal;
      return octokit.rest.repos.getContent({
        owner,
        repo,
        path: normalizedPath,
        ref,
        request: { signal },
      });
    });
    const data = response.data;
    // getContent returns an array for directories; a single object for files.
    if (Array.isArray(data)) {
      throw new Error(`Path "${path}" is a directory, not a file`);
    }
    if (data.type !== "file") {
      throw new Error(`Path "${path}" is not a file (type=${data.type})`);
    }
    // Content is base64-encoded by the GitHub API.
    if (!("content" in data) || typeof data.content !== "string") {
      throw new Error(`Unexpected response shape for "${path}": no content field`);
    }
    const buf = Buffer.from(data.content, "base64");
    // GitHub's Contents API reports truncation on files above ~1MB; when set,
    // `content` is only a partial snippet and `data.size` is still the full
    // repository-stored size. Preserve both facts on the result so callers
    // (envelope, prompt, model) can disambiguate snippet-vs-file boundaries.
    const truncated = "truncated" in data && (data as { truncated?: boolean }).truncated === true;
    const apiSize =
      typeof (data as { size?: unknown }).size === "number"
        ? (data as { size: number }).size
        : buf.length;
    if (isBinaryBuffer(buf)) {
      return { kind: "binary", size: apiSize, truncated };
    }
    return { kind: "text", content: buf.toString("utf-8"), truncated };
  } catch (err: unknown) {
    if (getErrorStatus(err) === 404) {
      return null;
    }
    throw err;
  }
}

/** Result of {@link listPathsAtRef}. */
export interface ListPathsResult {
  /** Every blob path in the tree, repo-root-relative. */
  paths: string[];
  /**
   * GitHub sets this when the tree exceeded its response limits, in which case `paths` is a
   * PARTIAL listing. A caller asking "does this file exist?" must treat a miss against a
   * truncated listing as unknown, never as absence.
   */
  truncated: boolean;
}

/**
 * List every blob path in the repository at `ref`, in one recursive tree call (mt#4042).
 *
 * `readFileAtRef` above answers "what is at this path?" — it cannot answer "where is this file?",
 * which is what an absence claim naming a bare filename requires. Measured on this repo at
 * 4,959 entries the tree comes back whole (`truncated: false`); the flag is surfaced rather than
 * dropped because that is a property of repo size, not a constant.
 */
export async function listPathsAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS,
  callerSignal?: AbortSignal
): Promise<ListPathsResult | null> {
  try {
    const response = await withTimeout("github.git.getTree.recursive", timeoutMs, (innerSignal) => {
      const signal =
        callerSignal !== undefined ? AbortSignal.any([innerSignal, callerSignal]) : innerSignal;
      return octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: ref,
        recursive: "1",
        request: { signal },
      });
    });
    const tree = response.data.tree ?? [];
    return {
      paths: tree
        .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
        .map((entry) => entry.path as string),
      truncated: response.data.truncated === true,
    };
  } catch (err: unknown) {
    if (getErrorStatus(err) === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * List the immediate children (files and directories) of a directory at a
 * specific git ref.
 *
 * Returns null if the path does not exist (404). Throws on unexpected errors.
 * Accepts ".", "./", "/" or "" for the repository root (normalized internally).
 *
 * Includes `symlink` and `submodule` entries with their real type so the
 * reviewer can see them when verifying repo structure (mt#1216).
 */
export async function listDirectoryAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  // mt#1086: per-call timeout. Optional + defaulted (see fetchListFiles).
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS,
  // mt#1086 PR #969 R2 BLOCKING #2: optional caller-provided AbortSignal.
  // See readFileAtRef above for rationale.
  callerSignal?: AbortSignal
): Promise<DirEntry[] | null> {
  const normalizedPath = normalizeContentPath(path);
  try {
    const response = await withTimeout("github.repos.getContent.dir", timeoutMs, (innerSignal) => {
      const signal =
        callerSignal !== undefined ? AbortSignal.any([innerSignal, callerSignal]) : innerSignal;
      return octokit.rest.repos.getContent({
        owner,
        repo,
        path: normalizedPath,
        ref,
        request: { signal },
      });
    });
    const data = response.data;
    if (!Array.isArray(data)) {
      throw new Error(`Path "${path}" is not a directory`);
    }
    return data
      .filter(
        (entry): entry is typeof entry & { type: DirEntryType } =>
          entry.type === "file" ||
          entry.type === "dir" ||
          entry.type === "symlink" ||
          entry.type === "submodule"
      )
      .map((entry) => ({ name: entry.name, type: entry.type }));
  } catch (err: unknown) {
    if (getErrorStatus(err) === 404) {
      return null;
    }
    throw err;
  }
}

// ── Review threads (mt#1345) ─────────────────────────────────────────────────

/**
 * A single comment within a review thread, as surfaced in the reviewer prompt.
 */
export interface ReviewThreadComment {
  /** GitHub database ID of the comment (numeric). Used for in_reply_to wiring. */
  databaseId: number;
  /** GitHub login of the comment author, or null for deleted accounts. */
  author: string | null;
  /** Comment body text. */
  body: string;
  /** ISO-8601 timestamp of comment creation. */
  createdAt: string;
}

/**
 * A review thread (inline diff discussion) on a pull request.
 * Shape matches the GraphQL `reviewThreads.nodes` projection.
 */
export interface ReviewThread {
  /** GraphQL node ID of the thread — used for the resolveReviewThread mutation. */
  id: string;
  /** File path the thread is anchored to. */
  path: string;
  /**
   * Line number the thread ends on (1-based). Null when the thread is
   * outdated (the anchored line was removed from the diff).
   */
  line: number | null;
  /** First line of a multi-line range (1-based). Undefined for single-line. */
  startLine?: number;
  /** Whether the thread has been marked resolved. */
  isResolved: boolean;
  /** Whether the thread is outdated (anchored line no longer in the diff). */
  isOutdated: boolean;
  /** Whether the thread is collapsed in the GitHub UI. */
  isCollapsed: boolean;
  /** Ordered list of comments in the thread (oldest first, up to 10). */
  comments: ReviewThreadComment[];
  /** True when the thread has more than 10 comments (only first 10 are present). */
  truncatedComments: boolean;
}

// ── GraphQL types ─────────────────────────────────────────────────────────────

interface GqlThreadComment {
  databaseId: number;
  author: { login: string } | null;
  body: string;
  createdAt: string;
}

interface GqlThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  comments: {
    totalCount: number;
    nodes: GqlThreadComment[];
  };
}

interface GqlPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GqlReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: GqlThread[];
        pageInfo: GqlPageInfo;
      };
    } | null;
  } | null;
}

const REVIEW_THREADS_QUERY = `
  query GetReviewerThreads($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviewThreads(first: 50, after: $after) {
          nodes {
            id
            path
            line
            startLine
            isResolved
            isOutdated
            isCollapsed
            comments(first: 10) {
              totalCount
              nodes {
                databaseId
                author { login }
                body
                createdAt
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = `
  mutation ResolveReviewerThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

/** Hard cap on threads fetched per PR to avoid runaway pagination. */
const MAX_REVIEW_THREADS = 200;

/**
 * Fetch all review threads for a pull request.
 *
 * Paginates through `pullRequest.reviewThreads` (50 per page) and caps at
 * MAX_REVIEW_THREADS (200). Returns an empty array on any network/auth/GraphQL
 * error — thread context is non-fatal and degrades gracefully.
 *
 * @param octokit  Authenticated Octokit instance.
 * @param owner    Repository owner.
 * @param repo     Repository name.
 * @param prNumber Pull request number.
 * @param signal   Optional AbortSignal for request cancellation.
 */
export async function fetchReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  signal?: AbortSignal
): Promise<ReviewThread[]> {
  const allThreads: ReviewThread[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    let response: GqlReviewThreadsResponse;
    try {
      response = await octokit.graphql<GqlReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
        owner,
        repo,
        prNumber,
        after: cursor,
        request: { signal },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.info("reviewer_fetch_threads_error", {
        event: "reviewer_fetch_threads_error",
        owner,
        repo,
        pr: prNumber,
        error: message,
      });
      return allThreads;
    }

    const pr = response?.repository?.pullRequest;
    if (pr === null || pr === undefined) {
      return allThreads;
    }

    const { nodes, pageInfo } = pr.reviewThreads;

    for (const node of nodes) {
      if (allThreads.length >= MAX_REVIEW_THREADS) {
        log.info("reviewer_threads_cap_exceeded", {
          event: "reviewer_threads_cap_exceeded",
          owner,
          repo,
          pr: prNumber,
          cap: MAX_REVIEW_THREADS,
        });
        return allThreads;
      }

      const comments: ReviewThreadComment[] = node.comments.nodes.map((c) => ({
        databaseId: c.databaseId,
        author: c.author?.login ?? null,
        body: c.body,
        createdAt: c.createdAt,
      }));

      allThreads.push({
        id: node.id,
        path: node.path,
        line: node.line,
        ...(node.startLine !== null ? { startLine: node.startLine } : {}),
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        isCollapsed: node.isCollapsed,
        comments,
        truncatedComments: node.comments.totalCount > node.comments.nodes.length,
      });
    }

    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return allThreads;
}

/**
 * Resolve a review thread via the GraphQL `resolveReviewThread` mutation.
 *
 * Throws if the mutation fails (the caller should decide whether to surface
 * the error or swallow it).
 *
 * @param octokit  Authenticated Octokit instance.
 * @param threadId GraphQL node ID of the thread to resolve.
 * @param signal   Optional AbortSignal for request cancellation.
 */
export async function resolveThread(
  octokit: Octokit,
  threadId: string,
  signal?: AbortSignal
): Promise<void> {
  await octokit.graphql(RESOLVE_THREAD_MUTATION, {
    threadId,
    request: { signal },
  });
}

/**
 * Dismiss a pull-request review via the `pulls.dismissReview` REST endpoint.
 *
 * Used by the `/resolve` command (mt#2173) to clear stale CHANGES_REQUESTED
 * reviews so they no longer block the merge gate. The dismissal message is
 * shown in the GitHub UI alongside the dismissed review.
 */
export async function dismissReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
  message: string,
  timeoutMs: number = DEFAULT_GITHUB_TIMEOUT_MS
): Promise<void> {
  await withTimeout("github.pulls.dismissReview", timeoutMs, (signal) =>
    octokit.rest.pulls.dismissReview({
      owner,
      repo,
      pull_number: prNumber,
      review_id: reviewId,
      message,
      request: { signal },
    })
  );
}

/**
 * Return the reviewer App's bot identity (login name) via the /app endpoint.
 *
 * This must use App-level JWT auth, not installation token auth. `/user`
 * endpoints like `octokit.rest.users.getAuthenticated` require user-scoped
 * tokens (PAT or OAuth) and return 403 "Resource not accessible by
 * integration" when called with an installation token.
 *
 * The App's `slug` maps to the bot login as `${slug}[bot]`. Cached after
 * the first call since the App identity is stable across the service's
 * lifetime.
 */
let cachedAppIdentity: { login: string } | null = null;

/**
 * Construct the App-JWT-authed Octokit used to read the reviewer App's own
 * identity (`GET /app`).
 *
 * mt#2717: installs `createAppAuth` as the `authStrategy` so the App-level JWT
 * is minted and refreshed per request, rather than extracting a static JWT
 * string (`new Octokit({ auth: token })`) — the same static-token anti-pattern
 * the sweepers' `createOctokit` hit. Only `appId`/`privateKey` are needed for
 * the App-level `/app` route (no `installationId`); `@octokit/auth-app` supplies
 * a JWT automatically for App-level endpoints. Exported for tests.
 */
export function createAppIdentityOctokit(config: ReviewerConfig): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
    },
  });
}

/** TEST-ONLY: reset the cached App identity so a test can re-exercise the fetch. */
export function _resetAppIdentityCacheForTests(): void {
  cachedAppIdentity = null;
}

export async function getAppIdentity(config: ReviewerConfig): Promise<{ login: string }> {
  if (cachedAppIdentity) return cachedAppIdentity;

  // mt#2717: authStrategy-based client (see createAppIdentityOctokit) so the
  // App JWT mints/refreshes per request. `apps.getAuthenticated` (GET /app) is
  // an App-level route, so @octokit/auth-app supplies a fresh JWT automatically.
  const appOctokit = createAppIdentityOctokit(config);
  const response = await appOctokit.rest.apps.getAuthenticated();
  if (!response.data) {
    throw new Error(
      "apps.getAuthenticated returned no data; check App credentials and JWT generation."
    );
  }
  cachedAppIdentity = { login: `${response.data.slug}[bot]` };
  return cachedAppIdentity;
}
