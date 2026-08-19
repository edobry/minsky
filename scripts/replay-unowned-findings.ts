#!/usr/bin/env bun
/**
 * Replay `unowned-finding-scan` over the whole task-spec corpus (mt#4246).
 *
 * The question this answers: **how often would the guard have fired, and on
 * what?** That number decides the posture, and it cannot be reasoned about from
 * the code — the corpus has to be run.
 *
 * EXHAUSTIVE, not sampled. An earlier draft shelled out to `minsky tasks spec
 * get` once per task; at ~0.8s of bun startup apiece it could not finish more
 * than ~150 of 4,146 specs inside a tool timeout, and the 150 it did reach
 * returned zero — a sampling artifact that reads exactly like a real zero. It
 * now issues ONE query through the persistence provider, the same shape
 * `scripts/verify-duplicate-signature-scan.ts` uses, and scans every row.
 *
 * The distinction matters beyond speed: this guard's whole subject is a section
 * that appears in a handful of specs. A sampled replay of a rare pattern
 * measures the sampler, not the pattern.
 *
 * ## Why this scans everything, not the spec's "last 30 days of DONE" window
 *
 * A deliberate deviation from mt#4246's SC5 wording, recorded here rather than
 * left for a reader to notice (PR #3098 R1, NON-BLOCKING).
 *
 * The findings section occurs in 3 of ~4,100 specs. A 30-day window over DONE
 * transitions would very likely contain ZERO of them — and a zero from a window
 * that small is indistinguishable from "the guard never fires", which is the
 * exact confusion the first draft of this script already produced by sampling
 * 150 specs. Narrowing the corpus to make the number match the spec's phrasing
 * would trade a real measurement for a vacuous one.
 *
 * The window is not lost, only computed the other way round: every fired item
 * is printed WITH its task's current status, and the summary carries
 * `unownedItemsOnDoneTasks`, so the DONE subset the spec asked about is read
 * off this output rather than baked into the query. The exhaustive count is
 * additionally an upper bound on the live rate — items that WOULD fire if their
 * task transitioned today — which is the useful number for setting posture.
 *
 * Usage:
 *   bun scripts/replay-unowned-findings.ts
 *   bun scripts/replay-unowned-findings.ts --json
 *   bun scripts/replay-unowned-findings.ts --done-only --since 2026-07-19   # SC5's window
 *
 * Exits 0 when it completes, including a clean SKIP when persistence is
 * unreachable (CI has no local DB).
 */
import "reflect-metadata";
import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";
import { detectUnownedFindings } from "../.minsky/hooks/unowned-finding-scan";
import type { SqlCapablePersistenceProvider } from "../packages/domain/src/persistence/types";

interface SpecRow {
  task_id: string;
  status: string;
  content: string;
  updated_at: string;
}

/**
 * The spec's SC5 window, available on demand (PR #3098 R2, BLOCKING).
 *
 * `--done-only` restricts to tasks currently in DONE; `--since <ISO date>`
 * restricts to tasks updated on or after that date. Together they are the
 * "last 30 days of DONE transitions" corpus SC5 names, using the task's own
 * `updated_at` as the transition proxy — the tasks table keeps no per-status
 * transition log, so this is the closest available signal and is named as a
 * proxy rather than presented as the transition time itself.
 *
 * The DEFAULT is still exhaustive, for the reason in the header: over this
 * corpus the window is expected to contain zero findings sections, and a zero
 * from a window that small is indistinguishable from "the guard never fires".
 * Both numbers are worth having, which is why this is a flag and not a rewrite.
 */
function windowFilter(): { doneOnly: boolean; since: string | null } {
  const at = process.argv.indexOf("--since");
  const raw = at >= 0 ? process.argv[at + 1] : undefined;
  const since = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
  return { doneOnly: process.argv.includes("--done-only"), since };
}

async function loadSpecs(): Promise<SpecRow[] | null> {
  try {
    const bootstrap = await ensureHookDomainBootstrap();
    if (!bootstrap.ok) return null;
    const { resolvePersistenceProvider } = await import(
      "../packages/domain/src/persistence/factory"
    );
    const provider = await resolvePersistenceProvider();
    if (!provider?.capabilities.sql) return null;
    const db = await (provider as SqlCapablePersistenceProvider).getDatabaseConnection();
    if (!db) return null;
    const { sql } = await import("drizzle-orm");
    const rows = await db.execute(sql`
      select t.id as task_id, t.status::text as status, s.content as content,
             t.updated_at::text as updated_at
      from task_specs s join tasks t on t.id = s.task_id
    `);
    if (!Array.isArray(rows)) return null;
    // Narrowed by shape rather than asserted: the driver's row type is `unknown`
    // per column, and a spec whose content is not a string must be skipped, not
    // coerced.
    return rows.flatMap((row) => {
      if (typeof row !== "object" || row === null) return [];
      const r = row as Record<string, unknown>;
      const taskId = r["task_id"];
      const status = r["status"];
      const content = r["content"];
      if (typeof taskId !== "string" || typeof content !== "string") return [];
      const updatedAt = r["updated_at"];
      return [
        {
          task_id: taskId,
          status: typeof status === "string" ? status : "",
          content,
          updated_at: typeof updatedAt === "string" ? updatedAt : "",
        },
      ];
    });
  } catch {
    return null;
  }
}

const allSpecs = await loadSpecs();
if (allSpecs === null) {
  console.log("SKIP: persistence unreachable — no corpus to replay.");
  process.exit(0);
}

const { doneOnly, since } = windowFilter();
const specs = allSpecs.filter(
  (row) => (!doneOnly || row.status === "DONE") && (since === null || row.updated_at >= since)
);
const corpusLabel =
  doneOnly || since !== null
    ? `SC5 window (${doneOnly ? "DONE only" : "any status"}${since === null ? "" : `, updated >= ${since}`}) — ${specs.length} of ${allSpecs.length} specs`
    : `exhaustive — all ${specs.length} specs`;
console.log(`Corpus: ${corpusLabel}\n`);

const fired: {
  taskId: string;
  status: string;
  section: string;
  bareRefPresent: boolean;
  item: string;
}[] = [];
const tasksWithSection = new Set<string>();

for (const row of specs) {
  const content = typeof row.content === "string" ? row.content : "";
  if (content === "") continue;
  const findings = detectUnownedFindings(content);
  if (findings.length > 0) tasksWithSection.add(row.task_id);
  for (const f of findings) {
    fired.push({
      taskId: row.task_id,
      status: row.status,
      section: f.section,
      bareRefPresent: f.bareRefPresent,
      item: f.item.length > 220 ? `${f.item.slice(0, 220)}…` : f.item,
    });
  }
}

const summary = {
  specsScanned: specs.length,
  unownedItems: fired.length,
  tasksWithAtLeastOne: tasksWithSection.size,
  itemsCarryingABareRef: fired.filter((f) => f.bareRefPresent).length,
  // The subset mt#4246's SC5 asks about, derived rather than queried — see the
  // header for why the corpus is not narrowed to a window.
  unownedItemsOnDoneTasks: fired.filter((f) => f.status === "DONE").length,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...summary, fired }, null, 2));
} else {
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  for (const f of fired) {
    console.log(
      `--- ${f.taskId} [${f.status}] · ${f.section}${f.bareRefPresent ? " · bare-ref" : ""}`
    );
    console.log(`    ${f.item}`);
  }
}

console.log(
  `\nPASS: scanned ${summary.specsScanned} specs; ${summary.unownedItems} unowned item(s) ` +
    `across ${summary.tasksWithAtLeastOne} task(s); ${summary.itemsCarryingABareRef} carry a bare reference.`
);
console.log(
  "Hand-classify the items above before any posture change — this measures the rate, it does not judge it."
);
