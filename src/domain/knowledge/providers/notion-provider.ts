/**
 * Notion Knowledge Provider
 *
 * Implements KnowledgeSourceProvider for Notion, connecting to the Notion API
 * to retrieve pages and their content as KnowledgeDocuments.
 */

import type { KnowledgeDocument, KnowledgeSourceProvider, ListOptions } from "../types";

// Notion API version
const NOTION_API_VERSION = "2022-06-28";
const NOTION_API_BASE = "https://api.notion.com/v1";

// Rate limit: Notion allows 3 requests/second
const REQUESTS_PER_SECOND = 3;
const MIN_REQUEST_INTERVAL_MS = Math.ceil(1000 / REQUESTS_PER_SECOND);

// ---------------------------------------------------------------------------
// Notion API response shapes
// ---------------------------------------------------------------------------

interface NotionRichText {
  type: string;
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
    underline?: boolean;
  };
  text?: { content: string; link?: { url: string } | null };
}

interface NotionPageTitleProperty {
  type: "title";
  title: NotionRichText[];
}

interface NotionPage {
  id: string;
  object: "page";
  url: string;
  last_edited_time: string;
  created_time: string;
  parent?: {
    type: string;
    page_id?: string;
    database_id?: string;
    block_id?: string;
  };
  properties?: Record<string, { type: string; title?: NotionRichText[] }>;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  // Typed property access for known block types
  paragraph?: { rich_text: NotionRichText[]; color?: string };
  heading_1?: { rich_text: NotionRichText[]; color?: string };
  heading_2?: { rich_text: NotionRichText[]; color?: string };
  heading_3?: { rich_text: NotionRichText[]; color?: string };
  bulleted_list_item?: { rich_text: NotionRichText[] };
  numbered_list_item?: { rich_text: NotionRichText[] };
  code?: { rich_text: NotionRichText[]; language?: string };
  quote?: { rich_text: NotionRichText[] };
  callout?: { rich_text: NotionRichText[]; icon?: { type: string; emoji?: string } };
  divider?: Record<string, never>;
  toggle?: { rich_text: NotionRichText[] };
  table?: { table_width: number; has_column_header: boolean; has_row_header: boolean };
  table_row?: { cells: NotionRichText[][] };
  child_page?: { title: string };
  [key: string]: unknown;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor?: string | null;
}

interface NotionSearchResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor?: string | null;
}

// ---------------------------------------------------------------------------
// Fetch function type for DI
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Simple token-bucket rate limiter
// ---------------------------------------------------------------------------

class RateLimiter {
  private lastRequestTime = 0;

  async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      const delay = MIN_REQUEST_INTERVAL_MS - elapsed;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    this.lastRequestTime = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Block rendering helpers
// ---------------------------------------------------------------------------

function renderInlineFormatting(richText: NotionRichText[]): string {
  return richText
    .map((rt) => {
      let text = rt.plain_text;
      const ann = rt.annotations;
      if (!ann) {
        // Check for link in text property
        if (rt.href) {
          text = `[${text}](${rt.href})`;
        }
        return text;
      }
      if (ann.code) text = `\`${text}\``;
      if (ann.bold) text = `**${text}**`;
      if (ann.italic) text = `*${text}*`;
      if (ann.strikethrough) text = `~~${text}~~`;
      if (rt.href) text = `[${text}](${rt.href})`;
      return text;
    })
    .join("");
}

function renderBlock(block: NotionBlock, numberedListCounters: Map<string, number>): string {
  const type = block.type;

  switch (type) {
    case "paragraph": {
      const rt = block.paragraph?.rich_text ?? [];
      return renderInlineFormatting(rt);
    }
    case "heading_1": {
      const rt = block.heading_1?.rich_text ?? [];
      return `# ${renderInlineFormatting(rt)}`;
    }
    case "heading_2": {
      const rt = block.heading_2?.rich_text ?? [];
      return `## ${renderInlineFormatting(rt)}`;
    }
    case "heading_3": {
      const rt = block.heading_3?.rich_text ?? [];
      return `### ${renderInlineFormatting(rt)}`;
    }
    case "bulleted_list_item": {
      const rt = block.bulleted_list_item?.rich_text ?? [];
      return `- ${renderInlineFormatting(rt)}`;
    }
    case "numbered_list_item": {
      const parentKey = "root";
      const count = (numberedListCounters.get(parentKey) ?? 0) + 1;
      numberedListCounters.set(parentKey, count);
      const rt = block.numbered_list_item?.rich_text ?? [];
      return `${count}. ${renderInlineFormatting(rt)}`;
    }
    case "code": {
      const rt = block.code?.rich_text ?? [];
      const lang = block.code?.language ?? "";
      const codeText = rt.map((r) => r.plain_text).join("");
      return `\`\`\`${lang}\n${codeText}\n\`\`\``;
    }
    case "quote": {
      const rt = block.quote?.rich_text ?? [];
      return `> ${renderInlineFormatting(rt)}`;
    }
    case "callout": {
      const rt = block.callout?.rich_text ?? [];
      const icon = block.callout?.icon;
      const iconText = icon?.type === "emoji" && icon.emoji ? `${icon.emoji} ` : "";
      return `> ${iconText}${renderInlineFormatting(rt)}`;
    }
    case "divider":
      return "---";
    case "toggle": {
      const rt = block.toggle?.rich_text ?? [];
      return `### ${renderInlineFormatting(rt)}`;
    }
    case "table_row": {
      const cells = block.table_row?.cells ?? [];
      const rendered = cells.map((cell) => renderInlineFormatting(cell));
      return `| ${rendered.join(" | ")} |`;
    }
    case "child_page":
      // Child pages are traversed separately; emit nothing in content
      return "";
    case "table":
      // Table headers are rendered via table_row children; emit nothing here
      return "";
    default:
      return `[Unsupported: ${type}]`;
  }
}

function blocksToMarkdown(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  const numberedListCounters = new Map<string, number>();
  let lastType: string | null = null;
  let tableHeaderEmitted = false;

  for (const block of blocks) {
    // Reset numbered list counter when switching away from numbered list items
    if (block.type !== "numbered_list_item" && lastType === "numbered_list_item") {
      numberedListCounters.clear();
    }

    // Handle table separator after header row
    if (block.type === "table_row" && lastType === "table") {
      tableHeaderEmitted = false;
    }

    const rendered = renderBlock(block, numberedListCounters);

    if (block.type === "table_row") {
      lines.push(rendered);
      if (!tableHeaderEmitted) {
        const cells = block.table_row?.cells ?? [];
        const sep = cells.map(() => "---").join(" | ");
        lines.push(`| ${sep} |`);
        tableHeaderEmitted = true;
      }
    } else if (rendered) {
      lines.push(rendered);
    }

    lastType = block.type;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helper: extract page title from a Notion page object
// ---------------------------------------------------------------------------

function extractPageTitle(page: NotionPage): string {
  if (!page.properties) return page.id;

  // Check the "title" property directly
  const titleProp = page.properties["title"] as NotionPageTitleProperty | undefined;
  if (titleProp?.title?.length) {
    return titleProp.title.map((rt) => rt.plain_text).join("");
  }

  // Some pages store title in "Name" property
  const nameProp = page.properties["Name"] as NotionPageTitleProperty | undefined;
  if (nameProp?.title?.length) {
    return nameProp.title.map((rt) => rt.plain_text).join("");
  }

  // Fall back: look for any title-type property
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title?.length) {
      return prop.title.map((rt) => rt.plain_text).join("");
    }
  }

  return page.id;
}

// ---------------------------------------------------------------------------
// Helper: check if a title path matches any exclude pattern
// ---------------------------------------------------------------------------

function matchesExcludePattern(titlePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Support simple glob-like wildcards (* matches any characters)
    const regexStr = pattern
      .split("*")
      .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    const regex = new RegExp(`^${regexStr}$`, "i");
    return regex.test(titlePath);
  });
}

// ---------------------------------------------------------------------------
// NotionKnowledgeProvider
// ---------------------------------------------------------------------------

export class NotionKnowledgeProvider implements KnowledgeSourceProvider {
  readonly sourceType = "notion";
  readonly sourceName: string;

  private readonly rootPageId: string;
  private readonly token: string;
  private readonly excludePatterns: string[];
  private readonly fetchFn: FetchFn;
  private readonly rateLimiter: RateLimiter;

  constructor(
    rootPageId: string,
    token: string,
    sourceName: string,
    options?: {
      excludePatterns?: string[];
      fetch?: FetchFn;
    }
  ) {
    this.rootPageId = rootPageId;
    this.token = token;
    this.sourceName = sourceName;
    this.excludePatterns = options?.excludePatterns ?? [];
    this.fetchFn = options?.fetch ?? globalThis.fetch.bind(globalThis);
    this.rateLimiter = new RateLimiter();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async *listDocuments(options?: ListOptions): AsyncIterable<KnowledgeDocument> {
    const maxDepth = options?.maxDepth;
    yield* this.traversePage(this.rootPageId, undefined, 0, maxDepth);
  }

  async fetchDocument(id: string): Promise<KnowledgeDocument> {
    const page = await this.getPage(id);
    const blocks = await this.getAllBlocks(id);
    const content = blocksToMarkdown(blocks);
    const title = extractPageTitle(page);

    const parentId =
      page.parent?.type === "page_id"
        ? page.parent.page_id
        : page.parent?.type === "block_id"
          ? page.parent.block_id
          : undefined;

    return {
      id: page.id,
      title,
      content,
      url: page.url,
      parentId,
      lastModified: new Date(page.last_edited_time),
      metadata: {
        createdTime: page.created_time,
        sourceType: "notion",
        sourceName: this.sourceName,
      },
    };
  }

  async *getChangedSince(since: Date, _options?: ListOptions): AsyncIterable<KnowledgeDocument> {
    let cursor: string | null = null;

    while (true) {
      await this.rateLimiter.throttle();
      const body: Record<string, unknown> = {
        filter: { property: "object", value: "page" },
        sort: { timestamp: "last_edited_time", direction: "descending" },
      };
      if (cursor) body["start_cursor"] = cursor;

      const resp = await this.apiPost<NotionSearchResponse>("/search", body);

      for (const page of resp.results) {
        const lastEdited = new Date(page.last_edited_time);
        if (lastEdited <= since) {
          // Results are sorted descending — once we see an older one, stop
          return;
        }
        yield await this.fetchDocument(page.id);
      }

      if (!resp.has_more || !resp.next_cursor) break;
      cursor = resp.next_cursor;
    }
  }

  // -------------------------------------------------------------------------
  // Internal traversal
  // -------------------------------------------------------------------------

  private async *traversePage(
    pageId: string,
    parentId: string | undefined,
    depth: number,
    maxDepth: number | undefined
  ): AsyncIterable<KnowledgeDocument> {
    // Fetch this page's metadata
    const page = await this.getPage(pageId);
    const title = extractPageTitle(page);

    // Check exclude patterns
    if (this.excludePatterns.length > 0 && matchesExcludePattern(title, this.excludePatterns)) {
      return;
    }

    // Fetch all blocks
    const blocks = await this.getAllBlocks(pageId);

    // Collect child pages for recursion
    const childPages = blocks.filter((b) => b.type === "child_page");

    // Filter out child_page blocks from content rendering
    const contentBlocks = blocks.filter((b) => b.type !== "child_page");
    const content = blocksToMarkdown(contentBlocks);

    yield {
      id: page.id,
      title,
      content,
      url: page.url,
      parentId,
      lastModified: new Date(page.last_edited_time),
      metadata: {
        createdTime: page.created_time,
        sourceType: "notion",
        sourceName: this.sourceName,
      },
    };

    // Recurse into child pages if depth allows
    if (maxDepth === undefined || depth < maxDepth) {
      for (const childBlock of childPages) {
        yield* this.traversePage(childBlock.id, pageId, depth + 1, maxDepth);
      }
    }
  }

  // -------------------------------------------------------------------------
  // API helpers
  // -------------------------------------------------------------------------

  private async getPage(pageId: string): Promise<NotionPage> {
    await this.rateLimiter.throttle();
    return this.apiGet<NotionPage>(`/pages/${pageId}`);
  }

  private async getAllBlocks(blockId: string): Promise<NotionBlock[]> {
    const all: NotionBlock[] = [];
    let cursor: string | null = null;

    while (true) {
      await this.rateLimiter.throttle();
      const url = cursor
        ? `/blocks/${blockId}/children?start_cursor=${encodeURIComponent(cursor)}`
        : `/blocks/${blockId}/children`;

      const resp = await this.apiGet<NotionBlocksResponse>(url);
      all.push(...resp.results);

      if (!resp.has_more || !resp.next_cursor) break;
      cursor = resp.next_cursor;
    }

    return all;
  }

  private async apiGet<T>(path: string): Promise<T> {
    const resp = await this.fetchFn(`${NOTION_API_BASE}${path}`, {
      method: "GET",
      headers: this.buildHeaders(),
    });
    return this.handleResponse<T>(resp);
  }

  private async apiPost<T>(path: string, body: unknown): Promise<T> {
    const resp = await this.fetchFn(`${NOTION_API_BASE}${path}`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(resp);
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": NOTION_API_VERSION,
    };
  }

  private async handleResponse<T>(resp: Response): Promise<T> {
    if (!resp.ok) {
      let extra = "";
      try {
        const json = (await resp.json()) as { message?: string; code?: string };
        const parts: string[] = [];
        if (json.code) parts.push(`code=${json.code}`);
        if (json.message) parts.push(`message=${json.message}`);
        extra = parts.length > 0 ? ` - ${parts.join(", ")}` : "";
      } catch {
        extra = await resp.text().catch(() => "");
      }
      throw new Error(`Notion API error: ${resp.status} ${resp.statusText}${extra}`);
    }
    return resp.json() as Promise<T>;
  }
}
