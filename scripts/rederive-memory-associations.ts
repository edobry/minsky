#!/usr/bin/env bun
/**
 * Re-derive `associations.tracksTask` from body text and classify each stored ref.
 *
 * ADR-012 §Implementation Follow-Ups → *Child task 2* prescribes deriving associations from
 * content patterns and closes with a bullet that was never built:
 *
 *   > Validate by comparing structured associations against body-text grep
 *
 * This is that bullet. mt#4448 shipped the derivation (backfill + every `memory.create`) and
 * not the validation, so a text false positive minted once is permanent: `extractTrackingTaskRefs`
 * prefers a stored association and never re-scans the text (`staleness.ts`), which is what makes
 * the write path's precision the read path's ceiling forever.
 *
 * Usage:
 *   bun scripts/rederive-memory-associations.ts                  # dry-run summary
 *   bun scripts/rederive-memory-associations.ts --verbose        # + per-record listing
 *   bun scripts/rederive-memory-associations.ts --json           # machine-readable plan
 *   bun scripts/rederive-memory-associations.ts --execute --token <t>   # apply corrections
 *
 * @see docs/architecture/adr-012-memory-entity-associations.md
 * @see mt#4765
 */

// tsyringe reflect polyfill. MUST be static and first — every domain import below is dynamic
// and a type-only import is erased at runtime, so nothing else here loads it (mt#3178).
import "reflect-metadata";
import { createHash } from "node:crypto";

import type { MemoryServiceSurface, MemoryServiceDb } from "@minsky/domain/memory/memory-service";
import { extractTrackingTaskRefs } from "@minsky/domain/memory/staleness";
import { TRACKS_TASK_ASSOCIATION } from "@minsky/domain/memory/associations";

// ── Pure core ───────────────────────────────────────────────────────────────────────────────

/** What grounds (or fails to ground) a single stored ref. */
export type RefVerdict = "grounded" | "quoted-only" | "not-derivable";

export interface RefClassification {
  ref: string;
  verdict: RefVerdict;
}

export interface RecordClassification {
  storedRefs: string[];
  refs: RefClassification[];
  /** Refs the current patterns find in unquoted prose but that are NOT stored (recall gap). */
  unstoredGrounded: string[];
}

/**
 * Classify each stored `tracksTask` ref against the record's own text.
 *
 * The three verdicts are NOT three grades of the same thing — only one of them is actionable:
 *
 * - `grounded`     — an unquoted retirement clause still produces it. Leave alone.
 * - `quoted-only`  — produced ONLY from a code span, fence, or blockquote. This is the
 *                    mem#1340 / mem#1208 shape: the detector matched a clause the record was
 *                    DISCUSSING rather than uttering. Actionable.
 * - `not-derivable`— current patterns do not produce it from this text at all. AMBIGUOUS by
 *                    construction and deliberately NOT actionable: a derived value and an
 *                    author-DECLARED value are byte-identical once stored, so this bucket mixes
 *                    genuine author declarations, records edited after minting, and drift from
 *                    the backfill's pattern set. Correcting it automatically would delete real
 *                    associations. It is reported for hand classification (mt#4765 SC1/SC2).
 */
export function classifyRecord(input: {
  storedRefs: string[];
  content: string;
  description?: string | null;
}): RecordClassification {
  const { content, description } = input;
  // Associations deliberately omitted: passing them would take the fast path and return the
  // stored value back to us, which is the very shortcut this script exists to bypass.
  const record = { content, ...(description == null ? {} : { description }) };

  // BOTH derivations now come from the shipped extractor, which is the whole point of the
  // mt#4792 rework. Before it, this script carried a LOCAL approximation of the quotation pass
  // because the extractor had none; mt#4454 then shipped the real one, which made the local copy
  // both redundant and — being an approximation — a source of disagreement with the write path.
  //
  //   derivedNow  — what the extractor produces TODAY (quotation-elided). Ground truth.
  //   derivedRaw  — what it produced BEFORE mt#4454 (no elision), i.e. what actually MINTED the
  //                 stored associations this script is auditing.
  //
  // A ref in `derivedRaw` but not `derivedNow` was minted from a QUOTED clause: the old patterns
  // saw it, the corrected ones do not. That is a confirmed false positive, and it is the only
  // bucket this script is willing to correct.
  const derivedNow = new Set(extractTrackingTaskRefs(record).refs);
  const derivedRaw = new Set(extractTrackingTaskRefs(record, { skipQuotationElision: true }).refs);

  const refs = input.storedRefs.map((ref): RefClassification => {
    if (derivedNow.has(ref)) return { ref, verdict: "grounded" };
    if (derivedRaw.has(ref)) return { ref, verdict: "quoted-only" };
    return { ref, verdict: "not-derivable" };
  });

  const stored = new Set(input.storedRefs);
  return {
    storedRefs: input.storedRefs,
    refs,
    unstoredGrounded: [...derivedNow].filter((r) => !stored.has(r)).sort(),
  };
}

/**
 * Build the `associations` payload for a correction.
 *
 * `MemoryService.update` MERGES this map rather than replacing it, and reads REMOVAL intent from
 * keys whose value is an empty array (`memory-service.ts`: `associations || toMerge::jsonb`, then
 * `- key` for every entry with `v.length === 0`). So the corrected ref list is always SET — even
 * when it is empty. Deleting the key instead makes it absent from `Object.entries`, which reaches
 * neither branch and leaves the stored value untouched (mt#4796).
 *
 * Every other key is carried through unchanged: a record can hold association types this task
 * does not touch, and the merge would preserve them anyway — but passing them explicitly keeps
 * the payload a faithful statement of the intended end state rather than a diff.
 */
export function buildAssociationsUpdate(
  current: Record<string, string[]>,
  afterRefs: string[]
): Record<string, string[]> {
  return { ...current, [TRACKS_TASK_ASSOCIATION]: afterRefs };
}

/**
 * `MemoryService.update`'s associations semantics, reproduced for tests.
 *
 * Not a convenience stub: a fake that simply assigned the payload would accept the deleted-key
 * bug this function exists to catch. Mirrors `memory-service.ts:935-944` exactly.
 */
export function applyUpdateAssociationsSemantics(
  stored: Record<string, string[]>,
  payload: Record<string, string[]>
): Record<string, string[]> {
  const entries = Object.entries(payload);
  const merged: Record<string, string[]> = { ...stored };
  for (const [k, v] of entries) if (v.length > 0) merged[k] = v;
  for (const [k, v] of entries) if (v.length === 0) delete merged[k];
  return merged;
}

/** The corrected ref list for a record: every `quoted-only` ref dropped, order preserved. */
export function correctedRefs(c: RecordClassification): string[] {
  return c.refs.filter((r) => r.verdict !== "quoted-only").map((r) => r.ref);
}

export interface PlanEntry {
  id: string;
  shortId: string | null;
  name: string;
  before: string[];
  after: string[];
  dropped: string[];
}

/**
 * Stable token over the exact change set, mirroring `tasks_bulk-edit`'s dry-run→token
 * discipline: `--execute` recomputes the plan and ABORTS if the token no longer matches, so a
 * corpus that moved between the dry-run and the apply cannot be mutated on stale intent
 * (`operational-safety-dry-run-first §Dry-run scope-match check`).
 */
export function planToken(entries: PlanEntry[]): string {
  const canonical = entries
    .map((e) => `${e.id}:${e.before.join(",")}>${e.after.join(",")}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ── Imperative shell ────────────────────────────────────────────────────────────────────────

async function buildMemoryService(): Promise<MemoryServiceSurface> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { createEmbeddingServiceFromConfig } = await import(
    "@minsky/domain/ai/embedding-service-factory"
  );
  const { createVectorStorageForDomain } = await import(
    "@minsky/domain/storage/vector/vector-storage-factory"
  );
  const { MemoryService } = await import("@minsky/domain/memory");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("Re-derivation requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("Re-derivation requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Re-derivation requires an initialized Postgres database connection.");
  }

  const embeddingService = await createEmbeddingServiceFromConfig();
  const vectorStorage = await createVectorStorageForDomain("memory", 1536, persistence);

  return new MemoryService({
    db: connection as MemoryServiceDb,
    vectorStorage,
    embeddingService,
  });
}

/**
 * Page through the WHOLE corpus, then assert the scan actually covered it.
 *
 * `MemoryService.list()` silently caps at `DEFAULT_LIST_CAP` (500) — its own docblock says its
 * array length "cannot answer how many rows actually match" (mt#4761). A capped scan here would
 * report a confident, wrong rate over 37% of the corpus with nothing in the output to show it:
 * the exact derived-view failure this task exists to repair, reproduced in the tool built to
 * repair it. Observed in this script's first live run — 500 scanned against a true 1,342.
 *
 * So the count is not decoration: it makes the scan able to FAIL. A short read throws rather
 * than returning a plausible number (mem#704 — a probe that cannot fail is not verification).
 */
async function listEveryMemory(
  service: MemoryServiceSurface
): Promise<Awaited<ReturnType<MemoryServiceSurface["list"]>>> {
  if (typeof service.count !== "function") {
    throw new Error(
      "MemoryService exposes no count(); cannot prove the scan covered the corpus. Refusing."
    );
  }

  // Count FIRST, and compare with `<`, not `!==`. Both choices are about the same race: a record
  // created while the scan is in flight. Counting first means such a record can only make the
  // scan LARGER than the floor, never smaller, so it cannot trip the check; comparing with `<`
  // means a concurrent DELETE (which lowers the true total below the floor) does not either.
  // What remains catchable is the case worth catching — a SHORT read, where paging silently
  // stopped early and every rate below would be computed over a fraction of the corpus.
  const floor = await service.count();

  const PAGE = 500;
  const out: Awaited<ReturnType<MemoryServiceSurface["list"]>> = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await service.list({ limit: PAGE, offset });
    out.push(...page);
    if (page.length < PAGE) break;
  }

  if (out.length < floor) {
    throw new Error(
      `Scan covered ${out.length} of at least ${floor} memories — refusing to report a rate ` +
        "over a partial corpus. Investigate the pagination before trusting any number below."
    );
  }

  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const verbose = argv.includes("--verbose");
  const asJson = argv.includes("--json");
  // Read the value only when the flag is present. `indexOf` returns -1 when it is absent, so the
  // unguarded `argv[indexOf + 1]` would silently read argv[0].
  const tokenIdx = argv.indexOf("--token");
  const suppliedToken = tokenIdx >= 0 ? argv[tokenIdx + 1] : undefined;

  const memoryService = await buildMemoryService();
  const all = await listEveryMemory(memoryService);

  const withTracks = all.filter((m) => {
    const refs = m.associations?.[TRACKS_TASK_ASSOCIATION];
    return Array.isArray(refs) && refs.length > 0;
  });

  const plan: PlanEntry[] = [];
  const tally: Record<RefVerdict, number> = {
    grounded: 0,
    "quoted-only": 0,
    "not-derivable": 0,
  };
  const detail: Array<{ mem: (typeof withTracks)[number]; c: RecordClassification }> = [];

  for (const mem of withTracks) {
    const storedRefs = (mem.associations?.[TRACKS_TASK_ASSOCIATION] ?? []) as string[];
    const c = classifyRecord({
      storedRefs,
      content: mem.content,
      description: mem.description,
    });
    for (const r of c.refs) tally[r.verdict]++;
    detail.push({ mem, c });

    const after = correctedRefs(c);
    if (after.length !== storedRefs.length) {
      plan.push({
        id: mem.id,
        shortId: mem.shortId ?? null,
        name: mem.name,
        before: storedRefs,
        after,
        dropped: c.refs.filter((r) => r.verdict === "quoted-only").map((r) => r.ref),
      });
    }
  }

  const token = planToken(plan);

  if (asJson) {
    // `measuredAt` and `scanned` are what make a committed snapshot readable later: the corpus
    // moves under this script (a ref changes bucket whenever a memory is patched), so a bare
    // tally with no date is a number nobody can re-derive. Read in the imperative shell, never
    // in the pure core, so nothing under test reads the clock.
    console.log(
      JSON.stringify(
        { measuredAt: new Date().toISOString(), scanned: all.length, token, tally, plan },
        null,
        2
      )
    );
  } else {
    console.log("=== tracksTask re-derivation ===");
    console.log(`Memories scanned:            ${all.length}`);
    console.log(`Carrying tracksTask:         ${withTracks.length}`);
    console.log(`Stored refs classified:      ${Object.values(tally).reduce((a, b) => a + b, 0)}`);
    console.log(`  grounded (unquoted prose): ${tally.grounded}`);
    console.log(`  quoted-only (ACTIONABLE):  ${tally["quoted-only"]}`);
    console.log(`  not-derivable (hand-class):${tally["not-derivable"]}`);
    console.log(`Records to correct:          ${plan.length}`);
    console.log(`Plan token:                  ${token}`);

    // A rate bounds VOLUME and says nothing about CORRECTNESS — every false positive is inside
    // the count, indistinguishable from a hit (mem#1208). `--verbose` exists so the records can
    // be READ, which is the only thing that separates them.
    if (verbose) {
      console.log("\n=== Per-record ===");
      for (const { mem, c } of detail) {
        const marks = c.refs.map((r) => `${r.ref}[${r.verdict}]`).join(" ");
        console.log(`\n${mem.shortId ?? mem.id.slice(0, 8)}  ${mem.name}`);
        console.log(`  ${marks}`);
        if (c.unstoredGrounded.length > 0) {
          console.log(`  (unstored but grounded: ${c.unstoredGrounded.join(", ")})`);
        }
      }
    }
  }

  if (!execute) {
    if (!asJson) {
      console.log(`\nDRY RUN — no changes written. Apply with: --execute --token ${token}`);
    }
    return;
  }

  if (suppliedToken !== token) {
    console.error(
      `\nABORT: plan token mismatch. Supplied ${suppliedToken ?? "(none)"}, current ${token}.` +
        "\nThe corpus changed since the dry-run. Re-run the dry-run and re-read the plan."
    );
    process.exit(2);
  }

  let applied = 0;
  let errors = 0;
  let skipped = 0;
  for (const entry of plan) {
    try {
      // Re-read immediately before writing. `update` REPLACES the whole associations map, so
      // building it from the scan-time snapshot would silently revert any association key a
      // concurrent writer added since — including keys this task never looks at. The plan token
      // guards the SET of records; this guards each record's own content at the moment of write.
      const current = await memoryService.get(entry.id);
      if (!current) {
        console.error(`  SKIP ${entry.shortId ?? entry.id}: record no longer exists.`);
        skipped++;
        continue;
      }

      const live = { ...((current.associations ?? {}) as Record<string, string[]>) };
      const liveRefs = live[TRACKS_TASK_ASSOCIATION] ?? [];
      // If the refs moved since the dry-run, the plan's `after` was computed against text and
      // refs that no longer describe this record. Skip rather than apply a stale correction.
      if (JSON.stringify(liveRefs) !== JSON.stringify(entry.before)) {
        console.error(
          `  SKIP ${entry.shortId ?? entry.id}: tracksTask changed since the dry-run ` +
            `(${JSON.stringify(entry.before)} -> ${JSON.stringify(liveRefs)}). Re-run.`
        );
        skipped++;
        continue;
      }

      // Preserve every other association key — a record can hold one true ref and one false one
      // (mem#1208 carries mt#4454 legitimately alongside a quoted mt#2056), and other association
      // types are out of scope entirely.
      //
      // Removal is requested with an EMPTY ARRAY, never by deleting the key (mt#4796).
      // `MemoryService.update` MERGES associations — `associations || toMerge::jsonb` — and reads
      // removal intent from keys whose value is `[]`, which it turns into a `- 'key'` operator.
      // A deleted key is absent from `Object.entries`, so it reaches neither branch: the merge
      // leaves the stored value untouched and `update` still returns the record. That is how the
      // first live run reported "Applied: 9" while applying 4 — every correction that emptied
      // `tracksTask` was a silent no-op.
      await memoryService.update(entry.id, {
        associations: buildAssociationsUpdate(live, entry.after),
      });

      // Verify the OUTCOME, not the invocation. `update` returning a record is not evidence the
      // column changed — see above. Re-read and compare; a mismatch is a failure, not an apply.
      const after = await memoryService.get(entry.id);
      const observed = ((after?.associations ?? {}) as Record<string, string[]>)[
        TRACKS_TASK_ASSOCIATION
      ];
      const observedRefs = Array.isArray(observed) ? observed : [];
      if (JSON.stringify(observedRefs) !== JSON.stringify(entry.after)) {
        console.error(
          `  FAILED ${entry.shortId ?? entry.id}: wrote ${JSON.stringify(entry.after)} but read ` +
            `back ${JSON.stringify(observedRefs)}. The write did not take effect.`
        );
        errors++;
        continue;
      }

      console.log(
        `  ${entry.shortId ?? entry.id}: ${JSON.stringify(entry.before)} -> ` +
          `${JSON.stringify(entry.after)} (verified)`
      );
      applied++;
    } catch (err) {
      console.error(`  ERROR updating ${entry.shortId ?? entry.id}: ${err}`);
      errors++;
    }
  }

  console.log(`\nDone. Applied: ${applied}, Skipped: ${skipped}, Errors: ${errors}`);
  if (errors > 0) process.exit(1);
}

// Guarded: the pure core above is imported by the test file, and an unguarded call would run the
// CLI — DB connection, and a `process.exit` — on import. Matches the `import.meta.main` pattern
// the hook modules use.
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
