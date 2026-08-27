/* eslint-disable custom/no-real-fs-in-tests -- this test IS a census of the real source tree; an injected fs would assert something about the mock rather than about the repo, which is the one thing it exists to check */
/**
 * mt#4543 AT2/SC6 — the method-presence idiom does not come back.
 *
 * `"getDatabaseConnection" in provider` cannot distinguish a real provider from
 * `UnconfiguredPersistenceProvider`, which defines the method and throws from it. 27
 * production sites asked it that way; `isSqlCapable` and its siblings replaced them.
 *
 * This test is the pin. It is a census with an ALLOWLIST rather than a flat "zero hits"
 * assertion, because two occurrences are legitimate and a bare zero-check would have to be
 * silenced rather than explained — and because the failure message can then say WHICH file
 * is new, which is the whole value at the moment someone trips it.
 *
 * Scope note: `scripts/` is deliberately excluded. A `verify-*` / `smoke-*` tool that
 * throws when no database is configured is behaving correctly and a developer running one
 * wants the loud failure; converting those is churn without a behavior it improves. That
 * is a scope decision recorded in mt#4543's `## Scope`, not an oversight.
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Repo root, from this file's location. */
const ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** Trees whose call sites this task converted. `scripts/` is out of scope — see above. */
const ROOTS = ["src", "packages", "services"];

const IDIOM = /"(getDatabaseConnection|getRawSqlConnection|getListenCapableSqlConnection)"\s+in\s+/;

/**
 * The only files allowed to contain the idiom, each with the reason.
 *
 * Adding an entry here is a deliberate act that needs a sentence. Removing one is fine.
 */
const ALLOWED = new Map<string, string>([
  [
    "packages/domain/src/tasks/taskService.ts",
    "Deliberate exemption: admitting the unconfigured placeholder is the POINT — it throws " +
      "the verbatim boot reason, which the catch carries into setBackendUnavailable so " +
      "listTasks raises with it. A capability guard short-circuits before the throw and the " +
      "cause is replaced by a generic string. Pinned by mt#3636's boot-reason test.",
  ],
  [
    "packages/domain/src/persistence/types.ts",
    "The guard's own docblock quotes the idiom it replaces.",
  ],
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) yield full;
  }
}

describe("the SQL-capability method-presence idiom stays retired (mt#4543)", () => {
  test('no production file outside the allowlist asks `"get*Connection" in provider`', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(ROOT, root))) {
        if (!IDIOM.test(readFileSync(file, "utf8"))) continue;
        const rel = relative(ROOT, file);
        if (!ALLOWED.has(rel)) offenders.push(rel);
      }
    }

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `Use isSqlCapable / hasRawSqlConnection / hasListenCapableSqlConnection from ` +
            `packages/domain/src/persistence/types.ts instead. Method presence alone cannot ` +
            `tell a real provider from UnconfiguredPersistenceProvider, which defines the ` +
            `method and throws from it. If the site genuinely needs the old form, add it to ` +
            `ALLOWED in this file with the reason.\nNew site(s): ${offenders.join(", ")}`
    ).toEqual([]);
  });

  test("every allowlisted file still contains the idiom", () => {
    // A stale allowlist entry is not harmless: it reads as "this site is a known
    // exception" long after the site changed, and the next reader inherits that as
    // settled. If one of these fails, delete the entry rather than restoring the idiom.
    for (const [rel] of ALLOWED) {
      const contents = readFileSync(join(ROOT, rel), "utf8");
      expect(
        IDIOM.test(contents),
        `${rel} no longer contains the idiom — drop its ALLOWED entry`
      ).toBe(true);
    }
  });
});
