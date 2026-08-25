/**
 * In-memory fake of the drizzle surface `AgentTranscriptIngestService` uses.
 *
 * Extracted from `agent-transcript-ingest-service.test.ts` (mt#4573) when that
 * file reached the 1500-line ceiling. Shared rather than duplicated on purpose:
 * a second, divergent fake is how a test stops describing production — the same
 * reasoning `FakeTranscriptSource`'s retained-type filter records (mt#3836).
 */

import type { RawTurnLine } from "../transcript-source";
import { INGEST_QUARANTINE_THRESHOLD } from "../agent-transcript-ingest-service";

// ── In-memory DB row store ────────────────────────────────────────────────────

export interface FakeRow {
  agentSessionId: string;
  harness: string;
  transcript: RawTurnLine[];
  startedAt: Date | null;
  endedAt: Date | null;
  cwd: string | null;
  projectDir: string | null;
  lastIngestedJsonlTimestamp: Date | null;
  ingestedAt: Date;
  model: string | null;
  // mt#3278 — ingest-failure tracking / quarantine.
  ingestFailureCount: number;
  ingestLastError: string | null;
  ingestLastFailedAt: Date | null;
  ingestQuarantinedAt: Date | null;
  // mt#3656 — writer-divergence verdict written by the transcript upsert.
  // Optional: the fixtures below build FakeRow literals for cases that predate
  // this column, and a row that has never been checked is exactly what NULL /
  // absent is supposed to represent.
  divergentTipLeaves?: string[] | null;
  divergenceCheckedAt?: Date | null;
}

/** Fake `minsky_session_links` row (mt#2441 — cwd_match link writer). */
export interface FakeLinkRow {
  agentSessionId: string;
  minskySessionId: string;
  linkType: string;
  confidence: number | null;
}

/**
 * Creates a minimal fake DB that mimics drizzle's fluent builder surface.
 *
 * The service issues queries in a fixed sequence for each session:
 *   (1) select { lastIngestedJsonlTimestamp } ... where agentSessionId = X  → high-water read
 *   (2) select { agentSessionId } ... where agentSessionId = X              → existence check
 *   (3) select { transcript, cwd } ... where agentSessionId = X             → transcript+cwd read
 *   (4) update … / insert …
 *
 * Because we cannot inspect the opaque drizzle SQL expression returned by
 * eq(), the fake resolves "which session" by tracking the most-recently
 * inserted/active session ID.  Each ingestSession() call touches exactly one
 * session, so the one-at-a-time ordering is deterministic.
 *
 * `linkState` (mt#2441) is a SEPARATE store for `minsky_session_links` writes,
 * keyed independently from the `agent_transcripts` `FakeRow` store above so a
 * cwd_match link write can never corrupt transcript state. Routing is by duck
 * typing: a values object carrying `minskySessionId` + `linkType` (fields no
 * other table's insert carries) is a link write; everything else falls
 * through to the existing agent_transcripts/turns/attachments handling.
 */
export function makeDb(
  state: Map<string, FakeRow>,
  linkState: Map<string, FakeLinkRow> = new Map()
) {
  // The select chain needs to know which session to look up.  We derive it
  // from the insert/update stream: each insert sets currentSid; each
  // subsequent select chain uses it.  For the very first select (high-water
  // read), we prime currentSid from the source session via primeSession().
  let currentSid: string | null = null;

  /**
   * mt#3482: the ORDER of writes within one ingest, as a list of kinds
   * (`"transcript-row"` | `"attachments"` | `"transcript-upsert"`).
   *
   * Ordering is the whole invariant this fix turns on — the attachment insert
   * carries an FK to `agent_transcripts`, so a parent row must precede it,
   * while the watermark-bearing upsert must still FOLLOW it (mt#3278). The fake
   * cannot enforce an FK, so it records the sequence and lets the tests assert
   * on it; the constraint itself is exercised against a real Postgres in
   * `tests/integration/transcript-attachment-parent-row.integration.test.ts`.
   */
  const writeOrder: string[] = [];

  /** mt#3836: attachment rows as written, for primary-key assertions. */
  const attachments: Array<{ lineIndex: number }> = [];

  /**
   * mt#4573: `transcript_lines` rows as written. The whole point of that table
   * is the line types the other stores drop, so a test asserting capture has to
   * see the ROWS, not just that a write happened.
   */
  const capturedLines: Array<{ lineOrdinal: number; lineType: string; line: unknown }> = [];

  // Forward reference for the fake's own `transaction`, which must hand the
  // callback the SAME fake (see below). Declared separately so `db` keeps its
  // inferred type — annotating it to break the initializer cycle would erase
  // the shape every `db._primeSession(...)` / `db._writeOrder` in this file
  // depends on.
  const selfRef: { db?: unknown } = {};
  const db = {
    /**
     * mt#3514: `writeTurnsForTranscript` now runs its upsert + orphan-delete
     * inside a transaction holding a session advisory lock, with a per-chunk
     * SAVEPOINT (a nested `transaction`). The fake models the CONTROL FLOW
     * only — it passes itself as the tx/savepoint handle — not rollback or
     * locking semantics, which are database behavior an in-memory fake cannot
     * honestly stand in for.
     */
    async transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
      return cb(selfRef.db);
    },
    /** The advisory-lock statement; the fake has no lock to take. */
    execute(_query: unknown): Promise<unknown[]> {
      return Promise.resolve([]);
    },
    /**
     * mt#3514 orphan removal. These fixtures never build the stale-row state
     * the DELETE targets, so it removes nothing here — but it must EXIST:
     * without it the call throws, `orphanDeleteFailed` goes true, and every
     * ingest in this file is correctly reported as degraded. (That is exactly
     * what happened when this method was missing, which is the new
     * error-propagation working as intended.)
     */
    delete(_table: unknown) {
      return {
        where(_cond: unknown) {
          return {
            returning(_cols?: unknown): Promise<unknown[]> {
              return Promise.resolve([]);
            },
          };
        },
      };
    },

    /** Called by test setup to tell the fake which session is being processed. */
    _primeSession(sid: string) {
      currentSid = sid;
    },

    /** Exposed so tests can assert on written `minsky_session_links` rows. */
    _links: linkState,

    /** mt#3482 — exposed so tests can assert on write ORDER within an ingest. */
    _writeOrder: writeOrder,
    _attachments: attachments,
    /** mt#4573: rows written to `transcript_lines`, in write order. */
    _capturedLines: capturedLines,

    select(fields?: Record<string, unknown>) {
      const fieldKeys = fields ? Object.keys(fields) : [];
      // mt#4573: the transcript_lines ordinal high-water read is the one select
      // in this service that ends at `.where()` with no `.limit()`, and it
      // queries a different table. Routed by its projected field name, and
      // answered from the capture store so a re-ingest test sees a REAL
      // high-water rather than a constant.
      const isOrdinalHighWater = fieldKeys.length === 1 && fieldKeys[0] === "maxOrdinal";
      const ordinalHighWaterRows = (): Promise<Array<{ maxOrdinal: number | null }>> =>
        Promise.resolve([
          {
            maxOrdinal:
              capturedLines.length === 0
                ? null
                : Math.max(...capturedLines.map((r) => r.lineOrdinal)),
          },
        ]);
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => ({
            then: <T>(resolve: (v: unknown) => T, reject?: (e: unknown) => unknown) =>
              (isOrdinalHighWater ? ordinalHighWaterRows() : Promise.resolve([] as unknown[])).then(
                resolve,
                reject
              ),
            limit: (_n: number): Promise<Partial<FakeRow>[]> => {
              const sid = currentSid;
              if (!sid) return Promise.resolve([]);
              const row = state.get(sid);
              if (!row) return Promise.resolve([]);
              if (fieldKeys.length === 0) return Promise.resolve([row]);
              // Spread rather than `as unknown as Record<...>`: an interface has
              // no implicit index signature, and the double assertion that used
              // to bridge that gap trips `custom/no-excessive-as-unknown` now
              // that this fixture lives outside the test-file glob (mt#4573).
              const rowRecord: Record<string, unknown> = { ...row };
              const proj: Record<string, unknown> = {};
              for (const f of fieldKeys) {
                proj[f] = rowRecord[f];
              }
              return Promise.resolve([proj as Partial<FakeRow>]);
            },
          }),
        }),
      };
    },

    insert(_table: unknown) {
      return {
        values(
          // NOT `readonly unknown[]`: `Array.isArray` narrows to `any[]`, which
          // cannot remove a READONLY array from the union in the false branch,
          // so every `values.<field>` read below the guard would still see the
          // array arm. The fake is reached only through `asPgDb`'s cast, so the
          // mutable-array signature is never checked against a real call site.
          values: (Partial<FakeRow> & { agentSessionId: string }) | FakeLinkRow | unknown[]
        ) {
          // mt#3482: the attachment insert passes an ARRAY of rows (one per
          // attachment line) — every other table's insert here passes a single
          // object, so the array shape identifies it unambiguously. The rows
          // themselves aren't stored: what the tests assert is WHEN this write
          // happened relative to the parent-row insert and the upsert.
          if (Array.isArray(values)) {
            // Two array-valued writers exist: the attachment insert
            // (`onConflictDoNothing`) and the per-turn FTS upsert
            // (`onConflictDoUpdate`, §4b). Only attachment rows carry
            // `attachmentType`, so the row shape tells them apart — and both
            // chain methods must exist here, or whichever one is missing throws
            // and surfaces as a spurious ingest error.
            const first = values[0] as Record<string, unknown> | undefined;
            // mt#4573: capture rows are the third array-valued writer. Only
            // they carry `lineOrdinal` — attachments carry `lineIndex`, turns
            // carry neither — so the row shape tells all three apart.
            if (first && "lineOrdinal" in first) {
              writeOrder.push("transcript-lines");
              capturedLines.push(
                ...(values as Array<{ lineOrdinal: number; lineType: string; line: unknown }>)
              );
              return {
                onConflictDoNothing: (): Promise<void> => Promise.resolve(),
                onConflictDoUpdate: (_opts: unknown): Promise<void> => Promise.resolve(),
              };
            }
            const isAttachmentInsert = Boolean(first && "attachmentType" in first);
            writeOrder.push(isAttachmentInsert ? "attachments" : "turns");
            // mt#3836: retain the attachment rows themselves, not just the fact
            // that a write happened. `lineIndex` is half of their primary key,
            // so a test asserting PK stability needs the actual values.
            if (isAttachmentInsert) {
              attachments.push(...(values as Array<{ lineIndex: number }>));
            }
            // Deliberately NOT a thenable, unlike the single-object path below
            // (PR #2503 R1). Every array-valued writer in production ends its
            // chain with a terminal method — attachments with
            // `onConflictDoNothing`, turns and tool-call projections with
            // `onConflictDoUpdate` — so nothing ever awaits this builder
            // directly. Omitting `then` keeps it an unambiguous builder rather
            // than an object that is simultaneously awaitable and chainable,
            // and makes a future direct `await` fail loudly here instead of
            // silently resolving without recording the write.
            return {
              onConflictDoNothing: (): Promise<void> => Promise.resolve(),
              onConflictDoUpdate: (_opts: unknown): Promise<void> => Promise.resolve(),
            };
          }

          // mt#2441: minsky_session_links writes are duck-typed by the
          // presence of `minskySessionId` + `linkType` — fields no other
          // table's insert carries. Routed to a dedicated store so a link
          // write can never corrupt agent_transcripts state.
          if ("minskySessionId" in values && "linkType" in values) {
            const linkValues = values as FakeLinkRow;
            return {
              onConflictDoNothing(): Promise<void> {
                const key = `${linkValues.agentSessionId}:${linkValues.minskySessionId}`;
                if (!linkState.has(key)) {
                  linkState.set(key, { ...linkValues });
                }
                return Promise.resolve();
              },
            };
          }

          const sid = values.agentSessionId;
          currentSid = sid;

          // Plain-insert path: awaiting `.values(...)` directly performs the insert
          // and overwrites any existing row (matches drizzle's INSERT semantics).
          const doPlainInsert = (): Promise<void> => {
            state.set(sid, {
              agentSessionId: sid,
              harness: values.harness ?? "claude_code",
              transcript: (values.transcript ?? []) as RawTurnLine[],
              startedAt: values.startedAt ?? null,
              endedAt: values.endedAt ?? null,
              cwd: values.cwd ?? null,
              projectDir: values.projectDir ?? null,
              lastIngestedJsonlTimestamp: values.lastIngestedJsonlTimestamp ?? null,
              ingestedAt: values.ingestedAt ?? new Date(),
              model: values.model ?? null,
              ingestFailureCount: values.ingestFailureCount ?? 0,
              ingestLastError: values.ingestLastError ?? null,
              ingestLastFailedAt: values.ingestLastFailedAt ?? null,
              ingestQuarantinedAt: values.ingestQuarantinedAt ?? null,
              divergentTipLeaves: values.divergentTipLeaves ?? null,
              divergenceCheckedAt: values.divergenceCheckedAt ?? null,
            });
            return Promise.resolve();
          };

          // mt#3278: `recordIngestFailure` upserts ONLY the failure columns —
          // no `transcript` key — so it is duck-typed apart from the transcript
          // upsert here, mirroring how the two are distinct statements in
          // production. Modelling it faithfully is what makes the quarantine
          // test a real check rather than an assertion about the fake.
          const isFailureRecord = "ingestFailureCount" in values && !("transcript" in values);
          const applyFailureRecord = (): Promise<void> => {
            const existing = state.get(sid);
            const nextCount = (existing?.ingestFailureCount ?? 0) + 1;
            const quarantinedAt =
              nextCount >= INGEST_QUARANTINE_THRESHOLD
                ? (existing?.ingestQuarantinedAt ?? new Date())
                : (existing?.ingestQuarantinedAt ?? null);
            state.set(sid, {
              agentSessionId: sid,
              harness: existing?.harness ?? values.harness ?? "unknown",
              transcript: existing?.transcript ?? [],
              startedAt: existing?.startedAt ?? null,
              endedAt: existing?.endedAt ?? null,
              cwd: existing?.cwd ?? null,
              projectDir: existing?.projectDir ?? null,
              // Deliberately NOT advanced — a failure must never move the
              // watermark, or the failed batch is skipped on the retry.
              lastIngestedJsonlTimestamp: existing?.lastIngestedJsonlTimestamp ?? null,
              ingestedAt: existing?.ingestedAt ?? new Date(),
              model: existing?.model ?? null,
              ingestFailureCount: nextCount,
              ingestLastError: values.ingestLastError ?? null,
              ingestLastFailedAt: values.ingestLastFailedAt ?? new Date(),
              ingestQuarantinedAt: quarantinedAt,
            });
            return Promise.resolve();
          };

          // Returns a thenable so plain `await db.insert(...).values(...)` still
          // works, but also exposes `.onConflictDoUpdate(...)` for the upsert
          // path. The fake doesn't introspect the conflict target or the SQL
          // expressions in `set`; it hard-codes the production convention
          // (mt#2789): `transcript` is JSONB-array concatenated but filtered
          // by line `uuid` — an EXCLUDED element whose `uuid` is already
          // present in the stored array is dropped (elements without a
          // `uuid` are always appended), mirroring the correlated
          // `jsonb_array_elements` subquery in the real SQL.
          // `lastIngestedJsonlTimestamp` takes GREATEST(existing, EXCLUDED)
          // rather than a flat overwrite. Scalar fields otherwise copy from
          // EXCLUDED (i.e. the inserted values).
          return {
            then: <T>(resolve: (v: void) => T, reject?: (e: unknown) => unknown) =>
              doPlainInsert().then(resolve, reject),
            // mt#3482: §3a's parent-row insert — creates the row only when
            // absent, mirroring `INSERT … ON CONFLICT DO NOTHING`.
            onConflictDoNothing(): Promise<void> {
              writeOrder.push("transcript-row");
              if (state.has(sid)) return Promise.resolve();
              return doPlainInsert();
            },
            onConflictDoUpdate(_opts: unknown): Promise<void> {
              writeOrder.push("transcript-upsert");
              if (isFailureRecord) return applyFailureRecord();
              const existing = state.get(sid);
              if (!existing) return doPlainInsert();

              const existingUuids = new Set(
                (existing.transcript ?? [])
                  .map((l) => l.uuid)
                  .filter((u): u is string => typeof u === "string")
              );
              const incoming = (values.transcript ?? []) as RawTurnLine[];
              const deduped = incoming.filter(
                (l) => typeof l.uuid !== "string" || !existingUuids.has(l.uuid)
              );
              const concatenated: RawTurnLine[] = [...(existing.transcript ?? []), ...deduped];

              const existingHwm = existing.lastIngestedJsonlTimestamp;
              const incomingHwm = values.lastIngestedJsonlTimestamp ?? null;
              const newHwm =
                existingHwm && incomingHwm
                  ? existingHwm.getTime() >= incomingHwm.getTime()
                    ? existingHwm
                    : incomingHwm
                  : (incomingHwm ?? existingHwm);

              state.set(sid, {
                ...existing,
                transcript: concatenated,
                endedAt: values.endedAt ?? existing.endedAt,
                lastIngestedJsonlTimestamp: newHwm,
                ingestedAt: values.ingestedAt ?? new Date(),
                // mt#3089: COALESCE(existing, EXCLUDED) — mirrors the real
                // SQL's precedence so a later batch that doesn't re-include
                // the model-bearing turn can never regress an already-stored
                // value.
                model: existing.model ?? values.model ?? null,
                // mt#3278: a successful upsert clears the failure record, which
                // is what makes quarantine self-healing.
                ingestFailureCount: 0,
                ingestLastError: null,
                ingestQuarantinedAt: null,
              });
              return Promise.resolve();
            },
          };
        },
      };
    },

    update(_table: unknown) {
      return {
        set(updates: Partial<FakeRow>) {
          return {
            where(_cond: unknown): Promise<void> {
              if (currentSid) {
                const existing = state.get(currentSid);
                if (existing) {
                  state.set(currentSid, { ...existing, ...updates });
                }
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  // Close the forward reference now that `db` exists (mt#3514).
  selfRef.db = db;
  return db;
}
