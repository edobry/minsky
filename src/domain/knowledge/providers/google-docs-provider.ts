/**
 * Google Docs / Drive Knowledge Provider
 *
 * Implements KnowledgeSourceProvider for Google Docs, retrieving documents either
 * from a specific Google Drive folder (recursive walk) or from an explicit list of
 * document IDs.
 *
 * Auth paths supported:
 *   1. OAuth access token — pass `Authorization: Bearer <token>` directly.
 *   2. Service account JSON key — exchange the key for a short-lived access token
 *      via Google's OAuth2 token endpoint; cache until expiry; re-fetch on 401.
 */

import type { KnowledgeDocument, KnowledgeSourceProvider, ListOptions } from "../types";
import { IntelligentRetryService } from "../../ai/intelligent-retry-service";
import { isRetryableGoogleDocsError } from "../../ai/embedding-service-openai";
import { createSign } from "crypto";

// ---------------------------------------------------------------------------
// Google API constants
// ---------------------------------------------------------------------------

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DOCS_EXPORT_BASE = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google Drive MIME type for Docs documents */
const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

// ---------------------------------------------------------------------------
// Google API response shapes
// ---------------------------------------------------------------------------

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  createdTime?: string;
  webViewLink?: string;
  parents?: string[];
}

interface DriveFilesListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface ServiceAccountKey {
  type: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
}

// ---------------------------------------------------------------------------
// Fetch function type for DI
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Token cache entry (for service account)
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string;
  /** Unix timestamp (ms) when this token expires */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// GoogleDocsKnowledgeProvider options
// ---------------------------------------------------------------------------

export interface GoogleDocsProviderOptions {
  /** OAuth access token (bearer token used directly) */
  accessToken?: string;
  /** Parsed service account JSON key (for service-account auth) */
  serviceAccountKey?: ServiceAccountKey;
  /** Drive folder ID to walk recursively (mutually exclusive with documentIds) */
  driveFolderId?: string;
  /** Explicit list of document IDs to fetch (mutually exclusive with driveFolderId) */
  documentIds?: string[];
  /** Injected fetch function (for testing) */
  fetch?: FetchFn;
  /** Injected retry service (for testing) */
  retryService?: IntelligentRetryService;
}

// ---------------------------------------------------------------------------
// Helper: build a JWT assertion for service accounts (RS256)
// ---------------------------------------------------------------------------

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildServiceAccountJwt(key: ServiceAccountKey, scopes: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: scopes,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );

  const signingInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = base64url(sign.sign(key.private_key));

  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// GoogleDocsKnowledgeProvider
// ---------------------------------------------------------------------------

export class GoogleDocsKnowledgeProvider implements KnowledgeSourceProvider {
  readonly sourceType = "google-docs";
  readonly sourceName: string;

  private readonly driveFolderId?: string;
  private readonly documentIds?: string[];
  private readonly accessToken?: string;
  private readonly serviceAccountKey?: ServiceAccountKey;
  private readonly fetchFn: FetchFn;
  private readonly retryService: IntelligentRetryService;

  /** Cached service account token */
  private tokenCache: CachedToken | null = null;

  private static readonly DRIVE_SCOPES =
    "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly";

  constructor(sourceName: string, options: GoogleDocsProviderOptions) {
    this.sourceName = sourceName;
    this.driveFolderId = options.driveFolderId;
    this.documentIds = options.documentIds;
    this.accessToken = options.accessToken;
    this.serviceAccountKey = options.serviceAccountKey;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.retryService =
      options.retryService ?? new IntelligentRetryService({ maxRetries: 3, baseDelay: 350 });

    if (!this.driveFolderId && (!this.documentIds || this.documentIds.length === 0)) {
      throw new Error(
        `GoogleDocsKnowledgeProvider "${sourceName}" requires either "driveFolderId" or "documentIds" to be specified.`
      );
    }

    if (!this.accessToken && !this.serviceAccountKey) {
      throw new Error(
        `GoogleDocsKnowledgeProvider "${sourceName}" requires either an "accessToken" or a "serviceAccountKey".`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async *listDocuments(_options?: ListOptions): AsyncIterable<KnowledgeDocument> {
    if (this.driveFolderId) {
      yield* this.walkFolder(this.driveFolderId);
    } else if (this.documentIds && this.documentIds.length > 0) {
      for (const docId of this.documentIds) {
        yield await this.fetchDocument(docId);
      }
    }
  }

  async fetchDocument(id: string): Promise<KnowledgeDocument> {
    // Fetch file metadata
    const file = await this.getFileMeta(id);

    // Export document content as markdown (fallback to plain text)
    const content = await this.exportDocument(id);

    return {
      id: file.id,
      title: file.name,
      content,
      url: file.webViewLink ?? `https://docs.google.com/document/d/${id}/edit`,
      lastModified: new Date(file.modifiedTime),
      metadata: {
        createdTime: file.createdTime,
        mimeType: file.mimeType,
        sourceType: "google-docs",
        sourceName: this.sourceName,
      },
    };
  }

  async *getChangedSince(since: Date, _options?: ListOptions): AsyncIterable<KnowledgeDocument> {
    const isoSince = since.toISOString();

    if (this.driveFolderId) {
      // Use Drive's modifiedTime filter to avoid re-walking the tree
      const q = `'${this.driveFolderId}' in parents and mimeType='${DOCS_MIME_TYPE}' and modifiedTime > '${isoSince}' and trashed=false`;
      yield* this.listFilesWithQuery(q, true);
    } else if (this.documentIds && this.documentIds.length > 0) {
      // For explicit doc list, fetch metadata and filter by modifiedTime
      for (const docId of this.documentIds) {
        const file = await this.getFileMeta(docId);
        if (new Date(file.modifiedTime) > since) {
          const content = await this.exportDocument(docId);
          yield {
            id: file.id,
            title: file.name,
            content,
            url: file.webViewLink ?? `https://docs.google.com/document/d/${docId}/edit`,
            lastModified: new Date(file.modifiedTime),
            metadata: {
              createdTime: file.createdTime,
              mimeType: file.mimeType,
              sourceType: "google-docs",
              sourceName: this.sourceName,
            },
          };
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal traversal
  // -------------------------------------------------------------------------

  private async *walkFolder(folderId: string): AsyncIterable<KnowledgeDocument> {
    // List all Docs files in this folder (non-recursive first)
    const docsQuery = `'${folderId}' in parents and mimeType='${DOCS_MIME_TYPE}' and trashed=false`;
    yield* this.listFilesWithQuery(docsQuery, false);

    // Recurse into sub-folders
    const foldersQuery = `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const subFolders = await this.listAllFiles(foldersQuery);
    for (const folder of subFolders) {
      yield* this.walkFolder(folder.id);
    }
  }

  private async *listFilesWithQuery(
    q: string,
    flatList: boolean
  ): AsyncIterable<KnowledgeDocument> {
    const files = await this.listAllFiles(q);
    for (const file of files) {
      if (flatList) {
        yield await this.fetchDocument(file.id);
      } else {
        const content = await this.exportDocument(file.id);
        yield {
          id: file.id,
          title: file.name,
          content,
          url: file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`,
          lastModified: new Date(file.modifiedTime),
          metadata: {
            createdTime: file.createdTime,
            mimeType: file.mimeType,
            sourceType: "google-docs",
            sourceName: this.sourceName,
          },
        };
      }
    }
  }

  private async listAllFiles(q: string): Promise<DriveFile[]> {
    const all: DriveFile[] = [];
    let pageToken: string | undefined;

    while (true) {
      const params = new URLSearchParams({
        q,
        fields:
          "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink,parents)",
        pageSize: "100",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const url = `${DRIVE_API_BASE}/files?${params.toString()}`;
      const resp = await this.apiGet<DriveFilesListResponse>(url);
      all.push(...resp.files);

      if (!resp.nextPageToken) break;
      pageToken = resp.nextPageToken;
    }

    return all;
  }

  // -------------------------------------------------------------------------
  // API helpers
  // -------------------------------------------------------------------------

  private async getFileMeta(fileId: string): Promise<DriveFile> {
    const params = new URLSearchParams({
      fields: "id,name,mimeType,modifiedTime,createdTime,webViewLink,parents",
    });
    const url = `${DRIVE_API_BASE}/files/${fileId}?${params.toString()}`;
    return this.apiGet<DriveFile>(url);
  }

  private async exportDocument(fileId: string): Promise<string> {
    // Try markdown export first, fall back to plain text
    const markdownUrl = `${DOCS_EXPORT_BASE}/${fileId}/export?mimeType=${encodeURIComponent("text/markdown")}`;
    try {
      return await this.apiGetText(markdownUrl);
    } catch {
      const plainUrl = `${DOCS_EXPORT_BASE}/${fileId}/export?mimeType=${encodeURIComponent("text/plain")}`;
      return this.apiGetText(plainUrl);
    }
  }

  private async apiGet<T>(url: string): Promise<T> {
    return this.retryService.execute(
      async () => {
        const token = await this.resolveToken();
        const resp = await this.fetchFn(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        // On 401, invalidate cached token so next retry gets a fresh one
        if (resp.status === 401) {
          this.tokenCache = null;
        }

        return this.handleJsonResponse<T>(resp);
      },
      isRetryableGoogleDocsError,
      "google-docs"
    );
  }

  private async apiGetText(url: string): Promise<string> {
    return this.retryService.execute(
      async () => {
        const token = await this.resolveToken();
        const resp = await this.fetchFn(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        if (resp.status === 401) {
          this.tokenCache = null;
        }

        return this.handleTextResponse(resp);
      },
      isRetryableGoogleDocsError,
      "google-docs"
    );
  }

  // -------------------------------------------------------------------------
  // Auth: resolve access token (direct or service account)
  // -------------------------------------------------------------------------

  private async resolveToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    // Service account path: use cached token if still valid (5-min safety buffer)
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - now > 5 * 60 * 1000) {
      return this.tokenCache.accessToken;
    }

    return this.fetchServiceAccountToken();
  }

  private async fetchServiceAccountToken(): Promise<string> {
    if (!this.serviceAccountKey) {
      throw new Error("No auth credentials configured for GoogleDocsKnowledgeProvider.");
    }

    const jwt = buildServiceAccountJwt(
      this.serviceAccountKey,
      GoogleDocsKnowledgeProvider.DRIVE_SCOPES
    );

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });

    const resp = await this.fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `Google OAuth2 token exchange failed: ${resp.status} ${resp.statusText} ${text}`.trim()
      );
    }

    const data = (await resp.json()) as GoogleTokenResponse;
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return data.access_token;
  }

  // -------------------------------------------------------------------------
  // Response helpers
  // -------------------------------------------------------------------------

  private async handleJsonResponse<T>(resp: Response): Promise<T> {
    if (!resp.ok) {
      let extra = "";
      try {
        const json = (await resp.json()) as {
          error?: { message?: string; errors?: Array<{ reason?: string }> };
        };
        const err = json.error;
        const parts: string[] = [];
        if (err?.message) parts.push(`message=${err.message}`);
        const reason = err?.errors?.[0]?.reason;
        if (reason) parts.push(`reason=${reason}`);
        extra = parts.length > 0 ? ` - ${parts.join(", ")}` : "";
      } catch {
        extra = await resp.text().catch(() => "");
      }
      throw new Error(`Google Drive API error: ${resp.status} ${resp.statusText}${extra}`);
    }
    return resp.json() as Promise<T>;
  }

  private async handleTextResponse(resp: Response): Promise<string> {
    if (!resp.ok) {
      let extra = "";
      try {
        const json = (await resp.json()) as {
          error?: { message?: string; errors?: Array<{ reason?: string }> };
        };
        const err = json.error;
        const parts: string[] = [];
        if (err?.message) parts.push(`message=${err.message}`);
        const reason = err?.errors?.[0]?.reason;
        if (reason) parts.push(`reason=${reason}`);
        extra = parts.length > 0 ? ` - ${parts.join(", ")}` : "";
      } catch {
        extra = await resp.text().catch(() => "");
      }
      throw new Error(`Google Docs API error: ${resp.status} ${resp.statusText}${extra}`);
    }
    return resp.text();
  }
}
