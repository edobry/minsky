/**
 * Transcript raw-archive store — ADR-025 foundation (mt#2680).
 *
 * The object-store archive holds the raw transcript file for each agent
 * session as the immutable SYSTEM OF RECORD; Postgres is a rebuildable
 * derived index parsed from it. This module defines the domain-owned
 * interface (ADR-018 principle: interface + real impl + fake, DI-injected)
 * plus the content-addressed key layout shared by both implementations.
 *
 * Key layout (decision recorded on mt#2680):
 *
 *   {harness}/{agentSessionId}/{sha256}.jsonl
 *
 * - Content-addressed: the object name is the SHA-256 of the object bytes,
 *   so keys are deterministic, uploads are structurally idempotent, and a
 *   downloaded object is integrity-checkable against its own key.
 * - Objects are IMMUTABLE. A growing session produces a new snapshot object
 *   per capture; nothing is ever overwritten.
 * - "Newest complete version" = largest byte count (transcripts are
 *   append-only), created_at as tiebreak. See listVersions().
 *
 * @see docs/architecture/adr-025-transcript-storage-object-store-system-of-record.md
 * @see docs/architecture/transcript-archive.md
 */

import { createHash } from "node:crypto";

/** Default bucket name; overridable via `transcriptArchive.bucket` config. */
export const DEFAULT_TRANSCRIPT_ARCHIVE_BUCKET = "agent-transcript-archive";

/**
 * Formats an archived object can carry. Legacy rows (`harness='legacy'`)
 * hold a pre-extracted TranscriptMessage[] rather than raw JSONL; the
 * backfill (mt#2682) marks them explicitly so a legacy object is never
 * mistaken for a raw original (ADR-025 §backfill).
 */
export type TranscriptArchiveFormat = "raw-jsonl" | "legacy-transcript-message";

export interface TranscriptArchivePutInput {
  /** Harness-native agent session id (e.g. Claude Code's session UUID). */
  agentSessionId: string;
  /** Source harness discriminator (e.g. "claude_code"). */
  harness: string;
  /** Raw file content. Strings are UTF-8 encoded before hashing/upload. */
  content: Uint8Array | string;
  /** Defaults to "raw-jsonl". The backfill marks legacy blobs explicitly. */
  format?: TranscriptArchiveFormat;
  /** Provenance, e.g. "live-ingest" | "backfill-pg-blob" | "backfill-disk-jsonl". */
  source?: string;
}

export interface TranscriptArchiveObjectRef {
  key: string;
  sha256: string;
  bytes: number;
  /** True when the object already existed (idempotent re-put). */
  alreadyExisted: boolean;
}

export interface TranscriptArchiveVersion {
  key: string;
  sha256: string;
  /** Byte size when the backing store reports it; null otherwise. */
  bytes: number | null;
  createdAt: string | null;
}

export interface TranscriptArchiveHead {
  exists: boolean;
  bytes: number | null;
  createdAt: string | null;
}

/**
 * Domain-owned archive interface (ADR-018: real + fake, DI-injected).
 *
 * Implementations: SupabaseTranscriptArchiveStore (real),
 * InMemoryTranscriptArchiveStore (fake).
 */
export interface TranscriptArchiveStore {
  /**
   * Upload a raw transcript snapshot. Idempotent: re-putting identical
   * content resolves to the existing object. The write is DURABLY VERIFIED
   * before returning (post-upload read-back + size/hash comparison) — this
   * is the fail-safe primitive the upload-then-parse ingest (mt#2681) and
   * the backfill (mt#2682) build on. Throws
   * TranscriptArchiveVerificationError when the stored object cannot be
   * confirmed to match the local content.
   */
  putRaw(input: TranscriptArchivePutInput): Promise<TranscriptArchiveObjectRef>;

  /**
   * Download an object and verify its content hashes to the sha embedded in
   * the key (end-to-end integrity; throws TranscriptArchiveVerificationError
   * on mismatch).
   */
  getRaw(key: string): Promise<Uint8Array>;

  /** Existence + size probe for a specific key. */
  head(key: string): Promise<TranscriptArchiveHead>;

  /**
   * All archived snapshots for a session, newest-complete first: bytes desc
   * (transcripts are append-only, so the largest snapshot is the most
   * complete), createdAt desc as tiebreak.
   */
  listVersions(harness: string, agentSessionId: string): Promise<TranscriptArchiveVersion[]>;
}

export class TranscriptArchiveError extends Error {}

/** The stored object could not be confirmed to match the local content. */
export class TranscriptArchiveVerificationError extends TranscriptArchiveError {}

/**
 * Object-key segments must be safe path components: no separators, no
 * traversal, nothing needing URL-encoding. Session ids are UUIDs and
 * harnesses are snake_case identifiers, so this is a validity assertion,
 * not a normalization step.
 */
const KEY_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function assertKeySegment(value: string, label: string): void {
  if (!KEY_SEGMENT_RE.test(value) || value === "." || value === "..") {
    throw new TranscriptArchiveError(
      `${label} is not object-key safe: ${JSON.stringify(value)} (allowed: [A-Za-z0-9._-]+)`
    );
  }
}

export function encodeContent(content: Uint8Array | string): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function transcriptArchiveKey(
  harness: string,
  agentSessionId: string,
  sha256: string
): string {
  assertKeySegment(harness, "harness");
  assertKeySegment(agentSessionId, "agentSessionId");
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new TranscriptArchiveError(
      `sha256 must be 64 lowercase hex chars, got ${JSON.stringify(sha256)}`
    );
  }
  return `${harness}/${agentSessionId}/${sha256}.jsonl`;
}

export interface ParsedTranscriptArchiveKey {
  harness: string;
  agentSessionId: string;
  sha256: string;
}

export function parseTranscriptArchiveKey(key: string): ParsedTranscriptArchiveKey | null {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/([0-9a-f]{64})\.jsonl$/.exec(key);
  if (!match) return null;
  const [, harness, agentSessionId, sha256] = match;
  if (!harness || !agentSessionId || !sha256) return null;
  return { harness, agentSessionId, sha256 };
}

export function contentTypeForFormat(format: TranscriptArchiveFormat): string {
  return format === "legacy-transcript-message" ? "application/json" : "application/x-ndjson";
}

/** Newest-complete-first ordering: bytes desc, createdAt desc, key asc. */
export function compareVersionsNewestFirst(
  a: TranscriptArchiveVersion,
  b: TranscriptArchiveVersion
): number {
  const aBytes = a.bytes ?? -1;
  const bBytes = b.bytes ?? -1;
  if (aBytes !== bBytes) return bBytes - aBytes;
  const aCreated = a.createdAt ?? "";
  const bCreated = b.createdAt ?? "";
  if (aCreated !== bCreated) return bCreated.localeCompare(aCreated);
  return a.key.localeCompare(b.key);
}
