/**
 * Census read over the whole memory corpus, for scripts that scan every record to decide what
 * to WRITE.
 *
 * `MemoryService.list()` silently caps at `DEFAULT_LIST_CAP` (500, mt#4761) — its own docblock
 * says its array length "cannot answer how many rows actually match." A census caller asks it
 * exactly that question, so a capped read hands back a confident, wrong number over a fraction
 * of the corpus with nothing in the output to show it. That is not hypothetical: on 2026-09-01,
 * with the corpus at 1,347, BOTH remaining census callers printed a clean result over 500 rows
 * and exited 0 —
 *
 *   `backfill-memory-associations.ts`  -> "Found 500 memories to scan."
 *   `normalize-memory-associations.ts` -> "Scanned 500 memories." / "divergent keys: 0"
 *
 * — the second one reporting a clean bill of health for a corpus it never looked at 62% of.
 *
 * So the count is not decoration: it is what makes the scan able to FAIL. A short read throws
 * rather than returning a plausible number (mem#704 — a probe that returns the same result when
 * the system is broken is not verification).
 *
 * This lives here, shared, rather than in `packages/domain`, because it deliberately does the
 * thing mt#4761 removed from the domain surface: materialize the entire corpus. That is correct
 * for an offline script deciding a write set and wrong for a request path, and the module
 * boundary is what keeps the distinction legible. Promoted out of
 * `scripts/rederive-memory-associations.ts` by mt#4783 — three scripts had begun hand-rolling
 * the same contract, which is the divergent-copy shape a centralised pass exists to prevent.
 *
 * @see mt#4783 (this module) · mt#4761 (the cap) · mt#4765 (the original implementation)
 */

import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { MemoryRecord } from "@minsky/domain/memory/types";

/**
 * Page size for the census walk. Matches `DEFAULT_LIST_CAP` so a page request is never itself
 * silently truncated — asking for more than the cap would return the cap and read as a short
 * page, ending the walk early at exactly the wrong moment.
 */
export const MEMORY_CENSUS_PAGE_SIZE = 500;

/**
 * The narrow slice of `MemoryServiceSurface` a census needs. A real `MemoryService` satisfies
 * it structurally; a test stub needs only these two methods.
 *
 * `count` is optional on the surface itself (a fake may omit it), which is why
 * {@link listEveryMemory} refuses rather than assuming when it is absent — see below.
 */
export type MemoryCensusSource = Pick<MemoryServiceSurface, "list" | "count">;

/**
 * Page through the WHOLE corpus, then assert the scan actually covered it.
 *
 * Throws — never returns a partial result — when coverage cannot be proven. Both failure modes
 * are deliberate:
 *
 * - **No `count()`.** The surface marks it optional, and consumers that omit it are documented
 *   as treating `list()`'s result as the full matching set. A census caller must not inherit
 *   that assumption: without a floor there is nothing to check the scan against, so proceeding
 *   would produce precisely the unfalsifiable number this function exists to prevent.
 * - **Short read.** Paging stopped early and every figure computed downstream would cover a
 *   fraction of the corpus.
 */
export async function listEveryMemory(service: MemoryCensusSource): Promise<MemoryRecord[]> {
  if (typeof service.count !== "function") {
    throw new Error(
      "MemoryService exposes no count(); cannot prove the scan covered the corpus. Refusing."
    );
  }

  // Count FIRST, and compare with `<`, not `!==`. Both choices absorb the same race — a record
  // INSERTED while the scan is in flight — from the two ends it can arrive at. Counting first
  // keeps the insert out of the floor; `<` tolerates it showing up in the scan. Either alone
  // would turn an ordinary concurrent write into a spurious failure.
  //
  // A concurrent DELETE is NOT absorbed, and that is the accepted trade rather than an
  // oversight: it lowers the scan below a floor already taken, so it throws. Fail-closed is the
  // right side to err on here — these are offline scripts about to decide a write set, deletes
  // during a run are rare, and offset paging can genuinely SKIP records when rows shift beneath
  // it, so a short read during deletion may be a real coverage gap rather than a phantom. Re-run
  // the script; do not relax the comparison to make it pass.
  //
  // What this catches is the case worth catching: a SHORT read, where paging silently stopped
  // early and every figure computed downstream covers a fraction of the corpus.
  const floor = await service.count();

  const out: MemoryRecord[] = [];
  for (let offset = 0; ; offset += MEMORY_CENSUS_PAGE_SIZE) {
    const page = await service.list({ limit: MEMORY_CENSUS_PAGE_SIZE, offset });
    out.push(...page);
    if (page.length < MEMORY_CENSUS_PAGE_SIZE) break;
  }

  if (out.length < floor) {
    throw new Error(
      `Scan covered ${out.length} of at least ${floor} memories — refusing to report a rate ` +
        "over a partial corpus. Investigate the pagination before trusting any number below."
    );
  }

  return out;
}
