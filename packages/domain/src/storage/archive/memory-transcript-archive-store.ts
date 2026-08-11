/**
 * In-memory fake of TranscriptArchiveStore (ADR-018 fake pair, mt#2680).
 *
 * Faithful to the real store's semantics: content-addressed keys,
 * idempotent re-put, post-write verification, download integrity check,
 * newest-complete-first version listing. Test seams: `setObjectForTest`
 * lets tests plant corrupted objects to exercise verification failures.
 */

import {
  TranscriptArchiveError,
  TranscriptArchiveVerificationError,
  compareVersionsNewestFirst,
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

interface StoredObject {
  bytes: Uint8Array;
  createdAt: string;
}

export class InMemoryTranscriptArchiveStore implements TranscriptArchiveStore {
  private readonly objects = new Map<string, StoredObject>();

  private readonly now: () => Date;

  constructor(options?: { now?: () => Date }) {
    this.now = options?.now ?? ((): Date => new Date());
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

    const existing = this.objects.get(key);
    const alreadyExisted = existing !== undefined;
    if (!existing) {
      this.objects.set(key, { bytes: bytes.slice(), createdAt: this.now().toISOString() });
    }

    // Mirror the real store's durable-confirmation read-back.
    const stored = this.objects.get(key);
    if (!stored) {
      throw new TranscriptArchiveVerificationError(
        `upload of ${key} reported success but the object is not listable`
      );
    }
    if (stored.bytes.length !== bytes.length) {
      throw new TranscriptArchiveVerificationError(
        `stored object ${key} size mismatch: local=${bytes.length} remote=${stored.bytes.length}`
      );
    }

    return { key, sha256, bytes: bytes.length, alreadyExisted };
  }

  async getRaw(key: string): Promise<Uint8Array> {
    const stored = this.objects.get(key);
    if (!stored) {
      throw new TranscriptArchiveError(`archive download failed for ${key}: not found`);
    }
    const bytes = stored.bytes.slice();
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
    const stored = this.objects.get(key);
    if (!stored) return { exists: false, bytes: null, createdAt: null };
    return { exists: true, bytes: stored.bytes.length, createdAt: stored.createdAt };
  }

  async listVersions(harness: string, agentSessionId: string): Promise<TranscriptArchiveVersion[]> {
    const prefix = `${harness}/${agentSessionId}/`;
    const versions: TranscriptArchiveVersion[] = [];
    for (const [key, stored] of this.objects) {
      if (!key.startsWith(prefix)) continue;
      const parsed = parseTranscriptArchiveKey(key);
      if (!parsed) continue;
      versions.push({
        key,
        sha256: parsed.sha256,
        bytes: stored.bytes.length,
        createdAt: stored.createdAt,
      });
    }
    return versions.sort(compareVersionsNewestFirst);
  }

  /** Test seam: plant an object (e.g. corrupted bytes) under an arbitrary key. */
  setObjectForTest(key: string, bytes: Uint8Array, createdAt?: string): void {
    this.objects.set(key, {
      bytes: bytes.slice(),
      createdAt: createdAt ?? this.now().toISOString(),
    });
  }

  /** Test seam: number of stored objects. */
  get size(): number {
    return this.objects.size;
  }
}
