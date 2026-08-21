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
//
// Columns are addressed BY HEADER NAME, never by position. PR #3217 R1 found
// SC8/SC9 unenforced outside the movable bucket, and the reason the gap was
// invisible is that positional indices silently mean different things in
// different tables: `cells[3]` is `Effects` in one and `Plane` in another. A
// header lookup fails loudly when a column is missing, which is the behaviour
// this file needs.

/* eslint-disable custom/no-real-fs-in-tests -- this file's entire purpose is
 * measuring the REAL `.minsky/hooks/` tree against a committed census. An
 * in-memory fs fake would assert the document against a fixture the fixture's
 * author chose, which is precisely the staleness this test exists to catch:
 * the failure mode is "the tree moved and nobody updated the doc", and a mock
 * tree cannot move. Same justification as `self-containment.test.ts`. */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// AT3 consumes the closure test's own constant rather than hand-copying the
// three baseline module names. Hand-copying is what lets the two drift apart,
// and the baseline set is precisely the thing a divergence would corrupt.
import { BASELINE_ROOTS } from "./self-containment.test";

// `fileURLToPath` rather than `new URL(...).pathname`: the latter leaves percent
// escapes encoded and mangles drive-letter paths (PR #3217 R1, non-blocking).
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HOOKS_DIR, "..", "..");
const DOC_PATH = join(REPO_ROOT, "docs", "architecture", "hook-module-inventory.md");

/** The census denominator — mirrors the `find` in the document's Reproduce section. */
function liveModules(): string[] {
  return readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

const splitCells = (line: string): string[] =>
  line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());

interface DocRow {
  module: string;
  section: string;
  /** Column value by header name; undefined when the table has no such column. */
  get(header: string): string | undefined;
}

/**
 * Parse the document's tables.
 *
 * A row is a table line whose first cell is a backticked module name. Each row
 * carries the header line of the table it sits in, so columns resolve by name.
 */
function parseRows(doc: string): DocRow[] {
  const rows: DocRow[] = [];
  let section = "";
  let headers: string[] = [];

  for (const line of doc.split("\n")) {
    const heading = /^#{2,3}\s+(.*)$/.exec(line);
    if (heading?.[1]) {
      section = heading[1];
      headers = [];
      continue;
    }
    if (!line.startsWith("|")) continue;

    const cells = splitCells(line);
    const first = cells[0] ?? "";

    // A header line: first cell is a plain word, not a backticked module.
    if (!first.startsWith("`")) {
      if (!/^-+$/.test(first)) headers = cells;
      continue;
    }

    const module = first.replace(/`/g, "");
    if (!module.endsWith(".ts")) continue;

    const columns = headers;
    rows.push({
      module,
      section,
      get(header: string) {
        const i = columns.indexOf(header);
        return i === -1 ? undefined : cells[i];
      },
    });
  }
  return rows;
}

/** Rows under the three bucket tables — excludes the cross-check tables, which re-list modules. */
function bucketOf(section: string): string | undefined {
  if (section.startsWith("already-domain")) return "already-domain";
  if (section.startsWith("movable") || section.startsWith("ADR-026 tier")) return "movable";
  if (section.startsWith("immovable")) return "immovable";
  return undefined;
}

const doc = readFileSync(DOC_PATH, "utf8");
const allRows = parseRows(doc);
const buckets = new Map<string, DocRow[]>();
for (const r of allRows) {
  const b = bucketOf(r.section);
  if (!b) continue;
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b)?.push(r);
}
const classified = [...buckets.values()].flat();

/** Header cells that must be present and non-empty on EVERY classified row. */
const REQUIRED_EVERY_ROW = ["Effects", "Plane"] as const;

const blankIn = (rows: DocRow[], header: string): string[] =>
  rows
    .filter((r) => {
      const v = r.get(header);
      return v === undefined || v === "" || v === "—";
    })
    .map((r) => r.module);

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

  // The Totals table is what a reader looks at first, and nothing tied it to the
  // tables beneath (PR #3217 R1, non-blocking). A stale Totals row is the most
  // readable possible way for this document to be wrong.
  test("AT1: the Totals table matches the derived bucket counts", () => {
    for (const [bucket, rows] of buckets) {
      const row = new RegExp(`^\\|\\s*${bucket}\\s*\\|\\s*(\\d+)\\s*\\|$`, "m").exec(doc);
      expect(row, `no Totals row for "${bucket}"`).not.toBeNull();
      expect(Number(row?.[1]), `Totals row for ${bucket}`).toBe(rows.length);
    }
    const total = /^\|\s*\*\*total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|$/m.exec(doc);
    expect(total, "no bolded total row").not.toBeNull();
    expect(Number(total?.[1])).toBe(liveModules().length);
  });

  // AT2 — asserted mechanically over the artifact rather than by reading it.
  test("AT2: every immovable module carries a non-empty reason", () => {
    expect(blankIn(buckets.get("immovable") ?? [], "Reason")).toEqual([]);
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
      expect(row?.get("Reason") ?? "").toContain("product-baseline");
      expect(row?.get("Plane"), `${root} plane`).toBe("product");
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
    expect(row?.get("Reason") ?? "").toContain("RFC");
  });

  // AT6 / SC8 / SC9 — these are per-MODULE criteria, not per-movable-module.
  // Asserted across every bucket, because the movable-only version of this
  // check is exactly what shipped in R1 and missed two whole tables.
  test("AT6/SC8/SC9: every classified module records Effects and Plane", () => {
    const missing: Record<string, string[]> = {};
    for (const [bucket, rows] of buckets) {
      for (const header of REQUIRED_EVERY_ROW) {
        const blank = blankIn(rows, header);
        if (blank.length) missing[`${bucket}.${header}`] = blank;
      }
    }
    expect(missing).toEqual({});
  });

  // The columns themselves must exist on every bucket table — a table missing
  // the column entirely yields `undefined` for every row, which the emptiness
  // check above would also catch, but this names the cause rather than listing
  // every module in the table.
  test("AT6/SC8/SC9: every bucket table declares the Effects and Plane columns", () => {
    for (const [bucket, rows] of buckets) {
      const sample = rows[0];
      expect(sample, `${bucket} table is empty`).toBeDefined();
      for (const header of REQUIRED_EVERY_ROW) {
        expect(sample?.get(header), `${bucket} table has no "${header}" column`).toBeDefined();
      }
    }
  });

  // SC6 — the extraction unit is movable-only by construction: a module with no
  // decision to lift has no unit to name.
  test("AT6/SC6: every movable module names an extraction unit", () => {
    expect(blankIn(buckets.get("movable") ?? [], "Extraction unit")).toEqual([]);
  });

  // The tier split is what mt#4374 SC7 selects on ("prefer a wave that avoids
  // persistence"), so the tier-1 table must hold exactly the modules that
  // actually reach persistence — re-derived, not trusted.
  test("AT6/SC7: the tier-1 table holds exactly the persistence-reaching movable modules", () => {
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
  // claiming a divergence must be revisited rather than left stale.
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
