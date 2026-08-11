/**
 * Supabase Storage implementation of TranscriptArchiveStore (mt#2680).
 *
 * Talks to a PRIVATE bucket via the service-role key (trusted-server
 * pattern per Supabase's storage access-control docs — no public URLs;
 * clients needing time-limited access mint signed URLs server-side).
 *
 * The StorageClient surface is injected as a narrow structural type so unit
 * tests can stub it; production wiring uses `fromCredentials()`.
 */

import { StorageClient } from "@supabase/storage-js";

import {
  DEFAULT_TRANSCRIPT_ARCHIVE_BUCKET,
  TranscriptArchiveError,
  TranscriptArchiveVerificationError,
  compareVersionsNewestFirst,
  contentTypeForFormat,
  encodeContent,
  parseTranscriptArchiveKey,
  sha256Hex,
  transcriptArchiveKey,
  type TranscriptArchiveHead,
  type TranscriptArchiveObjectRef,
  type TranscriptArchivePutInput,
  type TranscriptArchiveStore,
  type TranscriptArchiveVersion,
} from "./transcript-archive-store";

interface StorageErrorLike {
  message: string;
  statusCode?: string | number;
}

interface StorageListEntryLike {
  name: string;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Narrow structural slice of @supabase/storage-js used by this store. */
export interface StorageBucketApiLike {
  upload(
    path: string,
    body: Uint8Array,
    options?: {
      contentType?: string;
      upsert?: boolean;
      metadata?: Record<string, string>;
    }
  ): Promise<{ data: { path: string } | null; error: StorageErrorLike | null }>;
  download(path: string): Promise<{ data: Blob | null; error: StorageErrorLike | null }>;
  list(
    path?: string,
    options?: {
      limit?: number;
      offset?: number;
      search?: string;
      sortBy?: { column: string; order: string };
    }
  ): Promise<{ data: StorageListEntryLike[] | null; error: StorageErrorLike | null }>;
}

export interface StorageClientLike {
  from(bucket: string): StorageBucketApiLike;
}

export interface SupabaseTranscriptArchiveStoreOptions {
  storage: StorageClientLike;
  bucket?: string;
}

function isAlreadyExistsError(error: StorageErrorLike): boolean {
  const code = String(error.statusCode ?? "");
  return code === "409" || /already exists|duplicate/i.test(error.message);
}

function sizeFromListMetadata(metadata: Record<string, unknown> | null | undefined): number | null {
  if (!metadata) return null;
  const candidate = metadata["size"] ?? metadata["contentLength"];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

export class SupabaseTranscriptArchiveStore implements TranscriptArchiveStore {
  private readonly storage: StorageClientLike;

  private readonly bucket: string;

  constructor(options: SupabaseTranscriptArchiveStoreOptions) {
    this.storage = options.storage;
    this.bucket = options.bucket ?? DEFAULT_TRANSCRIPT_ARCHIVE_BUCKET;
  }

  /**
   * Production wiring: project URL (https://<ref>.supabase.co) + service-role
   * key. The service-role key is a secret — it must come from config
   * (`supabase.serviceRoleKey`), never be logged, and is masked by
   * `src/utils/redaction.ts`.
   */
  static fromCredentials(options: {
    url: string;
    serviceRoleKey: string;
    bucket?: string;
  }): SupabaseTranscriptArchiveStore {
    const base = options.url.replace(/\/+$/, "");
    const storage: StorageClientLike = new StorageClient(`${base}/storage/v1`, {
      apikey: options.serviceRoleKey,
      Authorization: `Bearer ${options.serviceRoleKey}`,
    });
    return new SupabaseTranscriptArchiveStore({
      storage,
      bucket: options.bucket,
    });
  }

  async putRaw(input: TranscriptArchivePutInput): Promise<TranscriptArchiveObjectRef> {
    const bytes = encodeContent(input.content);
    if (bytes.length === 0) {
      throw new TranscriptArchiveError(
        `refusing to archive empty content for ${input.harness}/${input.agentSessionId}`
      );
    }
    const sha256 = sha256Hex(bytes);
    const key = transcriptArchiveKey(input.harness, input.agentSessionId, sha256);
    const format = input.format ?? "raw-jsonl";

    const api = this.storage.from(this.bucket);
    const upload = await api.upload(key, bytes, {
      contentType: contentTypeForFormat(format),
      upsert: false,
      metadata: {
        agentSessionId: input.agentSessionId,
        harness: input.harness,
        format,
        ...(input.source ? { source: input.source } : {}),
      },
    });

    let alreadyExisted = false;
    if (upload.error) {
      if (isAlreadyExistsError(upload.error)) {
        alreadyExisted = true;
      } else {
        throw new TranscriptArchiveError(
          `archive upload failed for ${key}: ${upload.error.message}`
        );
      }
    }

    // Durable confirmation: never report success without reading the object
    // back. Size from listing when available; full download+hash when not.
    const stat = await this.head(key);
    if (!stat.exists) {
      throw new TranscriptArchiveVerificationError(
        `upload of ${key} reported success but the object is not listable`
      );
    }
    if (stat.bytes === null) {
      // Listing carried no size — fall back to the strongest check.
      await this.getRaw(key);
    } else if (stat.bytes !== bytes.length) {
      throw new TranscriptArchiveVerificationError(
        `stored object ${key} size mismatch: local=${bytes.length} remote=${stat.bytes}`
      );
    }

    return { key, sha256, bytes: bytes.length, alreadyExisted };
  }

  async getRaw(key: string): Promise<Uint8Array> {
    const download = await this.storage.from(this.bucket).download(key);
    if (download.error || !download.data) {
      throw new TranscriptArchiveError(
        `archive download failed for ${key}: ${download.error?.message ?? "no data"}`
      );
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    const parsed = parseTranscriptArchiveKey(key);
    if (parsed) {
      const actual = sha256Hex(bytes);
      if (actual !== parsed.sha256) {
        throw new TranscriptArchiveVerificationError(
          `downloaded object ${key} failed integrity check: sha256=${actual}`
        );
      }
    }
    return bytes;
  }

  async head(key: string): Promise<TranscriptArchiveHead> {
    const lastSlash = key.lastIndexOf("/");
    const dir = lastSlash === -1 ? "" : key.slice(0, lastSlash);
    const name = lastSlash === -1 ? key : key.slice(lastSlash + 1);
    const listed = await this.storage.from(this.bucket).list(dir, {
      search: name,
      limit: 100,
    });
    if (listed.error) {
      throw new TranscriptArchiveError(`archive list failed for ${dir}: ${listed.error.message}`);
    }
    const entry = (listed.data ?? []).find((candidate) => candidate.name === name);
    if (!entry) return { exists: false, bytes: null, createdAt: null };
    return {
      exists: true,
      bytes: sizeFromListMetadata(entry.metadata),
      createdAt: entry.created_at ?? null,
    };
  }

  async listVersions(harness: string, agentSessionId: string): Promise<TranscriptArchiveVersion[]> {
    // Reuse the key builder's segment validation (the sha argument is a
    // placeholder; only the prefix is used).
    const placeholder = transcriptArchiveKey(harness, agentSessionId, "0".repeat(64));
    const dir = placeholder.slice(0, placeholder.lastIndexOf("/"));
    const listed = await this.storage.from(this.bucket).list(dir, { limit: 1000 });
    if (listed.error) {
      throw new TranscriptArchiveError(`archive list failed for ${dir}: ${listed.error.message}`);
    }
    const versions: TranscriptArchiveVersion[] = [];
    for (const entry of listed.data ?? []) {
      const parsed = parseTranscriptArchiveKey(`${dir}/${entry.name}`);
      if (!parsed) continue;
      versions.push({
        key: `${dir}/${entry.name}`,
        sha256: parsed.sha256,
        bytes: sizeFromListMetadata(entry.metadata),
        createdAt: entry.created_at ?? null,
      });
    }
    return versions.sort(compareVersionsNewestFirst);
  }
}
