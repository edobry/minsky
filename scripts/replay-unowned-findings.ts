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
 * Usage:
 *   bun scripts/replay-unowned-findings.ts
 *   bun scripts/replay-unowned-findings.ts --json
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
      select t.id as task_id, t.status::text as status, s.content as content
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
      return [{ task_id: taskId, status: typeof status === "string" ? status : "", content }];
    });
  } catch {
    return null;
  }
}

const specs = await loadSpecs();
if (specs === null) {
  console.log("SKIP: persistence unreachable — no corpus to replay.");
  process.exit(0);
}

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
