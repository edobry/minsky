/**
 * Claude Hooks Compile Target
 *
 * Reads hook sources from `.minsky/hooks/*.ts` (excluding `*.test.ts`) and
 * emits `.claude/hooks/<name>.ts` with a shebang, a generation banner, a
 * provenance comment, and mode 0o755.
 *
 * The machinery lives in `./hook-copy-target` (mt#3854), shared with the
 * `codex-hooks` target — the two differ only in output directory, and keeping
 * one implementation is what stops them drifting. This module is the Claude
 * construction of it plus the re-exports its existing tests and callers use;
 * behaviour is unchanged from the mt#2304 original.
 *
 * Part of the ADR-016 unified compile pipeline (mt#2280). Closes the asymmetry
 * where hooks were the only Claude Code authoring surface without a
 * Minsky-native source at `.minsky/`.
 *
 * @see mt#2304 — implementation task
 * @see mt#3854 — the extraction, and the codex sibling
 * @see mt#2280 / ADR-016 — compile pipeline convergence (parent)
 * @see .claude/hooks/check-generated-file-edit.ts — banner recognition
 */

import { makeHookCopyTarget } from "./hook-copy-target";
import type { MinskyCompileTarget } from "../types";

// Re-exported so this module's public surface is exactly what it was before the
// mt#3854 extraction — `claude-hooks.test.ts` imports these by name.
export {
  HOOK_SHEBANG,
  HOOK_COMPILE_BANNER,
  HOOK_FILE_MODE,
  buildHookContent,
} from "./hook-copy-target";

/** Build the claude-hooks target. Factory pattern for test injection. */
function makeClaudeHooksTarget(): MinskyCompileTarget {
  return makeHookCopyTarget({
    id: "claude-hooks",
    displayName: "Claude Hooks",
    outputDirSegments: [".claude", "hooks"],
  });
}

export const claudeHooksTarget = makeClaudeHooksTarget();

/** Export factory for test injection */
export { makeClaudeHooksTarget };
