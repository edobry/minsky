/**
 * Structural guard: a cockpit module that resolves the shared persistence
 * provider AND holds module-level mutable state must participate in the
 * persistence-epoch contract (mt#3721).
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. mt#3638 shipped the epoch mechanism
 * and documented the contract in `getPersistenceEpoch`'s doc comment: *"Every
 * consumer that caches anything derived from the shared provider ... records the
 * epoch it cached at and re-resolves when it moves."* A contract asserted only
 * in a doc comment is satisfied by whoever happens to read it. Eight consumers
 * did not, and the gap was invisible until a pool recycle restored the pool
 * while five widget endpoints kept serving placeholders from handles to the
 * ENDED one (2026-08-05; `/api/health` reporting `db: "ok"` at 152ms throughout).
 * The gap OPENED after mt#3638 shipped, which is exactly the shape a convention
 * cannot hold closed.
 *
 * WHAT IT CHECKS. For each non-test file under `src/cockpit` that resolves the
 * provider (`getSharedPersistenceService` / `getCachedPersistenceProvider`) and
 * declares module-level mutable state (`let _foo`), require one of:
 *   - a reference to the epoch machinery (`createEpochKeyedCache` or
 *     `getPersistenceEpoch`), or
 *   - an `epoch-exempt: <reason>` marker, for state that genuinely is not
 *     provider-derived.
 *
 * The marker convention (a greppable annotation carrying its own reason) mirrors
 * `sql-capability-message:` from mt#3661 / `scripts/check-sql-capability-messages.ts`.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Whether a given `let` is *actually*
 * provider-derived — that is a semantic judgment no regex settles, and mt#3721's
 * own spec got it wrong once (it predicted the SSE broker in `routes/events.ts`
 * was provider-independent; the broker holds a LISTEN connection from the
 * provider, so it was not). This guard therefore fires on the CO-OCCURRENCE and
 * makes a human answer the question, rather than pretending to answer it.
 * Consequence: it can ask about state that turns out to be exempt — that is the
 * intended trade, and the marker is how you record the answer.
 *
 * Reading the real source tree IS the contract here — a mocked fs would assert
 * that this file's regexes work on a fixture, which is precisely the property
 * that does NOT need guarding. Same file-wide-disable posture and reason as
 * `src/cockpit/port-recovery.test.ts` and `src/mcp/disconnect-tracker.test.ts`.
 * The rule's target — cross-test interference from filesystem writes — cannot
 * occur here: this scan is strictly read-only and touches no temp state.
 */
/* eslint-disable custom/no-real-fs-in-tests -- scanning the real source tree IS the contract */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const COCKPIT_DIR = join(import.meta.dir);

/** Resolving the shared provider is what makes a module a "consumer". */
const PROVIDER_RESOLVERS = /getSharedPersistenceService|getCachedPersistenceProvider/;

/** Participating in the epoch contract. */
const EPOCH_MACHINERY = /createEpochKeyedCache|getPersistenceEpoch/;

/** Module-level mutable state: a top-of-file `let`, not one inside a function. */
const MODULE_LEVEL_LET = /^let\s+(\w+)/gm;

/**
 * Mutable state held on a class INSTANCE rather than at module level (mt#4480).
 *
 * The original guard matched only `^let`, and a long-lived singleton's instance
 * field caches across a recycle exactly as a module-level `let` does — the
 * lifetime that matters is the object's, not the declaration's syntax. That gap
 * was not theoretical: `TranscriptWatcher` held `private cachedDb` with no
 * epoch check, so one pool recycle killed the primary transcript-capture path
 * for the rest of the daemon's life while this guard passed.
 *
 * Keyed on the declared TYPE, not on the field's name (PR #3278 R1). A
 * name-based heuristic was tried first and is wrong in both directions: it
 * overmatches benign fields that merely contain the substring (`debugLevel`,
 * `poolSize`, `dbusClient`) and undermatches a real handle called `client`,
 * `driver`, or `sql`. Forcing exemption markers onto obvious non-offenders is
 * the worse half — it trains people to add the marker without reading it, which
 * costs the guard its meaning.
 *
 * A provider-derived handle is nearly always declared with an explicit type,
 * because it is initialised to `null` and needs one. That makes the type the
 * precise signal, and it is already scoped: this only runs on files that
 * resolve the persistence provider at all.
 *
 * `readonly` is excluded because it cannot be reassigned, so it cannot latch
 * onto a NEW handle — an epoch-keyed cache assigned once in a constructor is
 * the intended shape and must not be flagged.
 *
 * Residual gap, stated rather than papered over: a handle held with an inferred
 * type is invisible here. That is the same trade the module-level check makes —
 * this guard fires on a legible signal and asks a human, rather than pretending
 * to decide what is provider-derived.
 */
const HANDLE_TYPE_NAMES =
  "PostgresJsDatabase|PersistenceService|PersistenceProvider|SqlCapablePersistenceProvider|DatabaseConnection|Sql";
const INSTANCE_LEVEL_CACHE = new RegExp(
  String.raw`^\s*(?:private|protected|public)\s+(?!readonly\b)(\w+)\s*:\s*[^;\n=]*\b(?:${HANDLE_TYPE_NAMES})\b`,
  "gm"
);

/** Opt-out marker carrying its own reason, e.g. `// epoch-exempt: warn rate-limit clock`. */
const EXEMPT_MARKER = /epoch-exempt:/;

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // `web/` is the frontend module graph — it has no server-side persistence.
    if (entry === "web" || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    acc.push(full);
  }
  return acc;
}

describe("persistence-epoch cache coverage (mt#3721)", () => {
  test("every provider-consuming module with module-level state honors the epoch contract", () => {
    const offenders: string[] = [];

    for (const file of collectTsFiles(COCKPIT_DIR)) {
      const source: string = readFileSync(file).toString();
      if (!PROVIDER_RESOLVERS.test(source)) continue;

      const lets = [...source.matchAll(MODULE_LEVEL_LET)].map((m) => m[1]);
      // mt#4480: an instance field on a long-lived object latches across a
      // recycle exactly as a module-level `let` does.
      const fields = [...source.matchAll(INSTANCE_LEVEL_CACHE)].map((m) => m[1]);
      const state = [...lets, ...fields];
      if (state.length === 0) continue;

      if (EPOCH_MACHINERY.test(source) || EXEMPT_MARKER.test(source)) continue;

      offenders.push(
        `${file.replace(COCKPIT_DIR, "src/cockpit")} — mutable state ` +
          `[${state.join(", ")}] in a module that resolves the persistence provider, ` +
          `with no epoch check and no 'epoch-exempt:' marker.`
      );
    }

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These modules cache across a pool recycle without honoring the persistence epoch.\n` +
            `A recycle (mt#3638) ends the old pool; postgres-js then rejects every query on a\n` +
            `handle derived from it with CONNECTION_ENDED, forever. Wrap the resolution in\n` +
            `createEpochKeyedCache (src/cockpit/shared-persistence.ts), or add an\n` +
            `'// epoch-exempt: <reason>' marker if the state is genuinely not provider-derived.\n\n${offenders
              .map((o) => `  - ${o}`)
              .join("\n")}`
    ).toEqual([]);
  });

  test("the guard can actually fail — a synthetic offender is detected", () => {
    // Negative control for the guard itself: the checks above are only worth
    // running if they discriminate. Exercise the same predicates against a
    // module shape that SHOULD be flagged.
    const offending = `
      import { getSharedPersistenceService } from "../shared-persistence";
      let _cachedThing: unknown = null;
      export async function get() {
        if (_cachedThing) return _cachedThing;
        _cachedThing = (await getSharedPersistenceService()).getProvider();
        return _cachedThing;
      }
    `;

    expect(PROVIDER_RESOLVERS.test(offending)).toBe(true);
    expect([...offending.matchAll(/^\s*let\s+(\w+)/gm)].length).toBeGreaterThan(0);
    expect(EPOCH_MACHINERY.test(offending)).toBe(false);
    expect(EXEMPT_MARKER.test(offending)).toBe(false);
  });

  test("an INSTANCE-field cache is detected too (mt#4480)", () => {
    // Negative control for the widening, written from the real pre-fix source
    // of `TranscriptWatcher.resolveDb` rather than from an invented shape. The
    // guard passed on this for as long as it existed, because `cachedDb` is a
    // class field and the original predicate matched only `^let`. One pool
    // recycle then killed the primary transcript-capture path permanently.
    const offending = `
      import { getSharedPersistenceService } from "./shared-persistence";
      export class Watcher {
        private cachedDb: PostgresJsDatabase | null = null;
        private async resolveDb(): Promise<PostgresJsDatabase | null> {
          if (this.cachedDb) return this.cachedDb;
          const db = await this.getDb();
          if (db) this.cachedDb = db;
          return db;
        }
      }
    `;

    expect(PROVIDER_RESOLVERS.test(offending)).toBe(true);
    // The OLD predicate does not see it — this is the gap, stated as an assertion.
    expect([...offending.matchAll(MODULE_LEVEL_LET)].length).toBe(0);
    // The new one does.
    const fields = [...offending.matchAll(INSTANCE_LEVEL_CACHE)].map((m) => m[1]);
    expect(fields).toContain("cachedDb");
    expect(EPOCH_MACHINERY.test(offending)).toBe(false);
    expect(EXEMPT_MARKER.test(offending)).toBe(false);
  });

  test("a readonly epoch-keyed field is NOT flagged", () => {
    // The shape the fix produces must not be an offender, or the widening would
    // just push everyone toward exemption markers. `readonly` cannot be
    // reassigned, so it cannot latch onto a new handle.
    const fixed = `
      import { createEpochKeyedCache } from "./shared-persistence";
      export class Watcher {
        private readonly resolveDbCached: () => Promise<PostgresJsDatabase | null>;
      }
    `;
    expect([...fixed.matchAll(INSTANCE_LEVEL_CACHE)].length).toBe(0);
  });

  test("benign fields whose NAMES look cache-ish are not flagged (PR #3278 R1)", () => {
    // The first draft keyed on the name and would have flagged every one of
    // these, forcing exemption markers onto fields that hold no handle. The
    // reviewer named these three exactly.
    const benign = `
      export class Thing {
        private debugLevel: number = 0;
        private poolSize: number = 15;
        private dbusClient: string | null = null;
        private cachedCount = 0;
      }
    `;
    expect([...benign.matchAll(INSTANCE_LEVEL_CACHE)].length).toBe(0);
  });

  test("a real handle is flagged whatever it is NAMED (PR #3278 R1)", () => {
    // The other direction the reviewer named: a name-based rule misses a handle
    // called `client`, `driver`, or `sql`. Keying on the TYPE catches all of
    // them without needing to enumerate naming habits.
    const handles = `
      export class Thing {
        private client: PostgresJsDatabase | null = null;
        private driver: Sql | null = null;
        private store: PersistenceService | null = null;
      }
    `;
    const found = [...handles.matchAll(INSTANCE_LEVEL_CACHE)].map((m) => m[1]);
    expect(found).toEqual(["client", "driver", "store"]);
  });
});
