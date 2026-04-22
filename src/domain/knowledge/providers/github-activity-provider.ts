/**
 * GitHub Activity Knowledge Provider
 *
 * Implements KnowledgeSourceProvider for GitHub Issues and Pull Requests,
 * indexing issue bodies, comments, PR descriptions, and review comments as
 * searchable knowledge documents.
 *
 * This provider is architecturally distinct from the github-issues task backend
 * (src/domain/tasks/githubIssuesTaskBackend.ts). Both read GitHub Issues, but:
 * - The task backend reads issues as structured task metadata (lifecycle, state, assignees).
 * - This provider reads issues/PRs as searchable knowledge (engineering decisions, rationale).
 * The KB copy is NOT authoritative for task state.
 */

import type { KnowledgeDocument, KnowledgeSourceProvider, ListOptions } from "../types";
import { IntelligentRetryService } from "../../ai/intelligent-retry-service";
import { isRetryableGitHubError } from "../../ai/embedding-service-openai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Octokit-compatible issue/PR shape (minimal subset we use) */
interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name?: string }>;
  user: { login: string } | null;
  pull_request?: { url?: string };
}

interface GitHubComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

interface GitHubPRReviewComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

/** Per-source configuration for GitHub activity ingestion */
export interface GitHubActivitySourceConfig {
  /** GitHub repository owner (org or user) */
  owner: string;
  /** GitHub repository name */
  repo: string;
  /** Issue/PR states to include (default: "open") */
  states?: "open" | "closed" | "all";
  /** Only include issues/PRs with all of these labels */
  labels?: string[];
  /** Exclude issues/PRs that have any of these labels */
  excludeLabels?: string[];
  /** Additional authors to exclude (merged with default bot list) */
  excludeAuthors?: string[];
  /**
   * Only include items updated within this many days.
   * Default: no age limit.
   */
  maxAgeDays?: number;
}

/** Fetch function type for dependency injection in tests */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Default bot filter
// ---------------------------------------------------------------------------

const DEFAULT_BOT_AUTHORS = [
  "github-actions[bot]",
  "dependabot[bot]",
  "dependabot-preview[bot]",
  "renovate[bot]",
  "renovate-bot",
  "greenkeeper[bot]",
  "imgbot[bot]",
  "allcontributors[bot]",
];

function isDefaultBot(login: string): boolean {
  return DEFAULT_BOT_AUTHORS.includes(login);
}

// ---------------------------------------------------------------------------
// GitHubActivityProvider
// ---------------------------------------------------------------------------

export class GitHubActivityProvider implements KnowledgeSourceProvider {
  readonly sourceType = "github-activity";
  readonly sourceName: string;

  private readonly owner: string;
  private readonly repo: string;
  private readonly states: "open" | "closed" | "all";
  private readonly labels: string[];
  private readonly excludeLabels: Set<string>;
  private readonly excludeAuthors: Set<string>;
  private readonly maxAgeDays: number | undefined;
  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private readonly retryService: IntelligentRetryService;

  constructor(
    token: string,
    sourceName: string,
    sourceConfig: GitHubActivitySourceConfig,
    options?: {
      fetch?: FetchFn;
      retryService?: IntelligentRetryService;
    }
  ) {
    this.token = token;
    this.sourceName = sourceName;
    this.owner = sourceConfig.owner;
    this.repo = sourceConfig.repo;
    this.states = sourceConfig.states ?? "open";
    this.labels = sourceConfig.labels ?? [];
    this.excludeLabels = new Set(sourceConfig.excludeLabels ?? []);
    const extraExcludeAuthors = sourceConfig.excludeAuthors ?? [];
    this.excludeAuthors = new Set([...DEFAULT_BOT_AUTHORS, ...extraExcludeAuthors]);
    this.maxAgeDays = sourceConfig.maxAgeDays;
    this.fetchFn = options?.fetch ?? globalThis.fetch.bind(globalThis);
    this.retryService =
      options?.retryService ?? new IntelligentRetryService({ maxRetries: 3, baseDelay: 500 });
  }

  // -------------------------------------------------------------------------
  // KnowledgeSourceProvider implementation
  // -------------------------------------------------------------------------

  async *listDocuments(_options?: ListOptions): AsyncIterable<KnowledgeDocument> {
    const cutoff = this.maxAgeDays
      ? new Date(Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000)
      : undefined;

    // Fetch issues (GitHub's Issues API returns both issues and PRs when pull_request is present)
    for await (const issue of this.fetchAllIssues()) {
      if (cutoff && new Date(issue.updated_at) < cutoff) continue;
      if (!this.passesLabelFilters(issue)) continue;

      const doc = await this.buildDocument(issue);
      if (doc) yield doc;
    }
  }

  async fetchDocument(id: string): Promise<KnowledgeDocument> {
    // id format: "{owner}/{repo}#{number}"
    const match = /^(.+)\/(.+)#(\d+)$/.exec(id);
    if (!match) {
      throw new Error(
        `Invalid GitHub activity document ID: "${id}". Expected format: "owner/repo#number"`
      );
    }
    const owner = match[1];
    const repo = match[2];
    const numStr = match[3];
    if (!owner || !repo || !numStr) {
      throw new Error(
        `Invalid GitHub activity document ID: "${id}". Expected format: "owner/repo#number"`
      );
    }
    const number = parseInt(numStr, 10);

    const issue = await this.getIssue(owner, repo, number);
    const doc = await this.buildDocument(issue);
    if (!doc) {
      throw new Error(`GitHub issue ${id} was filtered out (author excluded or label filtered).`);
    }
    return doc;
  }

  async *getChangedSince(since: Date, options?: ListOptions): AsyncIterable<KnowledgeDocument> {
    // GitHub's `since` parameter on issues API filters by updated_at
    for await (const issue of this.fetchAllIssues(since)) {
      if (!this.passesLabelFilters(issue)) continue;
      const doc = await this.buildDocument(issue);
      if (doc) yield doc;
    }
    void options; // unused
  }

  // -------------------------------------------------------------------------
  // Internal document construction
  // -------------------------------------------------------------------------

  private async buildDocument(issue: GitHubIssue): Promise<KnowledgeDocument | null> {
    const isPR = Boolean(issue.pull_request);
    const itemType = isPR ? "PR" : "Issue";

    // Collect content segments: body + all comments + (for PRs) review comments
    const segments: string[] = [];

    // --- body ---
    const bodyAuthor = issue.user?.login ?? "unknown";
    const bodyIsBot = this.excludeAuthors.has(bodyAuthor);
    if (!bodyIsBot && issue.body?.trim()) {
      segments.push(`**${itemType} body** (by @${bodyAuthor}):\n\n${issue.body.trim()}`);
    }

    // --- issue/PR comments ---
    const comments = await this.fetchAllComments(issue.number);
    for (const comment of comments) {
      const login = comment.user?.login ?? "unknown";
      if (this.excludeAuthors.has(login)) continue;
      if (!comment.body?.trim()) continue;
      segments.push(
        `**Comment** (by @${login}, ${comment.created_at.slice(0, 10)}):\n\n${comment.body.trim()}`
      );
    }

    // --- PR review comments ---
    if (isPR) {
      const reviewComments = await this.fetchAllReviewComments(issue.number);
      for (const rc of reviewComments) {
        const login = rc.user?.login ?? "unknown";
        if (this.excludeAuthors.has(login)) continue;
        if (!rc.body?.trim()) continue;
        segments.push(
          `**Review comment** (by @${login}, ${rc.created_at.slice(0, 10)}):\n\n${rc.body.trim()}`
        );
      }
    }

    if (segments.length === 0) {
      // Nothing non-bot to index
      return null;
    }

    const content = segments.join("\n\n---\n\n");
    const labelNames = issue.labels.map((l) => l.name ?? "").filter(Boolean);

    // lastModified: max of issue.updated_at and all comment updated_at
    const allDates = [new Date(issue.updated_at), ...comments.map((c) => new Date(c.updated_at))];
    const lastModified = allDates.reduce((a, b) => (a > b ? a : b));

    return {
      id: `${this.owner}/${this.repo}#${issue.number}`,
      title: `${this.owner}/${this.repo} #${issue.number}: ${issue.title}`,
      content,
      url: issue.html_url,
      lastModified,
      metadata: {
        sourceType: "github-activity",
        sourceName: this.sourceName,
        owner: this.owner,
        repo: this.repo,
        number: issue.number,
        isPR,
        state: issue.state,
        labels: labelNames,
        author: issue.user?.login ?? "unknown",
        createdAt: issue.created_at,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Label filtering
  // -------------------------------------------------------------------------

  private passesLabelFilters(issue: GitHubIssue): boolean {
    const issueLabels = new Set(issue.labels.map((l) => l.name ?? "").filter(Boolean));

    // Exclude if any excludeLabel present
    for (const el of this.excludeLabels) {
      if (issueLabels.has(el)) return false;
    }

    // Require all include labels to be present
    if (this.labels.length > 0) {
      for (const required of this.labels) {
        if (!issueLabels.has(required)) return false;
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // GitHub API helpers
  // -------------------------------------------------------------------------

  private async *fetchAllIssues(since?: Date): AsyncIterable<GitHubIssue> {
    let page = 1;
    const perPage = 100;

    while (true) {
      const params = new URLSearchParams({
        state: this.states,
        per_page: String(perPage),
        page: String(page),
        sort: "updated",
        direction: "desc",
      });

      if (this.labels.length > 0) {
        params.set("labels", this.labels.join(","));
      }

      if (since) {
        params.set("since", since.toISOString());
      }

      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues?${params.toString()}`;
      const issues = await this.apiGet<GitHubIssue[]>(url);

      if (issues.length === 0) break;

      for (const issue of issues) {
        yield issue;
      }

      if (issues.length < perPage) break;
      page++;
    }
  }

  private async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    return this.apiGet<GitHubIssue>(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}`
    );
  }

  private async fetchAllComments(issueNumber: number): Promise<GitHubComment[]> {
    const all: GitHubComment[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments?${params.toString()}`;
      const comments = await this.apiGet<GitHubComment[]>(url);

      all.push(...comments);
      if (comments.length < perPage) break;
      page++;
    }

    return all;
  }

  private async fetchAllReviewComments(prNumber: number): Promise<GitHubPRReviewComment[]> {
    const all: GitHubPRReviewComment[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/pulls/${prNumber}/comments?${params.toString()}`;
      const comments = await this.apiGet<GitHubPRReviewComment[]>(url);

      all.push(...comments);
      if (comments.length < perPage) break;
      page++;
    }

    return all;
  }

  private async apiGet<T>(url: string): Promise<T> {
    return this.retryService.execute(
      async () => {
        const resp = await this.fetchFn(url, {
          method: "GET",
          headers: this.buildHeaders(),
        });
        return this.handleResponse<T>(resp, url);
      },
      isRetryableGitHubError,
      "github"
    );
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private async handleResponse<T>(resp: Response, url: string): Promise<T> {
    if (!resp.ok) {
      let extra = "";
      try {
        const json = (await resp.json()) as { message?: string };
        if (json.message) extra = ` — ${json.message}`;
      } catch {
        extra = await resp.text().catch(() => "");
      }
      throw new Error(`GitHub API error: ${resp.status} ${resp.statusText}${extra} [${url}]`);
    }
    return resp.json() as Promise<T>;
  }
}

// ---------------------------------------------------------------------------
// Re-exports for test access
// ---------------------------------------------------------------------------
export { isDefaultBot };
export { isRetryableGitHubError } from "../../ai/embedding-service-openai";
