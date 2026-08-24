# Transcript Raw Archive

Architecture reference for the transcript raw-archive foundation (mt#2680) — the store, its key
layout, its confirmation contract, and its security posture, all as built and all still accurate.

> **⚠ Re-scoped 2026-08-24 by
> [ADR-045](./adr-045-transcript-lines-live-landing-zone-object-storage-cold-tier.md).** This
> document originally opened by describing the bucket as the **immutable system of record**, with
> Postgres a rebuildable derived index parsed from it. That was
> [ADR-025](./adr-025-transcript-storage-object-store-system-of-record.md)'s decision, and it is
> **superseded**. The live landing zone is now an insert-only `transcript_lines` table in Postgres;
> **this bucket becomes a one-way cold tier that seals a session after it closes.**
>
> **The store described below is unchanged and was never wired up** — `putRaw` has no production
> caller, so no object has ever been written outside the smoke script. What changed is what the
> bucket is FOR. Passages whose meaning depends on the retired capture model are marked inline
> below rather than deleted.

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
- Objects are **immutable**; nothing is overwritten or deleted, and the store interface
  deliberately exposes **no delete**. That property is unchanged by ADR-045 and is the reason the
  bucket suits a cold tier.
  **Retired by ADR-045: _"A growing session produces a new snapshot object per capture."_** That
  was the incremental-capture model, and combined with immutability it meant the bucket retained
  every prefix of every session — at ~69 captures/session, a projected ~35x the corpus size. The
  contradiction between an immutable store and incremental capture is precisely why ADR-025 needed
  a successor rather than an amendment. Under the cold tier a session is written **once, at close**,
  so there is one object per session and no prefix accumulation.
- **Retired by ADR-045:** _"'Newest complete version' = largest byte count (transcripts are
  append-only), `created_at` as tiebreak."_ This rule only has work to do when a session has
  multiple objects, which seal-at-close makes impossible. It is kept here because the backfill
  (mt#2682) may still encounter multi-object sessions if any are ever written.
  The reference to the upload-then-parse ingest consuming this rule is stale — **mt#2681's scope
  inverts** to lines-table ingest.
- `format` metadata distinguishes `raw-jsonl` originals from `legacy-transcript-message`
  objects (pre-extracted legacy rows archived by the backfill, mt#2682) so a legacy object is
  never mistaken for a raw original.

## Durable-confirmation contract

`putRaw` never reports success on the upload call alone: it re-reads the object (listing
size, or a full download+hash when the listing carries no size) and compares against the
local content, throwing `TranscriptArchiveVerificationError` on any mismatch.

**The primitive survives ADR-045; one of its two named consumers does not.** It was built for the
upload-then-parse ingest (mt#2681: never parse-then-discard on an unconfirmed upload), and that
capture path is retired — mt#2681 now ingests into `transcript_lines`, where the equivalent
guarantee is a database transaction rather than a re-read. What the contract still serves: the
backfill (mt#2682, whose destination also changes) and, prospectively, the seal-at-close write,
where confirming the object before treating a session as sealed is the same discipline applied at
a different moment.

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
3. **Second copy:** an off-Supabase mirror of the bucket is tracked as **mt#2715**.

**Re-scoped 2026-08-24 (ADR-045).** The finding above is unchanged and still verified — Supabase
database backups still do not cover Storage objects. What changed is the **stake**. This section
was written when the bucket was to become the only copy of the raw transcripts for the majority of
sessions after the mt#2580 column drop, which is what made mt#2715 a candidate gate on that drop.
Under ADR-045 the raw corpus lands in Postgres instead, so:

- **mt#2715 stops gating mt#2580.** It survives, re-scoped, and it now owns the DR question for
  the corpus in its new home rather than for this bucket.
- **The bucket is a redundant cold copy, not a sole copy** — which lowers the cost of the logical-
  loss risk in item 2 without eliminating it.
- **The corpus's own envelope is now the database's**, and that was measured rather than assumed:
  `pitr_enabled: false` with a 7-day daily-backup window on the production project. See ADR-045
  `## Consequences → Disaster-recovery posture`; the open question of whether 7 days suffices is
  [ask#9995](minsky://ask/af68c3e5-a676-4610-bf65-8493311232fd), owned by mt#2715.

## Operations

```bash
# Verify/provision the bucket (dry-run by default; --execute to create/fix)
bun scripts/transcript-archive/provision.ts
bun scripts/transcript-archive/provision.ts --execute

# Live smoke: round-trip + idempotency + security probes (SKIPs without credentials)
bun scripts/transcript-archive/smoke.ts
```

## Cross-references

- **ADR-045 (the current decision — `transcript_lines` is the live landing zone; this bucket is a
  cold seal-at-close tier)** · ADR-025 (the superseded decision this store was built under, retained
  as lineage) · ADR-018 (interface + fake DI pattern) · ADR-002 (provider architecture)
- mt#2581 (epic) · mt#2680 (this foundation) · mt#2681 (ingest rewrite — **scope inverted** from
  upload-then-parse to lines-table ingest) · mt#2682 (backfill — destination re-pointed) ·
  mt#2580 (blob drop — **no longer gated on mt#2715**) · mt#2715 (DR posture) ·
  mt#3954 (bucket provisioning — justification now mt#4447) · mt#4501 (the supersession)
