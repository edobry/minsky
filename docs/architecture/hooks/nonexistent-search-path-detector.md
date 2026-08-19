# nonexistent-search-path detector

**Task:** mt#4215 · **Event:** `PreToolUse` on `Bash|mcp__minsky__session_exec` ·
**Posture:** calibration-first (log-only, never denies) ·
**Override:** `MINSKY_SKIP_NONEXISTENT_SEARCH_PATH=1` ·
**Module:** `.minsky/hooks/nonexistent-search-path-detector.ts`

## What it does

Before a `grep` / `rg` / `find` runs, it stats the command's PATH ARGUMENTS. If any does not exist,
it records a calibration entry and injects a warning naming the missing path, the deepest ancestor
that does exist, and the segment that failed to resolve.

The point is not to report the typo — the search binary's own stderr does that. The point is to
block the INFERENCE that an empty result is evidence of absence.

## Why the empty result is dangerous

A search over a nonexistent path prints nothing. So does a search that legitimately found nothing.
`2>/dev/null` removes the sentence that distinguishes them, and what is left looks exactly like an
answer.

The originating incident (2026-08-17): an agent investigating whether the tray supervisor bounds the
MCP daemon's memory ran

```
grep -rniE 'memory|ceiling|footprint|rss' --include='*.ts' src/cockpit/tray src/tray cockpit-tray/src 2>/dev/null
```

and reported _"the tray supervisor has **zero** memory/ceiling references."_ The tray is Rust at
`cockpit-tray/src-tauri/src` and carries an entire cross-pid memory-supervision layer
(`supervisor.rs:1012` `daemon_memory_bytes(pid)`, `daemon_core.rs:864` `parse_footprint_bytes`). The
false claim was load-bearing: it fed the conclusion that adopting the shared-daemon topology would
leave the daemon unsupervised, which is the inverse of true, in a turn where the principal was
deciding whether to adopt it.

## Why a PreToolUse stat and not the exit code

The exit code already distinguishes the two cases. Measured 2026-08-17 in this repo:

| Binary                                                    | missing path | genuine no-match |
| --------------------------------------------------------- | ------------ | ---------------- |
| `grep` (ugrep 7.5.0, which Claude Code aliases `grep` to) | **2**        | 1                |
| `command grep` (system BSD grep)                          | **2**        | 1                |
| `rg`                                                      | **2**        | 1                |
| `find`                                                    | **1**        | 0                |

A `PostToolUse` observer reading that would need no argument parsing at all — hence no
false-positive surface — and would cover every case this guard is deliberately silent on. It was
the first design considered and it cannot be built: Claude Code's hooks reference states that
`Bash` returns an object with `stdout`, `stderr`, `interrupted`, and `isImage`. There is no
exit-code field, so a hook sees only the two streams.

**That inverts the usual reading of the incident.** `2>/dev/null` does not hide one of two
redundant signals. stderr is the ONLY channel by which "no such file or directory" reaches anything
downstream, and suppressing it is total. The pre-run stat is what is left.

## What it does NOT catch

"Search" conflates three sub-operations: locating a target, filtering within it, and matching
content. This guard checks the first only.

The originating command had causes in the first two. Two of its three paths did not exist — and the
third, `cockpit-tray/src`, **does** exist; it is the Tauri frontend tree, and it holds zero `.ts`
files, so `--include='*.ts'` legitimately excluded everything in it. So the guard fires on that
command without fully explaining it. Do not read a fire as containment.

The filter-mismatch slice needs a directory scan rather than a stat, and has a genuine
false-positive surface. It is out of scope and unfiled by design; the trigger for filing it is this
guard proving out in calibration.

## The silence rules, and why they are the design

A path argument is checked only when it is statically resolvable. Everything else is silence — never
a guess, because a guard in the assertion-without-verification family that invented a plausible path
would be committing the error it exists to prevent.

| Case                                         | Resolution base   | Verdict                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Absolute path (either surface)               | none needed       | **Checked.** Means the same thing from any cwd.                                                                                                                                                                                                                                                                       |
| Relative path, `Bash`                        | `input.cwd`       | **Checked.** The hook payload's `cwd` is the shell's working directory — the base the command itself will resolve against.                                                                                                                                                                                            |
| Relative path, `Bash`, command contains `cd` | unknown           | **Silent.** A `cd X && grep … src/foo` re-bases every later relative path.                                                                                                                                                                                                                                            |
| Relative path, `mcp__minsky__session_exec`   | session workspace | **Silent.** `session.exec` resolves its workdir via an async `service.getDir({sessionId, task})` call this guard deliberately does not make.                                                                                                                                                                          |
| Glob (`*`, `?`, `[`, `{`)                    | —                 | **Silent.** A glob may legitimately match nothing.                                                                                                                                                                                                                                                                    |
| Variable / command substitution              | —                 | **Silent.** A stage containing `$(` or a backtick is skipped whole: whitespace tokenization splits it into fragments, and `$(git rev-parse --show-toplevel)/nope` yields a bare `rev-parse` token that looks exactly like a relative path. That false positive was found by this guard's own tests before it shipped. |

Every skipped argument increments `unresolvedCount`, which is written on CLEAN records too. It is
the only measurement of what these rules cost, and it is what a calibration review should read when
asking about recall rather than precision.

## Argument-grammar notes

- `grep`/`rg` take `PATTERN [PATH...]`, so the first positional is the pattern — unless `-e`/`-f`
  supplied one, in which case every positional is a path.
- `find` takes `[PATH...] [EXPRESSION]` and is walked separately. Its expression is not getopt: many
  primaries take a filename operand that is not a search target (`-newer foo.txt`, `-samefile x`,
  `-fprint out`). The walk stops dead at the first expression token (`-`, `(`, `)`, `!`, `,`) rather
  than trying to know which primaries consume an operand.
- `VALUE_TAKING_LONG_OPTS` is deliberately generous across GNU grep, BSD grep, ugrep and ripgrep. An
  entry no binary actually takes costs nothing — it can only cause a token to be SKIPPED, which is
  the safe direction. An entry MISSING from it is the one way this guard could turn a flag's value
  into an apparent path, which is why `--include`/`--exclude-dir` and their siblings are pinned by
  tests.

## Why calibration-first, and why not ADR-024

ADR-024's ladder scopes itself to `UserPromptSubmit` guidance hooks matching behavioral trigger
phrases in the agent's own prose. A command string has no paraphrase axis, so neither rung applies —
the same reasoning `registry-command-string-guards.ts`'s own header records for this whole family.

Shipping log-only follows the repo-wide observer convention instead, and for a specific reason: the
zero-false-positive bar this guard is held to is a claim about an argument-grammar parser, and a
parser's precision is not provable by construction. The calibration log exists to size it before any
enforcement posture is considered. (Its deny-capable siblings on this matcher — `block-secret-file-read`,
`block-concurrent-bulk-mutation`, `block-bulk-process-kill` — ship denying because they block
destructive or secret-leaking acts, which this does not.)

## Cross-references

mem#500 (the rule this mechanizes; its R-entry carries a correction from this task's planning pass) ·
mem#490 (bounded-search negatives) · mt#2544 (family anchor,
`family:assertion-without-verification`) · mt#3918 (the negative-existence-claim detector, whose
trigger requires a durable artifact and a cited DONE task — this incident was chat-only, which is
the coverage gap this guard sits earlier than) · `claim-confidence.mdc §Absence in a derived view` ·
`terminal-command-best-practices.mdc` · `hook-observers.mdc` (index entry).
