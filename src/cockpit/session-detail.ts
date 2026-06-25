/**
 * Session detail assembly for `GET /api/agents/:id` (mt#1919).
 *
 * Pure helpers for the workspace-session drill-down endpoint: payload types,
 * GitHub web-URL derivation, `git log` output parsing, and SessionRecord →
 * payload mapping. The Express route in server.ts composes these with the
 * session provider, a bounded `git log` subprocess, and the transcript
 * cwd-resolution query.
 *
 * Two session id-spaces (mt#2398/mt#2420 — do not conflate): this endpoint is
 * keyed by the MINSKY workspace sessionId (`SessionRecord.sessionId`). The
 * conversation link it returns carries the harness agentSessionId
 * (`agent_transcripts.agent_session_id`), resolved by matching the session's
 * workspace directory against transcript cwd. `minsky_session_links` is the
 * eventual structural home for that join; it has no writers yet, so v0
 * resolves at read time.
 */
import type { SessionRecord, SessionLiveness } from "@minsky/domain/session/types";
import { deriveSessionLiveness } from "@minsky/domain/session/types";
import { formatTaskIdForDisplay } from "@minsky/domain/tasks/task-id-utils";

// ---------------------------------------------------------------------------
// Payload types — mirrored by the SessionDetail web widget
// ---------------------------------------------------------------------------

export interface SessionCommitRef {
  hash: string;
  shortHash: string;
  /** ISO committer date, null when unparseable. */
  date: string | null;
  subject: string;
  /** GitHub commit URL; null when the repo URL is not a recognized GitHub remote. */
  url: string | null;
}

export interface SessionPrRef {
  number: number | null;
  url: string | null;
  /** "open" | "closed" | "merged" | "draft" | "unknown" */
  state: string;
  title: string | null;
  headBranch: string | null;
  approved: boolean | null;
}

export interface SessionDetailMeta {
  sessionId: string;
  taskId: string | null;
  taskTitle: string | null;
  status: string | null;
  liveness: SessionLiveness;
  agentId: string | null;
  branch: string | null;
  repoName: string | null;
  repoUrl: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  lastCommitHash: string | null;
  lastCommitMessage: string | null;
  commitCount: number | null;
}

export interface SessionDetailPayload {
  session: SessionDetailMeta;
  /** Most-recent-first. Empty when the workspace is gone or git log failed. */
  commits: SessionCommitRef[];
  pr: SessionPrRef | null;
  /** Resolved harness transcript for this workspace, when one exists. */
  conversation: { agentSessionId: string } | null;
}

// ---------------------------------------------------------------------------
// GitHub web-URL derivation
// ---------------------------------------------------------------------------

/**
 * Derive the https web base ("https://github.com/<owner>/<repo>") from a
 * remote URL. Handles https and ssh forms, with or without ".git". Returns
 * null for non-GitHub or unrecognized remotes — callers degrade to plain
 * (non-linked) commit rendering.
 */
export function githubRepoWebBase(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const https = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https?.[1] && https[2]) return `https://github.com/${https[1]}/${https[2]}`;
  const ssh = repoUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh?.[1] && ssh[2]) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  return null;
}

// ---------------------------------------------------------------------------
// git log parsing
// ---------------------------------------------------------------------------

/** Format string passed to git: hash TAB committer-date-ISO TAB subject. */
export const GIT_LOG_FORMAT = "%H%x09%cI%x09%s";

/**
 * Parse `git log --format=%H%x09%cI%x09%s` output into commit refs.
 * Malformed lines are skipped rather than failing the whole parse.
 */
export function parseGitLog(stdout: string, repoWebBase: string | null): SessionCommitRef[] {
  const refs: SessionCommitRef[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [hash, date, ...subjectParts] = line.split("\t");
    if (!hash || !/^[0-9a-f]{7,40}$/i.test(hash)) continue;
    refs.push({
      hash,
      shortHash: hash.slice(0, 7),
      date: date && !Number.isNaN(Date.parse(date)) ? date : null,
      subject: subjectParts.join("\t") || "(no subject)",
      url: repoWebBase ? `${repoWebBase}/commit/${hash}` : null,
    });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Record → payload mapping
// ---------------------------------------------------------------------------

export function buildSessionMeta(
  record: SessionRecord,
  taskTitle: string | null
): SessionDetailMeta {
  return {
    sessionId: record.sessionId,
    taskId: record.taskId ? formatTaskIdForDisplay(record.taskId) : null,
    taskTitle,
    status: record.status ?? null,
    liveness: deriveSessionLiveness(record),
    agentId: record.agentId ?? null,
    branch: record.branch ?? null,
    repoName: record.repoName ?? null,
    repoUrl: record.repoUrl ?? null,
    createdAt: record.createdAt ?? null,
    lastActivityAt: record.lastActivityAt ?? null,
    lastCommitHash: record.lastCommitHash ?? null,
    lastCommitMessage: record.lastCommitMessage ?? null,
    commitCount: record.commitCount ?? null,
  };
}

/**
 * Build the PR block. Precedence: the rich `pullRequest` info when present
 * (number/url/state and any live-fetched title), falling back to the minimal
 * `prState` branch record, else null (no PR).
 */
export function buildPrRef(record: SessionRecord): SessionPrRef | null {
  const pr = record.pullRequest;
  if (pr) {
    return {
      number: pr.number ?? null,
      url: pr.url ?? null,
      state: pr.state ?? "unknown",
      title: pr.title ?? null,
      headBranch: pr.headBranch ?? null,
      approved: record.prApproved ?? null,
    };
  }
  if (record.prState?.exists) {
    return {
      number: null,
      url: null,
      state: record.prState.mergedAt ? "merged" : "unknown",
      title: null,
      headBranch: record.prState.branchName ?? null,
      approved: record.prApproved ?? null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Changeset recency ordering (mt#1920 R1)
// ---------------------------------------------------------------------------

/** Minimal recency-bearing shape — the fields the recency proxy reads. */
export type ChangesetRecencyFields = Pick<SessionDetailMeta, "lastActivityAt" | "createdAt">;

/**
 * Recency proxy (epoch ms) for ordering changesets newest-first (mt#1920 R1).
 *
 * The session-record path that feeds `GET /api/changesets` does NOT carry
 * PR-specific timestamps (PR opened / last-pushed / updated). Those arrive with
 * the richer changeset consumption tracked in mt#2076 / mt#2435. Until then the
 * session's `lastActivityAt` is the best available proxy for PR recency — it
 * advances on every commit/push to the session branch, which is exactly what
 * drives PR activity. Falls back to `createdAt` when `lastActivityAt` is null
 * (a session with no recorded activity since creation), and to 0 when neither
 * is present or parseable (such rows sort last).
 *
 * NOTE: the `ChangesetRow` "age" column mirrors this field selection
 * (`lastActivityAt ?? createdAt`) so the displayed age matches the sort key —
 * keep the two in sync.
 */
export function changesetRecencyTimestamp(session: ChangesetRecencyFields): number {
  const raw = session.lastActivityAt ?? session.createdAt;
  if (!raw) return 0;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Newest-first comparator for changesets, keyed by {@link changesetRecencyTimestamp}.
 * Pure + side-effect-free so it can be unit-tested directly (mt#1920 R1). Accepts
 * any `{ session }` carrier (the endpoint's `{ pr, session }` item structurally
 * satisfies it).
 */
export function compareChangesetsByRecency(
  a: { session: ChangesetRecencyFields },
  b: { session: ChangesetRecencyFields }
): number {
  return changesetRecencyTimestamp(b.session) - changesetRecencyTimestamp(a.session);
}
