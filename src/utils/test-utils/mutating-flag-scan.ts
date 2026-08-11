/**
 * Read the drift gate's refusal set off the command sources (mt#3924).
 *
 * Two test files need the same answer to "which commands carry `mutating: true`?"
 * — `tool-effect-coverage.test.ts` pins the SET, `drift-gate.test.ts` exercises the
 * BEHAVIOR for each member. Deriving it twice would let the two drift apart, and a
 * behavior test that hard-codes its own list stops being evidence about the
 * registrations the moment one of them changes.
 *
 * Why a source scan rather than reading the registry: registering the commands
 * requires a DI container and per-module registration functions with different
 * signatures (`registerGitCommands(container)`, `registerPersistenceCommands(...)`,
 * class constructors taking provider thunks). The flag is a static property of the
 * registration site, so the sources answer the question directly and without
 * standing up half the application.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/** Where command registrations live, relative to the repo root. */
export const COMMANDS_DIR = "src/adapters/shared/commands";

/**
 * Matches both declaration shapes in use:
 * - object-literal registration — `mutating: true,`
 * - command class field — `readonly mutating = true;`
 *
 * Matching only the first under-reports the class-based commands
 * (`tasks.delete`, `tasks.bulk-edit`, `tasks.migrate-backend`).
 */
const MUTATING_FLAG_LINE = /^\s*(?:readonly\s+)?mutating\s*[:=]\s*true[,;]?\s*$/;

/**
 * Matches `id: "x.y"` and `readonly id = "x.y"`.
 *
 * The `\s*` before the separator is load-bearing and was missing in the original
 * (mt#3847) version of this scan: a class writes `readonly id = "tasks.delete"`
 * with spaces around the `=`, so `id[:=]` matched no class-based command at all.
 * That cost nothing while every flagged command was an object literal, and became
 * a silent under-report the moment mt#3924 flagged three class-based ones.
 */
const COMMAND_ID_LINE = /^\s*(?:readonly\s+)?id\s*[:=]\s*["'`]([a-z0-9._-]+)["'`]/i;

/** How far back to look for the id the flag belongs to. */
const ID_LOOKBACK_LINES = 200;

/**
 * Every command id whose registration carries the flag, deduplicated and sorted.
 */
export function scanMutatingFlaggedIds(dir: string = COMMANDS_DIR): string[] {
  return [...new Set(collect(dir))].sort();
}

function collect(dir: string): string[] {
  const ids: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      ids.push(...collect(path));
      continue;
    }
    if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
    const lines = String(readFileSync(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (!MUTATING_FLAG_LINE.test(line)) return;
      for (let j = index; j >= 0 && j > index - ID_LOOKBACK_LINES; j--) {
        const match = COMMAND_ID_LINE.exec(lines[j] ?? "");
        if (match) {
          ids.push(match[1] as string);
          return;
        }
      }
    });
  }
  return ids;
}
