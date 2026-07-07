# Skill/Agent/Rule Staleness Detector

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `UserPromptSubmit` hook that, on each agent turn, compares mtimes of files under
`.claude/skills/**`, `.claude/agents/**`, and `.minsky/rules/**` against a session-start
baseline, and injects an `additionalContext` warning when files have changed since the
session started. This is the structural fix (mt#1622) for the skill-copy-staleness pattern
recorded in `feedback_skill_copy_staleness_in_running_sessions`: skill bodies load into
session context on first invocation and stay cached for the rest of the session, so
structural fixes that update a skill on main don't propagate to running sessions.

**Hook file:** `.claude/hooks/skill-staleness-detector.ts`

**Why `UserPromptSubmit`, not `FileChanged`.** Claude Code's `FileChanged` event is in
the "no decision control" event class — it fires on file changes but cannot emit
`additionalContext` into the next agent turn. `UserPromptSubmit` IS a context-injecting
event (used by `memory-search.ts`), so the hook performs its own per-turn mtime check.
Trade-off: detection is per-turn rather than instantaneous; in practice equivalent since
the agent only acts on context between turns.

**How it works:**

1. On first invocation for a given `session_id`, snapshots mtimes of every watched file
   and writes them to `~/.claude/skill-staleness/<encoded-cwd>/<session_id>.json` (one
   file per session sidesteps the read-modify-write race a shared file would have).
2. On subsequent invocations, reads the baseline and compares against the current
   snapshot. Files whose mtime differs from baseline AND from the most-recently-reported
   mtime are flagged.
3. Builds a single consolidated `additionalContext` message naming the changed files
   (capped at 10 with "+ N more"), updates the per-file `lastReported` map, and exits.

**Re-warning suppression.** After warning about file X with mtime M, the hook records
`lastReported[X] = M`. Subsequent turns only re-warn if X's mtime advances again past M.
This avoids nag-on-every-turn after a single change.

**Override mechanism:** Set `MINSKY_SKIP_SKILL_STALENESS=1` (or `true` / `yes`) in the
environment to disable the hook entirely:

```bash
MINSKY_SKIP_SKILL_STALENESS=1 claude
```

The hook short-circuits before any filesystem work when opted out.

**Behavioral contract:**

- **First invocation per session** writes a baseline and emits NO warning.
- **No-change turns** emit NO warning (silent allow path).
- **Modified-since-baseline turns** emit a single consolidated warning naming the files,
  with `(modified)` or `(deleted)` annotations.
- **Already-reported files** (mtime equals `lastReported`) are SKIPPED — no re-warn.
- **Newly-added files** (not in baseline) are NOT warned about — they're additive
  context, not staleness of a skill the agent has already loaded.
- **Errors** at any stage (read, write, parse) result in silent skip — the hook is
  informational only and never blocks the user prompt.

**Originating incident.** mt#1546 (2026-05-06): mt#1551 shipped on 2026-05-05 retiring
the auditor dispatch from `/verify-task`; the next day mt#1546 hit `/verify-task` in a
running session and got the OLD protocol because the SKILL.md text was loaded at session
start, before the mt#1551 fix landed. This hook closes that gap for future cases.
