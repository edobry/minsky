# Transcript Raw Archive

Architecture reference for the transcript raw-archive foundation (mt#2680), the first
implementation slice of [ADR-025](./adr-025-transcript-storage-object-store-system-of-record.md):
the raw transcript file for each agent session lives in a **private Supabase Storage bucket** as
the immutable system of record; Postgres is a rebuildable derived index parsed from it.

## Components

| Piece                                             | Location                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| Interface + key layout + errors                   | `packages/domain/src/storage/archive/transcript-archive-store.ts`          |
| Real implementation (Supabase Storage)            | `packages/domain/src/storage/archive/supabase-transcript-archive-store.ts` |
| Fake (ADR-018 pair, for tests/DI)                 | `packages/domain/src/storage/archive/memory-transcript-archive-store.ts`   |
| Bucket provisioning (idempotent, dry-run default) | `scripts/transcript-archive/provision.ts`                                  |
| Live smoke / posture verification                 | `scripts/transcript-archive/smoke.ts`                                      |

## Key layout (content-addressed)

```
{harness}/{agentSessionId}/{sha256}.jsonl
```

- The object name is the SHA-256 of the object bytes: keys are deterministic, uploads are
  structurally idempotent (`upsert: false`; an already-exists response is success after
  verification), and any downloaded object is integrity-checked against its own key.
- Objects are **immutable**. A growing session produces a new snapshot object per capture;
  nothing is overwritten or deleted. The store interface deliberately exposes **no delete**.
- "Newest complete version" = largest byte count (transcripts are append-only), `created_at`
  as tiebreak. The upload-then-parse ingest (mt#2681) consumes/refines this rule.
- `format` metadata distinguishes `raw-jsonl` originals from `legacy-transcript-message`
  objects (pre-extracted legacy rows archived by the backfill, mt#2682) so a legacy object is
  never mistaken for a raw original.

## Durable-confirmation contract

`putRaw` never reports success on the upload call alone: it re-reads the object (listing
size, or a full download+hash when the listing carries no size) and compares against the
local content, throwing `TranscriptArchiveVerificationError` on any mismatch. This is the
fail-safe primitive the upload-then-parse ingest (mt#2681: never parse-then-discard on an
unconfirmed upload) and the backfill (mt#2682: no row is drop-eligible without a confirmed
archive object) build on.

## Configuration

| Config key                 | Env var                            | Meaning                                             |
| -------------------------- | ---------------------------------- | --------------------------------------------------- |
| `supabase.url`             | `MINSKY_SUPABASE_URL`              | Project URL (`https://<ref>.supabase.co`)           |
| `supabase.serviceRoleKey`  | `MINSKY_SUPABASE_SERVICE_ROLE_KEY` | Service-role secret (trusted-server Storage access) |
| `transcriptArchive.bucket` | `MINSKY_TRANSCRIPT_ARCHIVE_BUCKET` | Bucket name (default `agent-transcript-archive`)    |

The service-role key bypasses RLS project-wide: it is masked by `src/utils/redaction.ts`
(`serviceRoleKey` / `service_role_key` are registered sensitive-key patterns), must never be
logged, and never leaves server-side contexts.

## Security posture

- The bucket is **private** — objects are not addressable via public URLs (verified by the
  smoke script's public-URL and unauthenticated-read probes, which require non-200 responses).
- Access is via the service-role key from trusted server contexts, matching Supabase's
  documented pattern for private buckets ([bucket fundamentals](https://supabase.com/docs/guides/storage/buckets/fundamentals),
  [access control](https://supabase.com/docs/guides/storage/security/access-control)).
- Time-limited access for future UI/streaming needs uses server-minted signed URLs
  (`createSignedUrl`) — signed with a dedicated internal key, never by exposing the
  service-role key.

## Backup / disaster-recovery posture (VERIFIED 2026-07-08)

**Finding:** Supabase database backups do **NOT** include Storage object contents. They cover
only the `storage.objects` metadata rows; the object bytes live in Supabase's S3 backend,
which the project backup/restore flow never touches
([Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups)).

**This corrects ADR-025's consequence-section assumption** ("Archive objects are covered by
the Supabase project backup") — the ADR itself required this verification rather than the
assumption. The corrected stance:

1. **Hardware durability** is provided by the S3-backed storage layer — not the concern.
2. **Logical loss** (accidental bucket deletion, a bad script, credential compromise) is the
   real residual risk, and native backups do not mitigate it. First-line mitigations: the
   store interface exposes no delete; the service-role key is secret-handled.
3. **Second copy:** an off-Supabase mirror of the bucket is tracked as **mt#2715**, flagged
   as a candidate GATE for the mt#2580 column drop (after which the archive is the only copy
   of the raw transcripts for the majority of sessions). Principal decides the gating.

## Operations

```bash
# Verify/provision the bucket (dry-run by default; --execute to create/fix)
bun scripts/transcript-archive/provision.ts
bun scripts/transcript-archive/provision.ts --execute

# Live smoke: round-trip + idempotency + security probes (SKIPs without credentials)
bun scripts/transcript-archive/smoke.ts
```

## Cross-references

- ADR-025 (decision), ADR-018 (interface + fake DI pattern), ADR-002 (provider architecture)
- mt#2581 (epic) · mt#2680 (this foundation) · mt#2681 (upload-then-parse ingest) ·
  mt#2682 (backfill) · mt#2580 (blob drop) · mt#2715 (DR mirror)
