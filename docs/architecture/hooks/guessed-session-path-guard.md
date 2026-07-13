# Guessed-Session-Path Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A PreToolUse hook on `Bash` and `mcp__minsky__session_exec` that scans the
tool's string inputs for absolute paths of the form
`.../state/minsky/sessions/<id>/...` whose directory does not exist on disk,
and denies the call. This is the symptom-tier structural fix (mt#2195) for the
guessed-session-path class: an agent constructs a plausible `sessionId` (and the
workspace path under it) before `session_start` has returned the real one, then
references it in dependent `cd` / file commands that all fail with raw
`cd: no such file or directory` errors after wasted turns.

**Hook file:** `.claude/hooks/check-guessed-session-path.ts` — as of mt#2650, this is the
ADR-028 Phase 1 pilot guard: it runs through the guard-dispatcher framework (see "Guard-
Dispatcher Framework (ADR-028 Phase 1)" above) rather than as its own standalone
`settings.json` registration/process. The file exports both a `run(input, ctx)` pure
function (the dispatcher-compatible entry point, registered in
`.minsky/hooks/registry.ts`'s `GUARD_REGISTRY`) and its original standalone `if
(import.meta.main)` block (kept for direct CLI invocation — unchanged). The behavioral
contract below (detection logic, denial message, override) is identical either way; only the
process that invokes it changed.

**How it works:**

1. Reads `tool_input` and collects every string value (the Bash / session_exec
   `command`, plus any other string args).
2. Matches absolute paths running through `.../state/minsky/sessions/<id>`.
   Relative or non-absolute matches are skipped — they can't be resolved
   reliably from the hook's cwd (fail-open).
3. For each distinct match, checks `existsSync` on the session-workspace
   directory. A missing directory is the signature of a guessed/constructed
   id → deny.

**On hit:** the hook denies with `permissionDecision: "deny"` and a diagnostic
naming each nonexistent session path and its `<id>`, instructing the agent to
obtain the real sessionId from the `session_start` result (or `session_dir`)
rather than assembling a path from a guessed id.

**Fail-open posture:** the entire entrypoint is wrapped in try/catch; any error
(including malformed stdin) exits 0 = allow. Only a confirmed absolute
`sessions/<id>/` path whose directory is absent produces a deny.

**Override mechanism:** Set `MINSKY_SKIP_SESSION_PATH_CHECK=1` (or `true` / `yes`)
in your environment to allow a reference to an intentionally-absent session
path (e.g., a just-cleaned-up session). The override emits an audit line to
stdout (non-JSON, so Claude Code's hook-output parser ignores it — matching the
sibling-hook audit convention) naming the env-var value, session id, and ISO
timestamp.

**Env-var registration:** `MINSKY_SKIP_SESSION_PATH_CHECK` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788). The override
env-var name's source of truth lives in the hook file as the exported constant
`OVERRIDE_ENV_VAR` so the hook, test, and this rule cannot drift.

**Originating incident:** mt#2191 implementation (2026-05-31, memory
`30f5d164` R1): the agent batched `session_start` with ~10 dependent
`Bash` / `session_edit_file` calls referencing a guessed session path
(`f8a1e6d2-…`; the real session was `c49993dd-…`). Every guessed-path call
failed or was cancelled; this guard catches the class at the first call.

**Cross-references:**

- mt#2195 — this guard's tracking task
- mt#2199 — always-injected "one pipeline step per turn" rule (root tier of
  the same failure family)
- mt#2197 — pre-narration / fabricated-outcome detector hook (sibling symptom)
- `.claude/hooks/block-git-gh-cli.ts` — PreToolUse deny-class convention this
  hook mirrors
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract
  this hook's override env-var conforms to)
