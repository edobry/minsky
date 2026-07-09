import { describe, expect, test } from "bun:test";

import { InMemoryTranscriptArchiveStore } from "./memory-transcript-archive-store";
import {
  SupabaseTranscriptArchiveStore,
  type StorageBucketApiLike,
  type StorageClientLike,
} from "./supabase-transcript-archive-store";
import {
  TranscriptArchiveError,
  TranscriptArchiveVerificationError,
  compareVersionsNewestFirst,
  encodeContent,
  parseTranscriptArchiveKey,
  sha256Hex,
  transcriptArchiveKey,
  type TranscriptArchiveVersion,
} from "./transcript-archive-store";

const HARNESS = "claude_code";
const SESSION_ID = "3f1c2d4e-0000-4000-8000-000000000001";

function shaOf(content: string): string {
  return sha256Hex(encodeContent(content));
}

function requirePresent<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${label} to be present`);
  return value;
}

describe("key layout helpers", () => {
  test("transcriptArchiveKey builds {harness}/{sessionId}/{sha}.jsonl", () => {
    const sha = shaOf("line1\n");
    expect(transcriptArchiveKey(HARNESS, SESSION_ID, sha)).toBe(
      `${HARNESS}/${SESSION_ID}/${sha}.jsonl`
    );
  });

  test("rejects path-unsafe segments", () => {
    const sha = shaOf("x");
    expect(() => transcriptArchiveKey("a/b", SESSION_ID, sha)).toThrow(TranscriptArchiveError);
    expect(() => transcriptArchiveKey(HARNESS, "..", sha)).toThrow(TranscriptArchiveError);
    expect(() => transcriptArchiveKey(HARNESS, "", sha)).toThrow(TranscriptArchiveError);
  });

  test("rejects malformed sha", () => {
    expect(() => transcriptArchiveKey(HARNESS, SESSION_ID, "abc")).toThrow(TranscriptArchiveError);
    expect(() => transcriptArchiveKey(HARNESS, SESSION_ID, "Z".repeat(64))).toThrow(
      TranscriptArchiveError
    );
  });

  test("parseTranscriptArchiveKey round-trips and rejects garbage", () => {
    const sha = shaOf("content");
    const key = transcriptArchiveKey(HARNESS, SESSION_ID, sha);
    expect(parseTranscriptArchiveKey(key)).toEqual({
      harness: HARNESS,
      agentSessionId: SESSION_ID,
      sha256: sha,
    });
    expect(parseTranscriptArchiveKey("not-a-key")).toBeNull();
    expect(parseTranscriptArchiveKey(`${HARNESS}/${SESSION_ID}/short.jsonl`)).toBeNull();
  });

  test("compareVersionsNewestFirst orders by bytes desc then createdAt desc", () => {
    const v = (key: string, bytes: number | null, createdAt: string | null) =>
      ({ key, sha256: "0".repeat(64), bytes, createdAt }) as TranscriptArchiveVersion;
    const sorted = [
      v("small", 10, "2026-07-08T00:00:00Z"),
      v("big", 300, "2026-07-01T00:00:00Z"),
      v("mid-new", 50, "2026-07-08T00:00:00Z"),
      v("mid-old", 50, "2026-07-01T00:00:00Z"),
    ].sort(compareVersionsNewestFirst);
    expect(sorted.map((x) => x.key)).toEqual(["big", "mid-new", "mid-old", "small"]);
  });
});

describe("InMemoryTranscriptArchiveStore (fake contract)", () => {
  test("putRaw stores content-addressed and returns a verified ref", async () => {
    const store = new InMemoryTranscriptArchiveStore();
    const content = '{"type":"user"}\n{"type":"assistant"}\n';
    const ref = await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content });
    expect(ref.sha256).toBe(shaOf(content));
    expect(ref.bytes).toBe(encodeContent(content).length);
    expect(ref.key).toBe(transcriptArchiveKey(HARNESS, SESSION_ID, ref.sha256));
    expect(ref.alreadyExisted).toBe(false);
  });

  test("re-put of identical content is idempotent", async () => {
    const store = new InMemoryTranscriptArchiveStore();
    const content = "same content\n";
    const first = await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content });
    const second = await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content });
    expect(second.key).toBe(first.key);
    expect(second.alreadyExisted).toBe(true);
    expect(store.size).toBe(1);
  });

  test("getRaw round-trips bytes exactly", async () => {
    const store = new InMemoryTranscriptArchiveStore();
    const content = "line-a\nline-b\nline-c\n";
    const ref = await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content });
    const bytes = await store.getRaw(ref.key);
    expect(new TextDecoder().decode(bytes)).toBe(content);
  });

  test("getRaw fails integrity check on corrupted object", async () => {
    const store = new InMemoryTranscriptArchiveStore();
    const key = transcriptArchiveKey(HARNESS, SESSION_ID, shaOf("original"));
    store.setObjectForTest(key, encodeContent("tampered"));
    await expect(store.getRaw(key)).rejects.toThrow(TranscriptArchiveVerificationError);
  });

  test("head reports existence and size", async () => {
    const store = new InMemoryTranscriptArchiveStore();
    const ref = await store.putRaw({
      agentSessionId: SESSION_ID,
      harness: HARNESS,
      content: "abc",
    });
    expect(await store.head(ref.key)).toMatchObject({ exists: true, bytes: 3 });
    expect(
      await store.head(transcriptArchiveKey(HARNESS, SESSION_ID, "f".repeat(64)))
    ).toMatchObject({ exists: false, bytes: null });
  });

  test("listVersions returns newest-complete (largest) first", async () => {
    const store = new InMemoryTranscriptArchiveStore();
    await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content: "short\n" });
    await store.putRaw({
      agentSessionId: SESSION_ID,
      harness: HARNESS,
      content: "short\nplus more appended content\n",
    });
    await store.putRaw({ agentSessionId: "other-session", harness: HARNESS, content: "zzz" });
    const versions = await store.listVersions(HARNESS, SESSION_ID);
    expect(versions).toHaveLength(2);
    const first = requirePresent(versions[0], "versions[0]");
    const second = requirePresent(versions[1], "versions[1]");
    expect(first.bytes).toBeGreaterThan(requirePresent(second.bytes, "versions[1].bytes"));
  });

  test("rejects empty content and unsafe segments", async () => {
    const store = new InMemoryTranscriptArchiveStore();
    await expect(
      store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content: "" })
    ).rejects.toThrow(TranscriptArchiveError);
    await expect(
      store.putRaw({ agentSessionId: "../etc", harness: HARNESS, content: "x" })
    ).rejects.toThrow(TranscriptArchiveError);
  });
});

// ---------------------------------------------------------------------------
// SupabaseTranscriptArchiveStore against a stubbed StorageClient
// ---------------------------------------------------------------------------

interface StubEntry {
  bytes: Uint8Array;
  createdAt: string;
}

class StubStorage implements StorageClientLike, StorageBucketApiLike {
  objects = new Map<string, StubEntry>();

  uploadCalls: Array<{ path: string; options?: Record<string, unknown> }> = [];

  /** When set, upload returns this error instead of storing. */
  uploadError: { message: string; statusCode?: string } | null = null;

  /** When true, list responses omit size metadata (exercises download fallback). */
  omitSizeMetadata = false;

  /** When set, download returns these bytes regardless of the stored object. */
  downloadOverride: Uint8Array | null = null;

  from(_bucket: string): StorageBucketApiLike {
    return this;
  }

  async upload(
    path: string,
    body: Uint8Array,
    options?: { contentType?: string; upsert?: boolean; metadata?: Record<string, string> }
  ) {
    this.uploadCalls.push({ path, options: options as Record<string, unknown> });
    if (this.uploadError) return { data: null, error: this.uploadError };
    if (this.objects.has(path)) {
      return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
    }
    this.objects.set(path, { bytes: body.slice(), createdAt: "2026-07-08T00:00:00.000Z" });
    return { data: { path }, error: null };
  }

  async download(path: string) {
    const entry = this.objects.get(path);
    const bytes = this.downloadOverride ?? entry?.bytes;
    if (!bytes) return { data: null, error: { message: "Object not found" } };
    return { data: new Blob([bytes.slice() as unknown as BlobPart]), error: null };
  }

  async list(path?: string, options?: { search?: string; limit?: number }) {
    const dir = path ?? "";
    const entries: Array<{
      name: string;
      created_at: string;
      metadata: Record<string, unknown> | null;
    }> = [];
    for (const [key, entry] of this.objects) {
      if (!key.startsWith(`${dir}/`)) continue;
      const name = key.slice(dir.length + 1);
      if (name.includes("/")) continue;
      if (options?.search && !name.includes(options.search)) continue;
      entries.push({
        name,
        created_at: entry.createdAt,
        metadata: this.omitSizeMetadata ? null : { size: entry.bytes.length },
      });
    }
    return { data: entries, error: null };
  }
}

describe("SupabaseTranscriptArchiveStore (stubbed client)", () => {
  const content = '{"uuid":"u1"}\n';

  function makeStore(): { store: SupabaseTranscriptArchiveStore; stub: StubStorage } {
    const stub = new StubStorage();
    const store = new SupabaseTranscriptArchiveStore({ storage: stub, bucket: "test-bucket" });
    return { store, stub };
  }

  test("putRaw uploads immutably (upsert:false) and verifies via listing", async () => {
    const { store, stub } = makeStore();
    const ref = await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content });
    expect(ref.alreadyExisted).toBe(false);
    expect(stub.uploadCalls).toHaveLength(1);
    const call = requirePresent(stub.uploadCalls[0], "uploadCalls[0]");
    expect(call.options).toMatchObject({
      upsert: false,
      contentType: "application/x-ndjson",
    });
    expect(await store.head(ref.key)).toMatchObject({ exists: true, bytes: ref.bytes });
  });

  test("409 already-exists resolves as idempotent success", async () => {
    const { store } = makeStore();
    const first = await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content });
    const second = await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content });
    expect(second.key).toBe(first.key);
    expect(second.alreadyExisted).toBe(true);
  });

  test("non-409 upload error throws TranscriptArchiveError", async () => {
    const { store, stub } = makeStore();
    stub.uploadError = { message: "service unavailable", statusCode: "503" };
    await expect(
      store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content })
    ).rejects.toThrow(TranscriptArchiveError);
  });

  test("upload that cannot be read back throws VerificationError", async () => {
    const { store, stub } = makeStore();
    // Upload "succeeds" but the object vanishes before verification.
    const originalUpload = stub.upload.bind(stub);
    stub.upload = async (path, body, options) => {
      const result = await originalUpload(path, body, options);
      stub.objects.delete(path);
      return result;
    };
    await expect(
      store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content })
    ).rejects.toThrow(TranscriptArchiveVerificationError);
  });

  test("size mismatch on read-back throws VerificationError", async () => {
    const { store, stub } = makeStore();
    const originalUpload = stub.upload.bind(stub);
    stub.upload = async (path, body, options) => {
      const result = await originalUpload(path, body, options);
      const stored = stub.objects.get(path);
      if (stored) stub.objects.set(path, { ...stored, bytes: stored.bytes.slice(0, 3) });
      return result;
    };
    await expect(
      store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content })
    ).rejects.toThrow(TranscriptArchiveVerificationError);
  });

  test("missing size metadata falls back to download+hash verification", async () => {
    const { store, stub } = makeStore();
    stub.omitSizeMetadata = true;
    const ref = await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content });
    expect(ref.sha256).toBe(shaOf(content));
  });

  test("getRaw verifies downloaded bytes against the key's sha", async () => {
    const { store, stub } = makeStore();
    const ref = await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content });
    stub.downloadOverride = encodeContent("tampered content");
    await expect(store.getRaw(ref.key)).rejects.toThrow(TranscriptArchiveVerificationError);
  });

  test("legacy format uploads as application/json", async () => {
    const { store, stub } = makeStore();
    await store.putRaw({
      agentSessionId: SESSION_ID,
      harness: "legacy",
      content: '[{"type":"message"}]',
      format: "legacy-transcript-message",
      source: "backfill-pg-blob",
    });
    const call = requirePresent(stub.uploadCalls[0], "uploadCalls[0]");
    expect(call.options).toMatchObject({ contentType: "application/json" });
    expect(call.options?.["metadata"]).toMatchObject({
      format: "legacy-transcript-message",
      source: "backfill-pg-blob",
    });
  });

  test("listVersions maps listing entries newest-complete first", async () => {
    const { store } = makeStore();
    await store.putRaw({ agentSessionId: SESSION_ID, harness: HARNESS, content: "short\n" });
    await store.putRaw({
      agentSessionId: SESSION_ID,
      harness: HARNESS,
      content: "short\nplus appended\n",
    });
    const versions = await store.listVersions(HARNESS, SESSION_ID);
    expect(versions).toHaveLength(2);
    const first = requirePresent(versions[0], "versions[0]");
    const second = requirePresent(versions[1], "versions[1]");
    expect(first.bytes).toBeGreaterThan(requirePresent(second.bytes, "versions[1].bytes"));
    expect(parseTranscriptArchiveKey(first.key)).not.toBeNull();
  });
});
