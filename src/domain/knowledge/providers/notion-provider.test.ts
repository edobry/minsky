import { describe, it, expect } from "bun:test";
import { NotionKnowledgeProvider } from "./notion-provider";
import type { FetchFn } from "./notion-provider";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePage(
  id: string,
  title: string,
  parentId?: string,
  lastEdited?: string
): Record<string, unknown> {
  return {
    id,
    object: "page",
    url: `https://www.notion.so/${id.replace(/-/g, "")}`,
    last_edited_time: lastEdited ?? "2024-01-01T00:00:00.000Z",
    created_time: "2024-01-01T00:00:00.000Z",
    parent: parentId
      ? { type: "page_id", page_id: parentId }
      : { type: "workspace", workspace: true },
    properties: {
      title: {
        type: "title",
        title: [{ type: "text", plain_text: title, annotations: {} }],
      },
    },
  };
}

function makeChildPageBlock(id: string, title: string): Record<string, unknown> {
  return { id, type: "child_page", child_page: { title }, has_children: true };
}

function makeParagraphBlock(text: string): Record<string, unknown> {
  return {
    id: `para-${text.slice(0, 8)}`,
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", plain_text: text, annotations: {}, href: null }],
    },
    has_children: false,
  };
}

function makeBlocksResponse(
  blocks: unknown[],
  hasMore = false,
  nextCursor: string | null = null
): Record<string, unknown> {
  return { object: "list", results: blocks, has_more: hasMore, next_cursor: nextCursor };
}

/**
 * Build a simple fetch mock that routes by URL pattern.
 * Routes is an array of [pattern, responseBody] where pattern is a string match.
 * Responses are returned as 200 OK JSON.
 */
function buildFetchMock(
  routes: Array<{ match: (url: string, body?: string) => boolean; response: unknown }>
): FetchFn {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const bodyStr = typeof init?.body === "string" ? init.body : undefined;
    for (const route of routes) {
      if (route.match(url, bodyStr)) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          async json() {
            return route.response;
          },
          async text() {
            return JSON.stringify(route.response);
          },
          headers: new Headers(),
        } as Response;
      }
    }
    throw new Error(`Unmocked fetch: ${url}`);
  };
}

// ---------------------------------------------------------------------------
// Tests: fetchDocument
// ---------------------------------------------------------------------------

describe("NotionKnowledgeProvider.fetchDocument", () => {
  it("fetches a single page and returns a KnowledgeDocument", async () => {
    const pageId = "page-001";
    const fetchMock = buildFetchMock([
      {
        match: (url) => url.includes(`/pages/${pageId}`),
        response: makePage(pageId, "My Page"),
      },
      {
        match: (url) => url.includes(`/blocks/${pageId}/children`),
        response: makeBlocksResponse([makeParagraphBlock("Hello world")]),
      },
    ]);

    const provider = new NotionKnowledgeProvider("root-id", "test-token", "test-source", {
      fetch: fetchMock,
    });
    const doc = await provider.fetchDocument(pageId);

    expect(doc.id).toBe(pageId);
    expect(doc.title).toBe("My Page");
    expect(doc.content).toContain("Hello world");
    expect(doc.url).toContain(pageId.replace(/-/g, ""));
    expect(doc.lastModified).toBeInstanceOf(Date);
    expect(doc.metadata["sourceType"]).toBe("notion");
    expect(doc.metadata["sourceName"]).toBe("test-source");
  });

  it("sets parentId when page has a page parent", async () => {
    const pageId = "child-page";
    const parentPageId = "parent-page";
    const fetchMock = buildFetchMock([
      {
        match: (url) => url.includes(`/pages/${pageId}`),
        response: makePage(pageId, "Child", parentPageId),
      },
      {
        match: (url) => url.includes(`/blocks/${pageId}/children`),
        response: makeBlocksResponse([]),
      },
    ]);

    const provider = new NotionKnowledgeProvider("root-id", "test-token", "test-source", {
      fetch: fetchMock,
    });
    const doc = await provider.fetchDocument(pageId);

    expect(doc.parentId).toBe(parentPageId);
  });
});

// ---------------------------------------------------------------------------
// Tests: listDocuments - tree traversal
// ---------------------------------------------------------------------------

describe("NotionKnowledgeProvider.listDocuments", () => {
  it("yields root page and child pages", async () => {
    const rootId = "root";
    const child1Id = "child-1";

    const fetchMock = buildFetchMock([
      {
        match: (url) => url.includes(`/pages/${rootId}`),
        response: makePage(rootId, "Root Page"),
      },
      {
        match: (url) => url.includes(`/blocks/${rootId}/children`),
        response: makeBlocksResponse([
          makeParagraphBlock("Root content"),
          makeChildPageBlock(child1Id, "Child 1"),
        ]),
      },
      {
        match: (url) => url.includes(`/pages/${child1Id}`),
        response: makePage(child1Id, "Child 1", rootId),
      },
      {
        match: (url) => url.includes(`/blocks/${child1Id}/children`),
        response: makeBlocksResponse([makeParagraphBlock("Child content")]),
      },
    ]);

    const provider = new NotionKnowledgeProvider(rootId, "test-token", "test-source", {
      fetch: fetchMock,
    });

    const docs: Array<{ id: string; title: string }> = [];
    for await (const doc of provider.listDocuments()) {
      docs.push({ id: doc.id, title: doc.title });
    }

    expect(docs).toHaveLength(2);
    expect(docs[0]?.title).toBe("Root Page");
    expect(docs[1]?.title).toBe("Child 1");
  });

  it("respects maxDepth option — stops recursion at depth 0", async () => {
    const rootId = "root";
    const child1Id = "child-1";

    const fetchMock = buildFetchMock([
      {
        match: (url) => url.includes(`/pages/${rootId}`),
        response: makePage(rootId, "Root Page"),
      },
      {
        match: (url) => url.includes(`/blocks/${rootId}/children`),
        response: makeBlocksResponse([makeChildPageBlock(child1Id, "Child 1")]),
      },
      // child pages should NOT be requested at depth 0
    ]);

    const provider = new NotionKnowledgeProvider(rootId, "test-token", "test-source", {
      fetch: fetchMock,
    });

    const docs: string[] = [];
    for await (const doc of provider.listDocuments({ maxDepth: 0 })) {
      docs.push(doc.id);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0]).toBe(rootId);
  });

  it("respects maxDepth — traverses exactly one level deep at depth 1", async () => {
    const rootId = "root";
    const child1Id = "child-1";
    const grandchildId = "grandchild-1";

    const fetchMock = buildFetchMock([
      {
        match: (url) => url.includes(`/pages/${rootId}`),
        response: makePage(rootId, "Root"),
      },
      {
        match: (url) => url.includes(`/blocks/${rootId}/children`),
        response: makeBlocksResponse([makeChildPageBlock(child1Id, "Child")]),
      },
      {
        match: (url) => url.includes(`/pages/${child1Id}`),
        response: makePage(child1Id, "Child", rootId),
      },
      {
        match: (url) => url.includes(`/blocks/${child1Id}/children`),
        response: makeBlocksResponse([makeChildPageBlock(grandchildId, "Grandchild")]),
      },
      // grandchild should NOT be requested
    ]);

    const provider = new NotionKnowledgeProvider(rootId, "test-token", "test-source", {
      fetch: fetchMock,
    });

    const docs: string[] = [];
    for await (const doc of provider.listDocuments({ maxDepth: 1 })) {
      docs.push(doc.id);
    }

    expect(docs).toHaveLength(2);
    expect(docs).toContain(rootId);
    expect(docs).toContain(child1Id);
    expect(docs).not.toContain(grandchildId);
  });

  it("filters out pages matching excludePatterns", async () => {
    const rootId = "root";
    const child1Id = "draft-page";
    const child2Id = "real-page";

    const fetchMock = buildFetchMock([
      {
        match: (url) => url.includes(`/pages/${rootId}`),
        response: makePage(rootId, "Root"),
      },
      {
        match: (url) => url.includes(`/blocks/${rootId}/children`),
        response: makeBlocksResponse([
          makeChildPageBlock(child1Id, "Draft Page"),
          makeChildPageBlock(child2Id, "Real Page"),
        ]),
      },
      {
        match: (url) => url.includes(`/pages/${child1Id}`),
        response: makePage(child1Id, "Draft Page", rootId),
      },
      {
        match: (url) => url.includes(`/blocks/${child1Id}/children`),
        response: makeBlocksResponse([]),
      },
      {
        match: (url) => url.includes(`/pages/${child2Id}`),
        response: makePage(child2Id, "Real Page", rootId),
      },
      {
        match: (url) => url.includes(`/blocks/${child2Id}/children`),
        response: makeBlocksResponse([]),
      },
    ]);

    const provider = new NotionKnowledgeProvider(rootId, "test-token", "test-source", {
      excludePatterns: ["Draft*"],
      fetch: fetchMock,
    });

    const docs: string[] = [];
    for await (const doc of provider.listDocuments()) {
      docs.push(doc.title);
    }

    expect(docs).not.toContain("Draft Page");
    expect(docs).toContain("Real Page");
  });
});

// ---------------------------------------------------------------------------
// Tests: block rendering
// ---------------------------------------------------------------------------

describe("NotionKnowledgeProvider block rendering", () => {
  async function renderBlocks(blocks: unknown[]): Promise<string> {
    const pageId = "test-page";
    const fetchMock = buildFetchMock([
      {
        match: (url) => url.includes(`/pages/${pageId}`),
        response: makePage(pageId, "Test Page"),
      },
      {
        match: (url) => url.includes(`/blocks/${pageId}/children`),
        response: makeBlocksResponse(blocks),
      },
    ]);
    const provider = new NotionKnowledgeProvider("root", "token", "test", {
      fetch: fetchMock,
    });
    const doc = await provider.fetchDocument(pageId);
    return doc.content;
  }

  it("renders paragraph blocks", async () => {
    const content = await renderBlocks([makeParagraphBlock("Hello world")]);
    expect(content).toBe("Hello world");
  });

  it("renders heading blocks", async () => {
    const makeHeading = (level: 1 | 2 | 3, text: string) => ({
      id: `h${level}`,
      type: `heading_${level}`,
      [`heading_${level}`]: {
        rich_text: [{ type: "text", plain_text: text, annotations: {}, href: null }],
      },
    });

    const content = await renderBlocks([
      makeHeading(1, "Title"),
      makeHeading(2, "Subtitle"),
      makeHeading(3, "Section"),
    ]);
    expect(content).toContain("# Title");
    expect(content).toContain("## Subtitle");
    expect(content).toContain("### Section");
  });

  it("renders bulleted list items", async () => {
    const makeItem = (text: string) => ({
      id: `item-${text}`,
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [{ type: "text", plain_text: text, annotations: {}, href: null }],
      },
    });
    const content = await renderBlocks([makeItem("First"), makeItem("Second")]);
    expect(content).toContain("- First");
    expect(content).toContain("- Second");
  });

  it("renders numbered list items with sequential numbers", async () => {
    const makeItem = (text: string) => ({
      id: `item-${text}`,
      type: "numbered_list_item",
      numbered_list_item: {
        rich_text: [{ type: "text", plain_text: text, annotations: {}, href: null }],
      },
    });
    const content = await renderBlocks([makeItem("First"), makeItem("Second")]);
    expect(content).toContain("1. First");
    expect(content).toContain("2. Second");
  });

  it("renders code blocks with language", async () => {
    const codeBlock = {
      id: "code-1",
      type: "code",
      code: {
        language: "typescript",
        rich_text: [{ type: "text", plain_text: "const x = 1;", annotations: {}, href: null }],
      },
    };
    const content = await renderBlocks([codeBlock]);
    expect(content).toContain("```typescript");
    expect(content).toContain("const x = 1;");
    expect(content).toContain("```");
  });

  it("renders quote blocks", async () => {
    const quoteBlock = {
      id: "quote-1",
      type: "quote",
      quote: {
        rich_text: [
          { type: "text", plain_text: "To be or not to be", annotations: {}, href: null },
        ],
      },
    };
    const content = await renderBlocks([quoteBlock]);
    expect(content).toContain("> To be or not to be");
  });

  it("renders callout blocks with emoji icon", async () => {
    const calloutBlock = {
      id: "callout-1",
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "💡" },
        rich_text: [{ type: "text", plain_text: "Important note", annotations: {}, href: null }],
      },
    };
    const content = await renderBlocks([calloutBlock]);
    expect(content).toContain("> 💡 Important note");
  });

  it("renders divider blocks", async () => {
    const dividerBlock = { id: "div-1", type: "divider", divider: {} };
    const content = await renderBlocks([dividerBlock]);
    expect(content).toContain("---");
  });

  it("renders unsupported blocks with placeholder", async () => {
    const unknownBlock = { id: "unk-1", type: "embed", embed: { url: "https://example.com" } };
    const content = await renderBlocks([unknownBlock]);
    expect(content).toContain("[Unsupported: embed]");
  });

  it("renders inline bold, italic, code, strikethrough formatting", async () => {
    const paragraphWithFormatting = {
      id: "para-fmt",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            plain_text: "bold",
            annotations: { bold: true, italic: false, code: false, strikethrough: false },
            href: null,
          },
          {
            type: "text",
            plain_text: " italic",
            annotations: { bold: false, italic: true, code: false, strikethrough: false },
            href: null,
          },
          {
            type: "text",
            plain_text: " code",
            annotations: { bold: false, italic: false, code: true, strikethrough: false },
            href: null,
          },
          {
            type: "text",
            plain_text: " strike",
            annotations: { bold: false, italic: false, code: false, strikethrough: true },
            href: null,
          },
        ],
      },
    };
    const content = await renderBlocks([paragraphWithFormatting]);
    expect(content).toContain("**bold**");
    expect(content).toContain("* italic*");
    expect(content).toContain("` code`");
    expect(content).toContain("~~ strike~~");
  });
});

// ---------------------------------------------------------------------------
// Tests: pagination handling
// ---------------------------------------------------------------------------

describe("NotionKnowledgeProvider pagination", () => {
  it("fetches all pages when has_more is true", async () => {
    const pageId = "paged-page";
    let callCount = 0;

    const fetchFn: FetchFn = async (url: string): Promise<Response> => {
      if (url.includes(`/pages/${pageId}`)) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          async json() {
            return makePage(pageId, "Paged Page");
          },
          async text() {
            return JSON.stringify(makePage(pageId, "Paged Page"));
          },
          headers: new Headers(),
        } as Response;
      }

      if (url.includes(`/blocks/${pageId}/children`)) {
        callCount++;
        const isFirstPage = !url.includes("start_cursor");
        if (isFirstPage) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            async json() {
              return makeBlocksResponse([makeParagraphBlock("Page 1 content")], true, "cursor-abc");
            },
            async text() {
              return "";
            },
            headers: new Headers(),
          } as Response;
        } else {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            async json() {
              return makeBlocksResponse([makeParagraphBlock("Page 2 content")], false, null);
            },
            async text() {
              return "";
            },
            headers: new Headers(),
          } as Response;
        }
      }

      throw new Error(`Unmocked: ${url}`);
    };

    const provider = new NotionKnowledgeProvider("root", "token", "test", { fetch: fetchFn });
    const doc = await provider.fetchDocument(pageId);

    expect(callCount).toBe(2);
    expect(doc.content).toContain("Page 1 content");
    expect(doc.content).toContain("Page 2 content");
  });
});

// ---------------------------------------------------------------------------
// Tests: getChangedSince date filtering
// ---------------------------------------------------------------------------

describe("NotionKnowledgeProvider.getChangedSince", () => {
  it("yields only documents modified after the given date", async () => {
    const recentPageId = "recent-page";
    const oldPageId = "old-page";
    const since = new Date("2024-06-01T00:00:00Z");

    const searchResponse = {
      object: "list",
      results: [
        {
          ...makePage(recentPageId, "Recent Page"),
          last_edited_time: "2024-07-01T00:00:00.000Z",
        },
        {
          ...makePage(oldPageId, "Old Page"),
          last_edited_time: "2024-05-01T00:00:00.000Z",
        },
      ],
      has_more: false,
      next_cursor: null,
    };

    const fetchMock = buildFetchMock([
      {
        match: (url) => url.includes("/search"),
        response: searchResponse,
      },
      {
        match: (url) => url.includes(`/pages/${recentPageId}`),
        response: {
          ...makePage(recentPageId, "Recent Page"),
          last_edited_time: "2024-07-01T00:00:00.000Z",
        },
      },
      {
        match: (url) => url.includes(`/blocks/${recentPageId}/children`),
        response: makeBlocksResponse([makeParagraphBlock("Recent content")]),
      },
    ]);

    const provider = new NotionKnowledgeProvider("root", "token", "test", { fetch: fetchMock });

    const docs: string[] = [];
    for await (const doc of provider.getChangedSince(since)) {
      docs.push(doc.id);
    }

    expect(docs).toContain(recentPageId);
    expect(docs).not.toContain(oldPageId);
  });

  it("stops iterating when result timestamp is not newer than since", async () => {
    const since = new Date("2024-06-01T00:00:00Z");
    let fetchCallCount = 0;

    const searchResponse = {
      object: "list",
      results: [
        // All results are older than since — should stop after seeing first
        {
          ...makePage("old-1", "Old 1"),
          last_edited_time: "2024-01-01T00:00:00.000Z",
        },
      ],
      has_more: false,
      next_cursor: null,
    };

    const fetchFn: FetchFn = async (url: string): Promise<Response> => {
      fetchCallCount++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return searchResponse;
        },
        async text() {
          return "";
        },
        headers: new Headers(),
      } as Response;
    };

    const provider = new NotionKnowledgeProvider("root", "token", "test", { fetch: fetchFn });

    const docs: string[] = [];
    for await (const doc of provider.getChangedSince(since)) {
      docs.push(doc.id);
    }

    // No pages should be yielded
    expect(docs).toHaveLength(0);
    // Only one fetch for the search call
    expect(fetchCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: retry behavior (via IntelligentRetryService)
// ---------------------------------------------------------------------------

describe("NotionKnowledgeProvider retry behavior", () => {
  it("retries on 502 Bad Gateway and succeeds on second attempt", async () => {
    const pageId = "retry-502-page";
    let callCount = 0;

    const fetchFn: FetchFn = async (url: string): Promise<Response> => {
      if (url.includes(`/pages/${pageId}`)) {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 502,
            statusText: "Bad Gateway",
            async json() {
              throw new Error("no body");
            },
            async text() {
              return "Bad Gateway";
            },
            headers: new Headers(),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          async json() {
            return makePage(pageId, "Retry Page");
          },
          async text() {
            return "";
          },
          headers: new Headers(),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return makeBlocksResponse([]);
        },
        async text() {
          return "";
        },
        headers: new Headers(),
      } as Response;
    };

    const { IntelligentRetryService } = await import("../../ai/intelligent-retry-service");
    const provider = new NotionKnowledgeProvider("root", "token", "test", {
      fetch: fetchFn,
      retryService: new IntelligentRetryService({ maxRetries: 3, baseDelay: 0 }),
    });

    const doc = await provider.fetchDocument(pageId);
    expect(doc.title).toBe("Retry Page");
    expect(callCount).toBe(2);
  });

  it("retries on 429 Too Many Requests and succeeds on second attempt", async () => {
    const pageId = "retry-429-page";
    let callCount = 0;

    const fetchFn: FetchFn = async (url: string): Promise<Response> => {
      if (url.includes(`/pages/${pageId}`)) {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            async json() {
              return { message: "rate limited", code: "rate_limited" };
            },
            async text() {
              return "Too Many Requests";
            },
            headers: new Headers(),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          async json() {
            return makePage(pageId, "Retry 429 Page");
          },
          async text() {
            return "";
          },
          headers: new Headers(),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return makeBlocksResponse([]);
        },
        async text() {
          return "";
        },
        headers: new Headers(),
      } as Response;
    };

    const { IntelligentRetryService } = await import("../../ai/intelligent-retry-service");
    const provider = new NotionKnowledgeProvider("root", "token", "test", {
      fetch: fetchFn,
      retryService: new IntelligentRetryService({ maxRetries: 3, baseDelay: 0 }),
    });

    const doc = await provider.fetchDocument(pageId);
    expect(doc.title).toBe("Retry 429 Page");
    expect(callCount).toBe(2);
  });
});
