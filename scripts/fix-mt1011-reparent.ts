#!/usr/bin/env bun
/**
 * One-shot data fix for mt#1011: re-link children mt#1006–mt#1010 to the
 * correct parent mt#1012 (Minsky-native memory system Phase 1).
 *
 * Background: tasks_create under a stale MCP server silently clobbered
 * mt#1005 instead of creating a new task (id-collision bug, mt#1011).
 * The 5 children were then created with parent: mt#1005 (the unrelated
 * "Persist subagent execution history records" task).  This script moves
 * them to the intended parent mt#1012.
 *
 * The actual reparenting logic is the same as the MCP tool tasks.reparent
 * (added in mt#1011): removeParent then addParent.
 *
 * Safe to run multiple times — skips children that are already correctly
 * parented to mt#1012.
 *
 * Usage:
 *   bun run scripts/fix-mt1011-reparent.ts
 *   bun run scripts/fix-mt1011-reparent.ts --dry-run
 */

import "reflect-metadata";
import { createCliContainer } from "../src/composition/cli";
import type { TaskGraphService } from "../src/domain/tasks/task-graph-service";
import { initializeConfiguration, CustomConfigFactory } from "../src/domain/configuration";

const OLD_PARENT = "mt#1005";
const NEW_PARENT = "mt#1012";
const CHILDREN = ["mt#1006", "mt#1007", "mt#1008", "mt#1009", "mt#1010"];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("🔍 Dry-run mode — no changes will be written\n");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const graph = (await container.get("taskGraphService")) as TaskGraphService;

  // ── Before state ────────────────────────────────────────────────────────────
  console.log("Before:");
  const oldChildren = await graph.listChildren(OLD_PARENT);
  const newChildren = await graph.listChildren(NEW_PARENT);
  console.log(
    `  tasks_children ${OLD_PARENT}: ${oldChildren.length > 0 ? oldChildren.join(", ") : "(none)"}`
  );
  console.log(
    `  tasks_children ${NEW_PARENT}: ${newChildren.length > 0 ? newChildren.join(", ") : "(none)"}`
  );
  console.log();

  // ── Reparent each child ──────────────────────────────────────────────────────
  for (const child of CHILDREN) {
    const currentParent = await graph.getParent(child);

    if (currentParent === NEW_PARENT) {
      console.log(`✓ ${child}: already parented to ${NEW_PARENT}, skipping`);
      continue;
    }

    if (currentParent !== OLD_PARENT && currentParent !== null) {
      console.log(
        `⚠ ${child}: unexpected current parent ${String(currentParent)}; ` +
          `expected ${OLD_PARENT} or null. Skipping for safety.`
      );
      continue;
    }

    if (dryRun) {
      const fromDesc = currentParent ?? "(none)";
      console.log(`  [dry-run] ${child}: would move from ${fromDesc} → ${NEW_PARENT}`);
      continue;
    }

    if (currentParent === OLD_PARENT) {
      const { removed } = await graph.removeParent(child);
      console.log(`  ${child}: removed parent ${OLD_PARENT} (removed=${String(removed)})`);
    }

    const { created } = await graph.addParent(child, NEW_PARENT);
    console.log(`  ${child}: added parent ${NEW_PARENT} (created=${String(created)})`);
  }

  if (!dryRun) {
    // ── After state ──────────────────────────────────────────────────────────
    console.log("\nAfter:");
    const afterOld = await graph.listChildren(OLD_PARENT);
    const afterNew = await graph.listChildren(NEW_PARENT);
    console.log(
      `  tasks_children ${OLD_PARENT}: ${afterOld.length > 0 ? afterOld.join(", ") : "(none)"}`
    );
    console.log(
      `  tasks_children ${NEW_PARENT}: ${afterNew.length > 0 ? afterNew.join(", ") : "(none)"}`
    );

    // ── Verify all 5 children ────────────────────────────────────────────────
    console.log("\nVerification — tasks_parent for each child:");
    let allOk = true;
    for (const child of CHILDREN) {
      const parent = await graph.getParent(child);
      const ok = parent === NEW_PARENT;
      console.log(`  tasks_parent ${child} → ${String(parent)} ${ok ? "✓" : "✗"}`);
      if (!ok) allOk = false;
    }

    if (allOk) {
      console.log("\n✅ Reparenting complete and verified.");
    } else {
      console.error("\n❌ Some children were not correctly reparented — check output above.");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
