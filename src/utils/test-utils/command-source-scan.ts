/**
 * Read facts off the shared-command sources for tests (mt#3924, mt#3966).
 *
 * Three test surfaces ask the sources the same two questions — which command ids
 * are declared, and which registrations carry `mutating: true`:
 * `tool-effect-coverage.test.ts` (both), `drift-gate.test.ts` (the flag).
 * They were three separate regexes in two files, and the duplication cost
 * exactly what duplication costs: the id pattern was fixed in one copy (mt#3924)
 * and left broken in the other, where it stayed blind to 23 class-based commands.
 * One module, one pattern, so a fix cannot land in half the callers.
 *
 * Why a source scan rather than reading the registry: registering the commands
 * requires a DI container and per-module registration functions with different
 * signatures (`registerGitCommands(container)`, `registerPersistenceCommands(...)`,
 * class constructors taking provider thunks). Both facts are static properties of
 * the registration site, so the sources answer directly without standing up half
 * the application.
 *
 * **What a source scan cannot tell you: whether anything REGISTERS what it finds.**
 * `tasks.status` is declared as a command class and never registered anywhere — see
 * `DECLARED_BUT_UNREGISTERED` in `tool-effect-coverage.test.ts`, which is where that
 * judgment belongs. This module reports what the sources DECLARE; deciding which
 * declarations are real tools is the caller's job.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/** Where command registrations live, relative to the repo root. */
export const COMMANDS_DIR = "src/adapters/shared/commands";

/**
 * Field modifiers a class-based command may carry before the field name. Written
 * once and shared by both patterns below, because the failure mode these scans keep
 * hitting is a modifier the regex did not anticipate: the id pattern originally
 * allowed none and matched no class at all, and an earlier draft allowed only
 * `readonly`, so a command declaring `public mutating = true` would have been
 * dropped silently — the same under-report, one modifier later (PR #2848 R1).
 */
const FIELD_MODIFIERS = /(?:(?:readonly|public|protected|private|declare|static)\s+)*/.source;

/**
 * Matches both declaration shapes in use:
 * - object-literal registration — `mutating: true,`
 * - command class field — `readonly mutating = true;`
 */
const MUTATING_FLAG_LINE = new RegExp(`^\\s*${FIELD_MODIFIERS}mutating\\s*[:=]\\s*true[,;]?\\s*$`);

/**
 * Matches `id: "x.y"` and `readonly id = "x.y"`.
 *
 * The `\s*` before the separator is load-bearing and was missing in the original
 * (mt#3847) version: a class writes `readonly id = "tasks.delete"` with spaces
 * around the `=`, so `id[:=]` matched no class-based command at all. Nothing broke
 * while class-based commands happened not to matter to either caller — which is
 * precisely why it survived: a scan that under-reports produces no error, just a
 * smaller answer that agrees with a stale expectation.
 */
const COMMAND_ID_LINE = new RegExp(
  `^\\s*${FIELD_MODIFIERS}id\\s*[:=]\\s*["'\`]([a-z0-9._-]+)["'\`]`,
  "i"
);

/** How far back to look for the id a `mutating` flag belongs to. */
const ID_LOOKBACK_LINES = 200;

/** Every non-test `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
    files.push(path);
  }
  return files;
}

function linesOf(path: string): string[] {
  return String(readFileSync(path, "utf8")).split("\n");
}

/**
 * Every command id DECLARED in the sources, deduplicated and sorted.
 *
 * Includes declarations nothing registers — see the module docblock.
 */
export function scanCommandIds(dir: string = COMMANDS_DIR): string[] {
  const ids: string[] = [];
  for (const path of sourceFiles(dir)) {
    for (const line of linesOf(path)) {
      const match = COMMAND_ID_LINE.exec(line);
      if (match) ids.push(match[1] as string);
    }
  }
  return [...new Set(ids)].sort();
}

/**
 * Every command id whose registration carries `mutating: true`, deduplicated and
 * sorted. The flag is matched on its own line and attributed to the nearest id
 * declared above it.
 */
export function scanMutatingFlaggedIds(dir: string = COMMANDS_DIR): string[] {
  const ids: string[] = [];
  for (const path of sourceFiles(dir)) {
    const lines = linesOf(path);
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
  return [...new Set(ids)].sort();
}
