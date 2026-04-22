import { describe, it, expect } from "bun:test";
import { GoogleDocsKnowledgeProvider } from "./google-docs-provider";
import type { FetchFn, GoogleDocsProviderOptions } from "./google-docs-provider";
import { IntelligentRetryService } from "../../ai/intelligent-retry-service";
import { generateKeyPairSync } from "crypto";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface DriveFileShape {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime: string;
  createdTime?: string;
  webViewLink?: string;
  parents?: string[];
}

function makeDoc(
  id: string,
  name: string,
  modifiedTime = "2026-01-01T00:00:00.000Z"
): DriveFileShape {
  return {
    id,
    name,
    mimeType: "application/vnd.google-apps.document",
    modifiedTime,
    createdTime: "2024-01-01T00:00:00.000Z",
    webViewLink: `https://docs.google.com/document/d/${id}/edit`,
    parents: [],
  };
}

function makeFolder(id: string, name: string): DriveFileShape {
  return {
    id,
    name,
    mimeType: "application/vnd.google-apps.folder",
    modifiedTime: "2026-01-01T00:00:00.000Z",
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

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async json() {
      throw new Error("not json");
    },
    async text() {
      return body;
    },
    headers: new Headers(),
  } as unknown as Response;
}

/**
 * Track every request the provider issues. Returns a fetch function and an array of
 * captured URLs (plus bodies for POSTs).
 */
interface Capture {
  url: string;
  method?: string;
  body?: string;
}

function makeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetch: FetchFn;
  calls: Capture[];
} {
  const calls: Capture[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const bodyStr = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method: init?.method, body: bodyStr });
    return handler(url, init);
  };
  return { fetch: fetchFn, calls };
}

/**
 * Provider factory with fast no-retry retry service (keeps tests deterministic).
 */
function makeProvider(
  options: Omit<GoogleDocsProviderOptions, "retryService"> & {
    retryService?: IntelligentRetryService;
  }
): GoogleDocsKnowledgeProvider {
  return new GoogleDocsKnowledgeProvider("test-source", {
    ...options,
    retryService:
      options.retryService ?? new IntelligentRetryService({ maxRetries: 2, baseDelay: 1 }),
  });
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("GoogleDocsKnowledgeProvider — constructor", () => {
  it("requires driveFolderId or documentIds", () => {
    expect(() =>
      makeProvider({
        accessToken: "token",
        fetch: async () => jsonResponse({}),
      })
    ).toThrow(/"driveFolderId" or "documentIds"/);
  });

  it("rejects empty documentIds array", () => {
    expect(() =>
      makeProvider({
        accessToken: "token",
        documentIds: [],
        fetch: async () => jsonResponse({}),
      })
    ).toThrow(/"driveFolderId" or "documentIds"/);
  });

  it("requires accessToken or serviceAccountKey", () => {
    expect(() =>
      makeProvider({
        documentIds: ["doc-1"],
        fetch: async () => jsonResponse({}),
      })
    ).toThrow(/"accessToken" or a "serviceAccountKey"/);
  });

  it("constructs successfully with driveFolderId + accessToken", () => {
    const provider = makeProvider({
      accessToken: "tok",
      driveFolderId: "folder-abc",
      fetch: async () => jsonResponse({}),
    });
    expect(provider.sourceType).toBe("google-docs");
    expect(provider.sourceName).toBe("test-source");
  });
});

// ---------------------------------------------------------------------------
// listDocuments — driveFolderId
// ---------------------------------------------------------------------------

describe("GoogleDocsKnowledgeProvider — listDocuments with driveFolderId", () => {
  it("lists all docs in a flat folder", async () => {
    const docsByFolder: Record<string, DriveFileShape[]> = {
      "folder-1": [makeDoc("doc-a", "Doc A"), makeDoc("doc-b", "Doc B")],
    };

    const { fetch } = makeFetch(async (url) => {
      if (url.includes("/files?") && url.includes("mimeType%3D%27application")) {
        // files list
        const folderMatch = url.match(/%27([^%]+)%27\+in\+parents/);
        const folderId = folderMatch?.[1];

        if (url.includes("google-apps.folder")) {
          // sub-folder query — return empty
          return jsonResponse({ files: [] });
        }

        // docs query
        return jsonResponse({ files: folderId ? (docsByFolder[folderId] ?? []) : [] });
      }

      if (url.match(/\/files\/[^/?]+\?/)) {
        // Individual file metadata
        const idMatch = url.match(/\/files\/([^/?]+)\?/);
        const id = idMatch?.[1] ?? "unknown";
        const doc = Object.values(docsByFolder)
          .flat()
          .find((d) => d.id === id);
        return doc ? jsonResponse(doc) : jsonResponse({ error: "not found" }, 404);
      }

      if (url.includes("/export?")) {
        return textResponse(`# Content of ${url.split("/files/")[1]?.split("/")[0] ?? ""}`);
      }

      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider({
      accessToken: "tok",
      driveFolderId: "folder-1",
      fetch,
    });

    const docs: Array<{ id: string; title: string }> = [];
    for await (const d of provider.listDocuments()) {
      docs.push({ id: d.id, title: d.title });
    }

    expect(docs.length).toBe(2);
    expect(docs.map((d) => d.id).sort()).toEqual(["doc-a", "doc-b"]);
  });

  it("recurses into sub-folders", async () => {
    const { fetch } = makeFetch(async (url) => {
      if (url.includes("/files?")) {
        // Determine whether we're querying docs or folders
        if (url.includes("google-apps.folder")) {
          // Parent folder-1 has one sub-folder; folder-child has none
          if (url.includes("folder-1")) {
            return jsonResponse({ files: [makeFolder("folder-child", "Child")] });
          }
          return jsonResponse({ files: [] });
        }

        // docs query
        if (url.includes("folder-1")) {
          return jsonResponse({ files: [makeDoc("top-doc", "Top")] });
        }
        if (url.includes("folder-child")) {
          return jsonResponse({ files: [makeDoc("child-doc", "Child Doc")] });
        }
        return jsonResponse({ files: [] });
      }

      if (url.includes("/export?")) {
        return textResponse("# exported");
      }

      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider({
      accessToken: "tok",
      driveFolderId: "folder-1",
      fetch,
    });

    const ids: string[] = [];
    for await (const d of provider.listDocuments()) {
      ids.push(d.id);
    }

    expect(ids.sort()).toEqual(["child-doc", "top-doc"]);
  });
});

// ---------------------------------------------------------------------------
// listDocuments — documentIds
// ---------------------------------------------------------------------------

describe("GoogleDocsKnowledgeProvider — listDocuments with documentIds", () => {
  it("fetches only the listed docs", async () => {
    const { fetch, calls } = makeFetch(async (url) => {
      if (url.match(/\/files\/[^/?]+\?/) && !url.includes("/export")) {
        const id = url.match(/\/files\/([^/?]+)\?/)?.[1] ?? "unknown";
        return jsonResponse(makeDoc(id, `Doc ${id}`));
      }
      if (url.includes("/export?")) {
        return textResponse("# exported");
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider({
      accessToken: "tok",
      documentIds: ["d1", "d2"],
      fetch,
    });

    const docs: string[] = [];
    for await (const d of provider.listDocuments()) {
      docs.push(d.id);
    }

    expect(docs).toEqual(["d1", "d2"]);
    // No /files? list queries should have been made
    expect(calls.every((c) => !c.url.includes("/files?"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchDocument — markdown export + fallback
// ---------------------------------------------------------------------------

describe("GoogleDocsKnowledgeProvider — fetchDocument", () => {
  it("returns markdown content on successful export", async () => {
    const { fetch, calls } = makeFetch(async (url) => {
      if (url.match(/\/files\/[^/?]+\?/) && !url.includes("/export")) {
        return jsonResponse(makeDoc("doc-md", "My Doc"));
      }
      if (url.includes("mimeType=text%2Fmarkdown")) {
        return textResponse("# Heading\n\nBody");
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider({
      accessToken: "tok",
      documentIds: ["doc-md"],
      fetch,
    });

    const doc = await provider.fetchDocument("doc-md");
    expect(doc.title).toBe("My Doc");
    expect(doc.content).toBe("# Heading\n\nBody");
    expect(doc.url).toBe("https://docs.google.com/document/d/doc-md/edit");
    expect(doc.metadata["sourceType"]).toBe("google-docs");
    expect(doc.metadata["sourceName"]).toBe("test-source");
    // Exactly one markdown export call made; no plain-text fallback
    const exportCalls = calls.filter((c) => c.url.includes("/export?"));
    expect(exportCalls.length).toBe(1);
    expect(exportCalls[0]?.url).toContain("mimeType=text%2Fmarkdown");
  });

  it("falls back to text/plain when markdown export fails", async () => {
    const { fetch, calls } = makeFetch(async (url) => {
      if (url.match(/\/files\/[^/?]+\?/) && !url.includes("/export")) {
        return jsonResponse(makeDoc("doc-broken", "Broken Doc"));
      }
      if (url.includes("mimeType=text%2Fmarkdown")) {
        return jsonResponse(
          { error: { message: "export failed", errors: [{ reason: "exportFailed" }] } },
          500
        );
      }
      if (url.includes("mimeType=text%2Fplain")) {
        return textResponse("Plain body");
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    // Pass a retry service with 0 retries so the 500 short-circuits to the fallback
    const provider = makeProvider({
      accessToken: "tok",
      documentIds: ["doc-broken"],
      fetch,
      retryService: new IntelligentRetryService({ maxRetries: 0, baseDelay: 1 }),
    });

    const doc = await provider.fetchDocument("doc-broken");
    expect(doc.content).toBe("Plain body");
    // Both export URLs should have been attempted
    const mdCalls = calls.filter((c) => c.url.includes("mimeType=text%2Fmarkdown"));
    const plainCalls = calls.filter((c) => c.url.includes("mimeType=text%2Fplain"));
    expect(mdCalls.length).toBeGreaterThanOrEqual(1);
    expect(plainCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getChangedSince — uses modifiedTime filter
// ---------------------------------------------------------------------------

describe("GoogleDocsKnowledgeProvider — getChangedSince", () => {
  it("issues a query containing modifiedTime > '<iso>' and does NOT re-walk folders", async () => {
    const { fetch, calls } = makeFetch(async (url) => {
      if (url.includes("/files?") && !url.includes("google-apps.folder")) {
        return jsonResponse({ files: [makeDoc("changed", "Changed Doc")] });
      }
      if (url.match(/\/files\/[^/?]+\?/) && !url.includes("/export")) {
        const id = url.match(/\/files\/([^/?]+)\?/)?.[1] ?? "x";
        return jsonResponse(makeDoc(id, `Doc ${id}`));
      }
      if (url.includes("/export?")) {
        return textResponse("# updated");
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider({
      accessToken: "tok",
      driveFolderId: "folder-1",
      fetch,
    });

    const since = new Date("2026-01-01T00:00:00.000Z");
    const docs: string[] = [];
    for await (const d of provider.getChangedSince(since)) {
      docs.push(d.id);
    }

    expect(docs).toEqual(["changed"]);

    // Verify the q= parameter included modifiedTime filter
    const listCall = calls.find((c) => c.url.includes("/files?"));
    expect(listCall).toBeTruthy();
    const qMatch = listCall?.url.match(/[?&]q=([^&]+)/);
    expect(qMatch).toBeTruthy();
    const qDecoded = decodeURIComponent(qMatch?.[1] ?? "").replace(/\+/g, " ");
    expect(qDecoded).toContain("modifiedTime > '2026-01-01T00:00:00.000Z'");
    // No folder-listing queries were issued for recursion
    expect(calls.some((c) => c.url.includes("google-apps.folder"))).toBe(false);
  });

  it("with documentIds, filters by modifiedTime client-side", async () => {
    const { fetch } = makeFetch(async (url) => {
      if (url.match(/\/files\/[^/?]+\?/) && !url.includes("/export")) {
        const id = url.match(/\/files\/([^/?]+)\?/)?.[1] ?? "";
        // d1 is old, d2 is recent
        if (id === "d1") return jsonResponse(makeDoc("d1", "Old", "2025-01-01T00:00:00.000Z"));
        if (id === "d2") return jsonResponse(makeDoc("d2", "Recent", "2026-06-01T00:00:00.000Z"));
        return jsonResponse({ error: "unknown" }, 404);
      }
      if (url.includes("/export?")) {
        return textResponse("# content");
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider({
      accessToken: "tok",
      documentIds: ["d1", "d2"],
      fetch,
    });

    const since = new Date("2026-01-01T00:00:00.000Z");
    const ids: string[] = [];
    for await (const d of provider.getChangedSince(since)) {
      ids.push(d.id);
    }

    expect(ids).toEqual(["d2"]);
  });
});

// ---------------------------------------------------------------------------
// Retry behavior
// ---------------------------------------------------------------------------

describe("GoogleDocsKnowledgeProvider — retry behavior", () => {
  it("retries a 429 response and succeeds on the second attempt", async () => {
    let fileAttempts = 0;
    const { fetch } = makeFetch(async (url) => {
      if (url.match(/\/files\/[^/?]+\?/) && !url.includes("/export")) {
        fileAttempts++;
        if (fileAttempts === 1) {
          return jsonResponse(
            { error: { message: "rate limited", errors: [{ reason: "rateLimitExceeded" }] } },
            429
          );
        }
        return jsonResponse(makeDoc("doc-1", "Doc 1"));
      }
      if (url.includes("/export?")) {
        return textResponse("# body");
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider({
      accessToken: "tok",
      documentIds: ["doc-1"],
      fetch,
    });

    const doc = await provider.fetchDocument("doc-1");
    expect(doc.id).toBe("doc-1");
    expect(fileAttempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Service account token exchange
// ---------------------------------------------------------------------------

describe("GoogleDocsKnowledgeProvider — service account auth", () => {
  // Generate a fresh RSA keypair at test runtime (no hardcoded secret material).
  const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  it("exchanges service-account JWT for access token, then uses it in requests", async () => {
    let tokenExchanges = 0;
    let apiCallsWithToken = 0;
    const { fetch } = makeFetch(async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        tokenExchanges++;
        // Verify the body contains the JWT assertion
        expect(init?.body).toContain("grant_type=");
        expect(init?.body).toContain("assertion=");
        return jsonResponse({
          access_token: "svc-token-abc",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }

      if (url.match(/\/files\/[^/?]+\?/) && !url.includes("/export")) {
        const authHeader = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
        if (authHeader === "Bearer svc-token-abc") apiCallsWithToken++;
        return jsonResponse(makeDoc("doc-svc", "Service Doc"));
      }

      if (url.includes("/export?")) {
        return textResponse("# svc");
      }

      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider({
      serviceAccountKey: {
        type: "service_account",
        client_email: "test@example.iam.gserviceaccount.com",
        private_key: TEST_PRIVATE_KEY,
      },
      documentIds: ["doc-svc"],
      fetch,
    });

    const doc = await provider.fetchDocument("doc-svc");
    expect(doc.id).toBe("doc-svc");
    expect(tokenExchanges).toBe(1);
    expect(apiCallsWithToken).toBeGreaterThanOrEqual(1);
  });

  it("caches the service-account token across multiple calls", async () => {
    let tokenExchanges = 0;
    const { fetch } = makeFetch(async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        tokenExchanges++;
        return jsonResponse({
          access_token: "svc-token-cached",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }

      if (url.match(/\/files\/[^/?]+\?/) && !url.includes("/export")) {
        const id = url.match(/\/files\/([^/?]+)\?/)?.[1] ?? "x";
        return jsonResponse(makeDoc(id, `Doc ${id}`));
      }

      if (url.includes("/export?")) {
        return textResponse("# body");
      }

      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = makeProvider({
      serviceAccountKey: {
        type: "service_account",
        client_email: "test@example.iam.gserviceaccount.com",
        private_key: TEST_PRIVATE_KEY,
      },
      documentIds: ["a", "b", "c"],
      fetch,
    });

    for await (const _d of provider.listDocuments()) {
      // consume
    }

    // Only one token exchange despite multiple document fetches
    expect(tokenExchanges).toBe(1);
  });
});
