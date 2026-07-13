# NUL-Byte Pre-Commit Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A step in the pre-commit pipeline (`src/hooks/pre-commit.ts`, between the
Node-shim check and the TypeScript type check) scans staged text files for
literal NUL bytes (0x00) and blocks the commit if any are present. Unlike
the other guards in this file — which are Claude Code PreToolUse hooks
under `.claude/hooks/` — this is a true git pre-commit step that runs from
the `PreCommitHook` TypeScript class invoked by `.husky/pre-commit`. The
override-with-audit convention is the same across both kinds.

**Hook file (in-pipeline step):** `src/hooks/pre-commit.ts` →
`runNulByteCheck()`. Pure-function implementation:
`src/hooks/nul-byte-detector.ts`.

**Why this check exists.** mt#1821 / PR #1107 R1 (2026-05-13): the agent
called `session_write_file` with a `content` parameter containing the
six-character JS escape `\u0000`. JSON parsing at the tool boundary
collapsed the escape into the literal character U+0000 BEFORE writing,
landing a single NUL byte mid-template-literal in a TypeScript source
file. The file passed tsc (NULs are valid inside template literals),
eslint, prettier, `bun test`, the CI build, and the CI bundle-boot-smoke.
Only `git`'s binary-file detection and the reviewer-bot's diff renderer
flagged it — at review time, not commit time. This guard catches the
same class at the latest authoring stage where the fix is cheapest.

**Allowlist (skipped from the check):**

- Known-binary file extensions where NULs are expected by format design:
  `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.bmp`, `.tiff`,
  `.pdf`, `.zip`, `.tar`, `.gz`, `.tgz`, `.bz2`, `.xz`, `.7z`, `.woff`,
  `.woff2`, `.ttf`, `.otf`, `.eot`, `.mp4`, `.mov`, `.webm`, `.wav`,
  `.mp3`, `.ogg`, `.m4a`, `.so`, `.dylib`, `.dll`, `.bin`, `.exe`,
  `.class`, `.jar`.
- Path prefix `tests/fixtures/` — regression fixtures (including this
  guard's own `tests/fixtures/nul-byte-source.ts`) may legitimately
  contain NUL bytes. Without this exclusion the fixture would block its
  own staging.

**On hit:** the step blocks with a structured message listing every
violating path and the byte offset of the first NUL byte in that file,
plus a "Why this is blocked" section pointing at mt#1824, mt#1821 /
PR #1107 R1, and the originating memory
`feedback_json_tool_writes_interpret_unicode_escapes` (id `b7e2f8ef`).

**Override mechanism:** Set `MINSKY_SKIP_NUL_CHECK=1` (or `true` / `yes`)
in your environment before invoking the commit tool:

```bash
MINSKY_SKIP_NUL_CHECK=1 minsky session commit ...
```

The override emits an audit-log line to stdout naming the env-var value
and the ISO timestamp. Use only when the NUL byte is genuinely intended
(very rare; the most likely justification is a binary-format file that
isn't covered by the extension allowlist — in which case the better fix
is to extend `KNOWN_BINARY_EXTENSIONS` in `src/hooks/nul-byte-detector.ts`).

**Env-var registration:** `MINSKY_SKIP_NUL_CHECK` is registered in
`HOOK_ONLY_ENV_VARS` at `packages/domain/src/configuration/sources/environment.ts`
so the env-var-to-config dot-path parser skips it at boot (per the
`custom/no-unregistered-minsky-env-var` ESLint rule from mt#1788). The
override env-var name's source of truth lives in
`src/hooks/nul-byte-detector.ts` as the exported constant
`NUL_BYTE_CHECK_OVERRIDE_ENV` so the hook, the test, and the rule
documentation cannot drift.

**Performance:** the check completes in well under 200ms for ≤20 staged
text files on an M1 Max workstation. Each staged blob is fetched via
`git show :<path>` (one subprocess per non-allowlisted file) and scanned
with `Buffer.indexOf(0)` — a single memchr-class O(n) pass.

**Cross-references:**

- mt#1824 — this guard's tracking task
- mt#1821 / PR #1107 R1 — originating incident
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration)
- `feedback_json_tool_writes_interpret_unicode_escapes` (id `b7e2f8ef`) —
  user-level memory describing the JSON-tool-write gotcha that this
  guard mechanically enforces.
- CLAUDE.md `§Ensure ASCII Code Symbols` — adjacent discipline (no
  non-ASCII identifiers); same family of "what the tool layer does to
  your content."
