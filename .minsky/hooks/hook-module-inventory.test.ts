// Staleness control for `docs/architecture/hook-module-inventory.md` (mt#4372).
//
// The inventory is a census of a population that drifts with every merged hook,
// so a hand-maintained table would age silently — which is the drift class
// mt#3586 exists to detect, and exactly what mt#4372 AT5 asks this file to
// prevent. Every MECHANICAL column is re-derived here from the live tree; a
// merged hook that nobody classified fails the suite rather than quietly
// leaving the document wrong.
//
// What this file does NOT check: the JUDGED columns (bucket, immovable reason,
// extraction unit). Whether a decision can be lifted is not statically
// decidable — a person reads the module. This asserts that a judgement EXISTS
// for every live module and is well-formed, not that it is correct.

/* eslint-disable custom/no-real-fs-in-tests -- this file's entire purpose is
 * measuring the REAL `.minsky/hooks/` tree against a committed census. An
 * in-memory fs fake would assert the document against a fixture the fixture's
 * author chose, which is precisely the staleness this test exists to catch:
 * the failure mode is "the tree moved and nobody updated the doc", and a mock
 * tree cannot move. Same justification as `self-containment.test.ts`. */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// AT3 consumes the closure test's own constant rather than hand-copying the
// three baseline module names. Hand-copying is what lets the two drift apart,
// and the baseline set is precisely the thing a divergence would corrupt.
import { BASELINE_ROOTS } from "./self-containment.test";

const HOOKS_DIR = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = join(HOOKS_DIR, "..", "..");
const DOC_PATH = join(REPO_ROOT, "docs", "architecture", "hook-module-inventory.md");

/** The census denominator — mirrors the `find` in the document's Reproduce section. */
function liveModules(): string[] {
  return readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

interface DocRow {
  module: string;
  cells: string[];
  section: string;
}

/**
 * Parse the document's bucket tables.
 *
 * A row is a table line whose FIRST cell is a backticked module name, which is
 * how every bucket table is written and how no prose line is written. Section
 * is the nearest preceding `## `/`### ` heading, so a module appearing under
 * two headings is detectable rather than silently merged.
 */
function parseRows(doc: string): DocRow[] {
  const rows: DocRow[] = [];
  let section = "";
  for (const line of doc.split("\n")) {
    const heading = /^#{2,3}\s+(.*)$/.exec(line);
    if (heading?.[1]) {
      section = heading[1];
      continue;
    }
    if (!line.startsWith("| `")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const first = cells[0];
    if (first === undefined) continue;
    const module = first.replace(/`/g, "");
    if (!module.endsWith(".ts")) continue;
    rows.push({ module, cells, section });
  }
  return rows;
}

/** Rows under the three bucket tables — excludes the cross-check tables, which re-list modules. */
function bucketRows(rows: DocRow[]): Map<string, DocRow[]> {
  const buckets = new Map<string, DocRow[]>();
  for (const r of rows) {
    const bucket = r.section.startsWith("already-domain")
      ? "already-domain"
      : r.section.startsWith("movable") || r.section.startsWith("ADR-026 tier")
        ? "movable"
        : r.section.startsWith("immovable")
          ? "immovable"
          : undefined;
    if (!bucket) continue;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)?.push(r);
  }
  return buckets;
}

const doc = readFileSync(DOC_PATH, "utf8");
const allRows = parseRows(doc);
const buckets = bucketRows(allRows);
const classified = [...buckets.values()].flat();

describe("hook module inventory (mt#4372)", () => {
  // AT5 — the staleness control. Both directions: a module nobody classified,
  // and a classified module that no longer exists.
  test("AT5: classifies exactly the live non-test module set", () => {
    const live = liveModules();
    const inDoc = classified.map((r) => r.module).sort();

    const unclassified = live.filter((m) => !inDoc.includes(m));
    const stale = inDoc.filter((m) => !live.includes(m));

    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  // AT1 — the three bucket counts sum to the live denominator, and every module
  // appears exactly once (SC1). A module in two buckets would still sum
  // correctly if another were missing, so both are asserted.
  test("AT1: bucket counts sum to the live module count, each module exactly once", () => {
    const live = liveModules();
    const seen = new Map<string, number>();
    for (const r of classified) seen.set(r.module, (seen.get(r.module) ?? 0) + 1);

    const duplicated = [...seen].filter(([, n]) => n > 1).map(([m]) => m);
    expect(duplicated).toEqual([]);
    expect(classified.length).toBe(live.length);
  });

  // AT1 (second half) — the counts written into the headings match the tables
  // beneath them. Without this a heading can say 84 while the table holds 83.
  test("AT1: each bucket heading's stated count matches its table", () => {
    for (const [bucket, rows] of buckets) {
      const stated = new RegExp(`^## ${bucket} \\((\\d+)\\)$`, "m").exec(doc);
      expect(stated, `no "## ${bucket} (N)" heading`).not.toBeNull();
      expect(Number(stated?.[1]), `${bucket} heading count`).toBe(rows.length);
    }
  });

  // AT2 — asserted mechanically over the artifact rather than by reading it.
  test("AT2: every immovable module carries a non-empty reason", () => {
    const missing = (buckets.get("immovable") ?? [])
      .filter((r) => {
        const reason = r.cells[2];
        return reason === undefined || reason === "" || reason === "—";
      })
      .map((r) => r.module);
    expect(missing).toEqual([]);
  });

  // AT3 — the product-baseline closure. An inventory that puts any of these in
  // "movable" has failed: they run from an arbitrary install path where no
  // `packages/domain` resolves, which is a module-resolution fact rather than a
  // convention mt#4373's reversal could retire.
  test("AT3: every BASELINE_ROOTS module is immovable, citing the baseline rule", () => {
    const immovable = buckets.get("immovable") ?? [];
    for (const root of BASELINE_ROOTS) {
      const row = immovable.find((r) => r.module === root);
      expect(row, `${root} is not in the immovable table`).toBeDefined();
      expect(row?.cells[2] ?? "").toContain("product-baseline");
    }
  });

  // AT4 — a module actually named on the RFC's `## What never migrates` list.
  // Deliberately NOT the branch-freshness guard: the RFC puts that one under
  // `## What's still open` with a "likely stays fat" hedge, so citing the
  // exclusion list for it would record a provenance the source does not carry.
  test("AT4: the RFC-named MessageDisplay module is immovable with the RFC cited", () => {
    const row = (buckets.get("immovable") ?? []).find(
      (r) => r.module === "linkify-message-display.ts"
    );
    expect(row, "linkify-message-display.ts is not in the immovable table").toBeDefined();
    expect(row?.cells[2] ?? "").toContain("RFC");
  });

  // AT6 — the per-module properties mt#4368 delegated to this inventory and
  // mt#4374 consumes. A blank cell here is what leaves a wave unable to scope
  // itself without re-reading every module.
  test("AT6: every movable module names an extraction unit", () => {
    const blank = (buckets.get("movable") ?? [])
      .filter((r) => {
        const unit = r.cells[2];
        return unit === undefined || unit === "" || unit === "—";
      })
      .map((r) => r.module);
    expect(blank).toEqual([]);
  });

  // The tier split is what mt#4374 SC7 selects on ("prefer a wave that avoids
  // persistence"), so the tier-1 table must hold exactly the modules that
  // actually reach persistence — re-derived, not trusted.
  test("AT6: the tier-1 table holds exactly the persistence-reaching movable modules", () => {
    const tier1Rows = allRows
      .filter((r) => r.section.startsWith("ADR-026 tier 1"))
      .map((r) => r.module)
      .sort();

    const liveTier1 = (buckets.get("movable") ?? [])
      .map((r) => r.module)
      .filter((m) => readFileSync(join(HOOKS_DIR, m), "utf8").includes("ensureHookDomainBootstrap"))
      .sort();

    expect(tier1Rows).toEqual(liveTier1);
  });

  // The document's headline correction. If a future change makes the pinned
  // grep and the real import set agree, this assertion fails and the prose
  // claiming a 30/30 divergence must be revisited rather than left stale.
  test("the grep-vs-import divergence the document reports still holds", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const domainRe = /packages\/domain|@minsky\/domain/;

    const grepMatched: string[] = [];
    const realImporters: string[] = [];
    for (const m of liveModules()) {
      const src = readFileSync(join(HOOKS_DIR, m), "utf8");
      if (!domainRe.test(src)) continue;
      grepMatched.push(m);
      const paths = transpiler.scanImports(src.replace(/^#![^\n]*\n/, "")).map((i) => i.path);
      if (paths.some((p) => domainRe.test(p))) realImporters.push(m);
    }

    // Not pinned to exact numbers — those drift with every merged hook. What is
    // asserted is the CLAIM: the grep over-reports, so the document's reason for
    // demoting it to a cross-check still stands.
    expect(grepMatched.length).toBeGreaterThan(realImporters.length);

    const divergence = grepMatched.filter((m) => !realImporters.includes(m));
    const listed = allRows
      .filter((r) => r.section.startsWith("Divergence"))
      .map((r) => r.module)
      .sort();
    expect(listed).toEqual(divergence.sort());
  });
});
