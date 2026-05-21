import { describe, it, expect } from "bun:test";
import {
  GitHubActivityProvider,
  type FetchFn,
  type GitHubActivitySourceConfig,
} from "./github-activity-provider";
import { IntelligentRetryService } from "../../ai/intelligent-retry-service";

// ---------------------------------------------------------------------------
// Fake GitHub API helpers
// ---------------------------------------------------------------------------

interface FakeIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  user: { login: string } | null;
  pull_request?: { url: string };
}

interface FakeComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

const ISO_2026 = "2026-03-01T00:00:00Z";

function makeIssue(n: number, overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number: n,
    title: `Issue #${n}`,
    body: `Body of issue #${n}`,
    html_url: `https://github.com/acme/widget/issues/${n}`,
    state: "open",
    created_at: ISO_2026,
    updated_at: ISO_2026,
    labels: [],
    user: { login: "alice" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
    headers: new Headers(),
  } as unknown as Response;
}

interface Capture {
  url: string;
  method?: string;
}

function makeFetch(handler: (url: string) => Response | Promise<Response>): {
  fetch: FetchFn;
  calls: Capture[];
} {
  const calls: Capture[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method });
    return handler(url);
  };
  return { fetch: fetchFn, calls };
}

function makeProvider(
  fetch: FetchFn,
  sourceConfig: GitHubActivitySourceConfig
): GitHubActivityProvider {
  return new GitHubActivityProvider("ghp_test_token", "test-source", sourceConfig, {
    fetch,
    retryService: new IntelligentRetryService({ maxRetries: 2, baseDelay: 1 }),
  });
}

// ---------------------------------------------------------------------------
// Core tests
// ---------------------------------------------------------------------------

describe("GitHubActivityProvider — listDocuments", () => {
  it("yields documents for issues with body + comments, including attribution headers", async () => {
    const { fetch } = makeFetch(async (url) => {
      if (url.includes("/issues?")) {
        return jsonResponse([makeIssue(1)]);
      }
      if (url.includes("/issues/1/comments?")) {
        return jsonResponse([
          {
            id: 100,
            body: "LGTM",
            user: { login: "bob" },
            created_at: ISO_2026,
            updated_at: ISO_2026,
          } as FakeComment,
        ]);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider(fetch, { owner: "acme", repo: "widget" });

    const docs: Array<{ id: string; content: string }> = [];
    for await (const d of provider.listDocuments()) {
      docs.push({ id: d.id, content: d.content });
    }

    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe("acme/widget#1");
    expect(docs[0]?.content).toContain("by @alice");
    expect(docs[0]?.content).toContain("Body of issue #1");
    expect(docs[0]?.content).toContain("by @bob");
    expect(docs[0]?.content).toContain("LGTM");
  });

  it("excludes default bot authors (body skipped, comments skipped)", async () => {
    const { fetch } = makeFetch(async (url) => {
      if (url.includes("/issues?")) {
        return jsonResponse([
          makeIssue(1, { user: { login: "dependabot[bot]" }, body: "Bump foo from 1 to 2" }),
        ]);
      }
      if (url.includes("/comments?")) {
        return jsonResponse([
          {
            id: 1,
            body: "auto comment",
            user: { login: "github-actions[bot]" },
            created_at: ISO_2026,
            updated_at: ISO_2026,
          },
        ]);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider(fetch, { owner: "acme", repo: "widget" });

    const docs: string[] = [];
    for await (const d of provider.listDocuments()) docs.push(d.id);

    // With only bot content and no human body/comments, the doc is null and skipped.
    expect(docs).toHaveLength(0);
  });

  it("excludes issues with any excludeLabels present", async () => {
    const { fetch } = makeFetch(async (url) => {
      if (url.includes("/issues?")) {
        return jsonResponse([
          makeIssue(1, { labels: [{ name: "bug" }] }),
          makeIssue(2, { labels: [{ name: "noindex" }, { name: "wontfix" }] }),
        ]);
      }
      if (url.includes("/comments?")) {
        return jsonResponse([]);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider(fetch, {
      owner: "acme",
      repo: "widget",
      excludeLabels: ["noindex"],
    });

    const docIds: string[] = [];
    for await (const d of provider.listDocuments()) docIds.push(d.id);

    expect(docIds).toEqual(["acme/widget#1"]);
  });

  it("requires all include labels to be present", async () => {
    const { fetch } = makeFetch(async (url) => {
      if (url.includes("/issues?")) {
        return jsonResponse([
          makeIssue(1, { labels: [{ name: "rfc" }, { name: "approved" }] }),
          makeIssue(2, { labels: [{ name: "rfc" }] }),
        ]);
      }
      if (url.includes("/comments?")) return jsonResponse([]);
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider(fetch, {
      owner: "acme",
      repo: "widget",
      labels: ["rfc", "approved"],
    });

    const ids: string[] = [];
    for await (const d of provider.listDocuments()) ids.push(d.id);

    expect(ids).toEqual(["acme/widget#1"]);
  });

  it("filters by maxAgeDays", async () => {
    const now = Date.now();
    const oldDate = new Date(now - 120 * 24 * 60 * 60 * 1000).toISOString(); // 120 days old
    const recentDate = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days old

    const { fetch } = makeFetch(async (url) => {
      if (url.includes("/issues?")) {
        return jsonResponse([
          makeIssue(1, { updated_at: oldDate }),
          makeIssue(2, { updated_at: recentDate }),
        ]);
      }
      if (url.includes("/comments?")) return jsonResponse([]);
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider(fetch, {
      owner: "acme",
      repo: "widget",
      maxAgeDays: 30,
    });

    const ids: string[] = [];
    for await (const d of provider.listDocuments()) ids.push(d.id);

    expect(ids).toEqual(["acme/widget#2"]);
  });
});

describe("GitHubActivityProvider — fetchDocument", () => {
  it("fetches a single issue by owner/repo#number id", async () => {
    const { fetch } = makeFetch(async (url) => {
      if (url.includes("/issues/42") && !url.includes("/comments")) {
        return jsonResponse(makeIssue(42, { title: "Refactor core module" }));
      }
      if (url.includes("/comments")) {
        return jsonResponse([]);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider(fetch, { owner: "acme", repo: "widget" });
    const doc = await provider.fetchDocument("acme/widget#42");

    expect(doc.id).toBe("acme/widget#42");
    expect(doc.title).toContain("Refactor core module");
    expect(doc.url).toBe("https://github.com/acme/widget/issues/42");
    expect(doc.metadata["sourceType"]).toBe("github-activity");
  });

  it("rejects malformed document IDs", async () => {
    const { fetch } = makeFetch(async () => jsonResponse({}, 404));
    const provider = makeProvider(fetch, { owner: "acme", repo: "widget" });

    expect(provider.fetchDocument("not-a-real-id")).rejects.toThrow(/Invalid GitHub activity/);
  });
});

describe("GitHubActivityProvider — retry behavior", () => {
  it("retries on 429 and succeeds on the second attempt", async () => {
    let attempt = 0;
    const { fetch } = makeFetch(async (url) => {
      if (url.includes("/issues?")) {
        attempt++;
        if (attempt === 1) {
          return jsonResponse({ message: "secondary rate limit exceeded" }, 429);
        }
        return jsonResponse([makeIssue(1)]);
      }
      if (url.includes("/comments?")) return jsonResponse([]);
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider(fetch, { owner: "acme", repo: "widget" });

    const ids: string[] = [];
    for await (const d of provider.listDocuments()) ids.push(d.id);

    expect(ids).toEqual(["acme/widget#1"]);
    expect(attempt).toBe(2);
  });
});
