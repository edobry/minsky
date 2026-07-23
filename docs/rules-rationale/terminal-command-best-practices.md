# Terminal Command Best Practices — extended rationale

> Extracted from `.minsky/rules/terminal-command-best-practices.mdc` (mt#3085 corpus trim,
> Phase 2 of the 2026-07-22 context-audit roadmap, mem#682; Phase 1 = mt#3083 / PR #2205). The
> compiled rule carries the one-liner trigger phrases plus the full secret-handling core
> verbatim; this file holds the worked examples, the quote/parsing diagnostics, and the incident
> narrative. Nothing here changes agent behavior — the directive text in the rule is the
> complete behavioral contract.

## Quote character requirements (full detail)

When using the `run_terminal_cmd` / `session_exec` tool, follow these practices to avoid shell
parsing issues:

- **Use ASCII quotes only**: Always use straight ASCII quotes (`"` and `'`) in commands, never
  smart quotes (`"` `"` `'` `'`)
- **Prefer single quotes over double quotes** when possible to avoid shell interpretation issues
- **Use unquoted text for simple echo statements** when special characters aren't needed

## Command structure guidelines (full detail)

- **Keep commands simple**: Avoid overly complex command chains with many `&&` operators
- **Break complex operations into multiple simple commands** rather than chaining 10+ commands
  together
- **Test command syntax**: If experiencing `dquote>` or parsing issues, simplify the command
  structure

## Problem identification

**Signs of Quote/Parsing Issues:**

- Commands hang with `dquote>` prompt
- Shell showing `cmdand cmdand cmdand` patterns
- Need to type `"` and press enter to continue

**Root Causes:**

- Unicode character contamination in command strings
- Smart quotes instead of ASCII quotes
- Overly complex command chains

### Examples

**❌ Problematic:**

```bash
echo "Complex && command && chains && with && many && operations"
```

**✅ Preferred:**

```bash
echo 'Simple command'
# or
echo Simple unquoted text
```

**✅ For Complex Operations:**

```bash
echo 'Step 1 complete'
echo 'Step 2 complete'
echo 'Step 3 complete'
```

## Verification commands — the anti-patterns in full

When running a verification command — lint, `format:check`, typecheck, test, build — whose
pass/fail result you intend to **read and act on**, optimize the command for
**interpretability on failure**, not terseness. Two anti-patterns destroy that interpretability:

1. **Output suppression.** `cmd >/dev/null 2>&1 && echo PASS || echo FAIL` discards the
   diagnostic you need the moment the check fails — so a failure forces an immediate re-run
   without `>/dev/null` just to see why. Suppressing the output of a command whose result you
   must interpret is self-defeating.
2. **Chaining multiple checks in one call.** `lint && format; typecheck` (or with `||`)
   collapses several results into one ambiguous exit code — the tool returns "exitCode 1, empty
   stdout" and you can't tell _which_ check failed without re-running each separately.

**Prefer the structured MCP tools where they exist.** `mcp__minsky__validate_lint` and
`mcp__minsky__validate_typecheck` return structured `{ errorCount, warningCount, errors[] }` and
are session-aware (pass `task` / `sessionId`, per mt#2336) — no shell, no suppression, no
ambiguity. For `format:check` / `lint:strict` / `test` (no MCP equivalent, or you need the exact
CI gate) run the bare command and READ the output rather than reducing it to a PASS/FAIL echo.

**❌ Problematic (output suppressed + chained — uninterpretable on failure):**

```bash
bun run lint:strict >/dev/null 2>&1 && echo PASS || echo FAIL; bun run format:check >/dev/null 2>&1 && echo PASS || echo FAIL
```

**✅ Preferred (separate calls, visible output):**

```bash
bun run lint:strict 2>&1 | tail -n 20
```

```bash
bun run format:check 2>&1 | tail -n 20
```

## Bulk / loop commands — worked examples

When running a command **in a loop over many items** (bulk close, bulk kill, bulk rename,
per-file checks) whose per-item pass/fail you must read, the verification-command
interpretability discipline applies — plus two shell-mechanics traps specific to iteration:

1. **Never `>/dev/null` a per-item command in a loop whose result you must read.**
   Per-iteration suppression turns "3 of 40 failed" into a silent "done" and forces a full
   re-run to discover which item failed. Append each outcome to a log and read it, or echo a
   running tally:

   **❌ Problematic (per-item result suppressed):**

   ```bash
   for id in $ids; do gh issue close "$id" >/dev/null 2>&1; done
   ```

   **✅ Preferred (tally + log, results readable):**

   ```bash
   ok=0; fail=0; : >/tmp/close.err   # pre-create the log so the final cat never errors on a clean run
   for id in ${(f)ids}; do
     if gh issue close "$id" 2>>/tmp/close.err; then ok=$((ok+1)); else fail=$((fail+1)); echo "FAIL $id" >>/tmp/close.err; fi
   done
   echo "closed=$ok failed=$fail"; cat /tmp/close.err
   ```

2. **In zsh, `for x in $VAR` does NOT word-split a multiline string.** Unlike bash, zsh does not
   split unquoted parameter expansions on whitespace/newlines, so `for x in $VAR` over a
   multiline blob runs the body **once** with the whole blob as a single `x` — e.g.
   `kill $pids` over a newline-separated list becomes `illegal pid: 2534\n3637\n…`. Iterate by
   line explicitly: `for x in ${(f)VAR}` (split on newlines) or
   `printf '%s\n' "$VAR" | while IFS= read -r x; do … done`.

3. **A loop that fails where the standalone succeeds is a loop-construct bug, not a
   sandbox/permission problem.** If `gh issue close 123` works alone but the loop "does
   nothing" or reports one bizarre error, suspect word-splitting / the iteration construct
   (point 2) before blaming permissions, auth, or the sandbox.

## Secret handling — additional detail beyond the rule's core

The rule keeps the footgun warning and the presence/length safe form verbatim. Additional forms
retained here for completeness:

```bash
# length — ${#K} is a length (an integer), never the value
echo "len=${#K}"

# both together, safely
[ -n "$K" ] && echo "present (len=${#K})" || echo "absent"
```

### Rule: never interpolate a secret variable in an output position

- NEVER: `echo "$SECRET"`, `echo "${SECRET}"`, `echo "${SECRET:-default}"`,
  `printf ... "$SECRET"`, `cat <<< "$SECRET"`, or any construct where the secret's VALUE (not
  its presence or length) can appear in stdout/stderr.
- A prefix preview (`${K:0:4}`) is still a partial value leak — avoid it in shared/persisted
  transcripts unless the task specifically requires identifying a credential and the operator
  has accepted that tradeoff; presence + length is sufficient for the common "did this get set
  correctly" check.
- This applies equally to `session_exec` — its output is captured into the same persisted
  transcript as Bash.

Defense-in-depth for this failure class (a tool-output credential scrubber that redacts
credential-shaped strings from tool output before it reaches the durable transcript store) is
tracked separately — see `packages/domain/src/transcripts/credential-scrubber.ts`. The rule is
the compose-time discipline; the scrubber is the safety net for when discipline slips.

## Originating incident

2026-07-13, mt#2738 — a Pulumi Cloud migration session ran a presence-check meant to print
"present" but instead printed the entire Pulumi access token:

```bash
# LOOKS like a safe presence check. It is NOT.
echo "pulumi token present: ${K:+yes (len ${#K}, prefix ${K:0:4})}${K:-NO}"
#                                                                  ^^^^^^^^ prints the FULL
#                                                                  token when $K is set
```

The `${K:+...}` half was safe; the trailing `${K:-NO}` silently expanded to the live token
because `:-` only substitutes when the variable is _unset_, and here it was set. Tracking task
for the rule-level fix: mt#2763.

## Rationale

Prevents shell parsing issues that cause commands to hang with `dquote>` prompts due to Unicode
character contamination or overly complex command structures. Ensures reliable terminal command
execution across all sessions. The secret-handling subsection prevents a distinct failure class
— a shell interpolation footgun that leaks credential VALUES into the persisted, ingested
transcript (mt#2763; originating incident 2026-07-13, mt#2738).
