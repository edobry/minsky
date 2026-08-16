# truncated-outcome-read-detector

**Event:** `PreToolUse` (guard-dispatcher, `GUARD_REGISTRY`), matcher `Bash|mcp__minsky__session_exec`
**Task:** mt#4096
**Mode:** calibration-first — log-only, `denyCapable: false`
**Log:** `.minsky/truncated-outcome-read-calibration.jsonl`
**Override:** `MINSKY_SKIP_TRUNCATED_OUTCOME_READ=1` (plus the shared `MINSKY_HOOK_OVERRIDE` channel)
**Fail posture:** open — a pure string parse; any throw leaves the command untouched

## What it detects

A command that pipes an **outcome-bearing** command into a **positional truncator**:

| Half            | Members                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| outcome-bearing | `minsky session commit`, `session update`, `session pr create`, `session pr merge`, `minsky git push`, `git push` |
| truncator       | `tail`, `head`                                                                                                    |

Both halves are required. Either alone is ordinary.

## Why truncation and not suppression

`terminal-command-best-practices.mdc` already bans `>/dev/null` on a result you must read. The
originating incident suppressed nothing — it ran `minsky session commit … 2>&1 | tail -6` and
reported the push as done off the tail. The push had not landed.

**Suppression is conspicuous; truncation is not.** `>/dev/null` leaves an empty screen. A plausible
six-line tail looks exactly like output that was read, and the field you needed is simply not among
the lines — there is no error to notice, only a gap. This is
`claim-confidence.mdc §Absence in a derived view` applied to your own terminal: the tail is a
derived view, accurate about itself and silent about the question being asked of it.

## The trigger worth internalizing: a mode switch that never switched back

In the originating incident the PREVIOUS commit in the same session used `--json`, and its
`"pushed": true` WAS read. That commit was rejected by the pre-commit lint gate, so the author
switched to non-JSON plus `tail` to see the failure — the right move for diagnosis. After fixing
the warning, the re-run stayed in the diagnostic mode.

One command serves two sub-operations that want opposite filters:

- **Diagnosing** a failure — you want the error text, so you truncate toward it.
- **Confirming** an outcome — you want specific fields, so truncation is fatal.

Nothing in the shell marks where you cross back. That is why this ships as a detector rather than
another line of prose asking for recall at exactly the moment attention is on the outcome.

## Deliberately narrow

Does NOT fire on:

- `| grep <field>` or `| jq …` — a **targeted** read is the remedy this detector recommends. Firing
  here would tell the author to stop doing the correct thing. `grep` was in mt#4096's original spec
  and was dropped at implementation for this reason.
- a read-only command truncated the same way (`git log | head -20`) — ordinary; firing would
  produce the unmatchable noise mem#719 records as eroding trust in a detector's true positives.
- an outcome-bearing command with no pipeline.
- a heredoc body that merely CONTAINS the shape. No special handling is needed: the check reads the
  leading command of the pipeline's FIRST stage, which for `cat > f <<'EOF' … EOF` is `cat`. This
  is the mt#4088 hazard (heredoc bodies are matchable text) avoided structurally.

## Not governed by ADR-024

ADR-024's ladder scopes itself to `UserPromptSubmit` guidance hooks matching behavioral trigger
phrases in the agent's own prose; neither of its axes applies to a command string. mt#4096's
planning audit initially concluded the opposite — that Rung 1's markdown-elision prescription
answered the heredoc hazard — and that was **wrong**: `elideMarkdownNonProse` elides markdown code
spans, and a shell heredoc is not markdown. The correction was found by reading the sibling
`chained-verification-commands-detector`, which had already recorded the same conclusion for the
same matcher class. Recorded here because a future reader reaching for ADR-024 will make the same
mistake.

## Why calibration-first rather than deny

Three recent command-string guards (`block-bulk-process-kill`, `block-concurrent-bulk-mutation`,
`block-secret-file-read`) ship DENYING, on the argument that a structured command string has no
paraphrase axis so ADR-024's ladder does not govern. That argument does not transfer, and the
difference matters because copying the wrong precedent here would block legitimate work: those
guards match commands that are **categorically wrong to run**. This one matches a command that is
**usually fine** — truncating output is ordinary — and wrong only when the truncated fields were
the ones about to be relied on. That is a precision axis, it needs measuring, and calibration-first
is the right default rather than a scheduling compromise.

Flipping to enforcing is an operator decision (mt#3769), routed via `/calibration-review`.

## Record shape

```json
{
  "ts": "…",
  "sessionId": "…",
  "toolName": "Bash",
  "mutatingCommand": "minsky session commit --task 'mt#1' 'msg' 2>&1",
  "filter": "tail",
  "phrase": "minsky session commit --task 'mt#1' 'msg' 2>&1 | tail",
  "outcome": "matched"
}
```

`phrase` carries the violation SHAPE rather than the raw command, because a raw command is
near-unique and would satisfy the sweep's distinct-phrase gate by construction, rendering it inert
(the mt#3781 defect).

## Cross-references

`terminal-command-best-practices.mdc` (the rule this enforces) · `CLAUDE.md §Sequence Dependent
Tool Calls` (the field-reading requirement) · `chained-verification-commands-detector.md` (sibling,
same matcher class) · mt#3177 / mt#3205 (which made the fields exist and be returned; neither makes
them get read) · mem#1012 (the bridge memory) · mt#4088 (the heredoc-matching hazard).

## The enumeration arm (mt#4176)

### What changed

The detector originally fired only when a **state-mutating** command's output was positionally
truncated, and its docblock excluded read-only commands on purpose:

> a read-only command truncated the same way (`git log | head -20`) — truncating a read is
> ordinary and firing on it would produce the unmatchable noise mem#719 records as eroding trust
> in a detector's true positives

That exclusion is correct for a **sample** and wrong for an **enumeration**. The distinction is
not read-vs-mutate:

| Shape       | Example            | Are the dropped lines part of the question? |
| ----------- | ------------------ | ------------------------------------------- | ------------------------------------------------------------------ |
| Sample      | `git log           | head -20`                                   | No — you want the recent few. Nothing is concluded about the rest. |
| Enumeration | `minsky mcp --help | head -15`                                   | **Yes** — the listing exists to answer "what is the complete set?" |

Truncating an enumeration manufactures an absence, and the absence is what the next claim rests
on. So the arm keys on the first stage carrying `--help`, independent of the mutating-command
patterns.

### Originating incident (2026-08-16)

An agent enumerating the `mcp` subcommand set ran `bun src/cli.ts mcp --help | head -15` and
`minsky mcp --help | head -12`. Because Commander wraps long descriptions, a dozen lines hold far
fewer than a dozen commands, and `proxy` and `shim` were both below the cut. The agent concluded
neither was registered and began drafting that into a task spec as evidence that mt#3816's config
migration rewrites user entries to a command that does not exist — a serious claim about a
feature's safety, resting entirely on lines a `head` had removed. The untruncated run
(`sed -n '/Commands:/,$p' | grep -E '^\s+[a-z]' | awk '{print $1}' | sort -u`) falsified it in one
call.

Recorded in mem#1032 (`family:assertion-without-verification`) alongside two sibling probe
failures from the same session.

### Why bare `-h` is excluded

`-h` is widely a _value_ flag rather than a help flag — `ls -h`, `du -h`, `sort -h` all mean
human-readable. Including it would fire on `ls -lh | head -20`, which is a textbook sample and
exactly the false positive the preserved carve-out exists to prevent. `--help` has no such
collision. Two regression tests pin this.

### Precedence

A command matching both arms reports `outcome`. Not a real invocation (`session commit --help`
does not commit), but asserted rather than left to branch order: the discarded confirmation
fields are the costlier warning of the two.

### Attention cost

The `outcome` branch renders longer than the `enumeration` branch — 508 vs 352 chars with the
same command interpolated, measured 2026-08-16 — so `renderWorstCase()` stays posed on `outcome`
and the guard's declared ceiling is unmoved. The command string remains the one unbounded axis,
which is why `guard-feedback-shape.test.ts` classifies this probe a saturated SAMPLE rather than
a proved ceiling; that predates the second arm.
