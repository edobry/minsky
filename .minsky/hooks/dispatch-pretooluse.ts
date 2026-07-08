#!/usr/bin/env bun
// PreToolUse dispatcher entrypoint — ADR-028 D1.
//
// The SOLE `.claude/settings.json` PreToolUse entry for every guard
// migrated onto the dispatcher framework (currently: `check-guessed-session-
// path`, registered in `./registry.ts`). Reads stdin once, resolves shared
// context once (D6), and runs every matched guard's pure function in
// process via `runDispatcher` — see `./dispatcher.ts` for the core loop.
//
// Guards NOT yet migrated (the remaining 12 PreToolUse matcher blocks) keep
// their own independent settings.json registrations and process spawns;
// this entrypoint only owns the guards present in `GUARD_REGISTRY` with
// `event: "PreToolUse"`. Family migrations (ADR-028 Phase 5) add
// registrations here without touching this file.
//
// @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md — D1
// @see mt#2650 — this framework's tracking task (ADR-028 Phase 1)
// @see .minsky/hooks/dispatcher.ts — the core dispatcher loop
// @see .minsky/hooks/registry.ts — the declarative guard registry

import { runDispatcher } from "./dispatcher";

if (import.meta.main) {
  try {
    await runDispatcher("PreToolUse", { hookFilename: "dispatch-pretooluse.ts" });
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[dispatch-pretooluse] fail-open: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
}
