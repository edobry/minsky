/**
 * One-shot: strip `commitHash` (and any other unknown keys) from the
 * `prState` JSON blob on all session records.
 *
 * Background: mt#1056 removed `commitHash` from the TypeScript types for
 * `SessionRecord.prState` and `Session.prState`, but the field lives inside
 * a JSON blob column (`text("prState", { mode: "json" })`), so existing DB
 * rows still carry it. This script projects each stored `prState` down to
 * the current type's allowed key set and persists only the clean blob.
 *
 * Allowed keys: branchName, exists, lastChecked, createdAt, mergedAt.
 *
 * Safe to run multiple times — skips rows that are already clean.
 */

import "reflect-metadata";
import { createCliContainer } from "../src/composition/cli";
import { initializeConfiguration, CustomConfigFactory } from "../src/domain/configuration";
import type { SessionProviderInterface } from "../src/domain/session/types";

const ALLOWED_KEYS = new Set(["branchName", "exists", "lastChecked", "createdAt", "mergedAt"]);

async function main() {
  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const sessionProvider = (await container.get("sessionProvider")) as SessionProviderInterface;

  const sessions = await sessionProvider.listSessions();

  let scanned = 0;
  let modified = 0;

  for (const record of sessions) {
    scanned++;

    if (!record.prState) {
      console.log(`✓ ${record.session}: no prState, skipping`);
      continue;
    }

    // Project to allowed keys only
    const existing = record.prState as Record<string, unknown>;
    const unknownKeys = Object.keys(existing).filter((k) => !ALLOWED_KEYS.has(k));

    if (unknownKeys.length === 0) {
      console.log(`✓ ${record.session}: already clean`);
      continue;
    }

    // Build projected blob with only allowed keys
    const projected: Record<string, unknown> = {};
    for (const key of ALLOWED_KEYS) {
      if (key in existing) {
        projected[key] = existing[key];
      }
    }

    await sessionProvider.updateSession(record.session, {
      prState: projected as typeof record.prState,
    });

    console.log(`  ${record.session}: stripped keys [${unknownKeys.join(", ")}]`);
    modified++;
  }

  console.log(`\nDone. Scanned ${scanned} sessions, modified ${modified}.`);
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
