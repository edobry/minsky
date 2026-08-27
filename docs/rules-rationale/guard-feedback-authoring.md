# Guard feedback authoring — rationale and audit record

Companion to `.minsky/rules/guard-feedback-authoring.mdc`. This page carries the evidence behind
§"A redirect is only as available as the tool it names", including the full audit that produced it
(mt#4257).

## Why the section exists

Three instances of one class landed on 2026-08-17 and were recorded in mem#1078: a guard's denial
text names a mechanism, and nothing re-checks that the mechanism still fits the surface the guard
fires on. Two of the three held up. **The third did not survive reproduction**, and the audit run to
sweep the class found a better-evidenced member instead.

## The audit (2026-08-27)

### Extraction method

The task's first criterion said "every guard whose denial/instruction text names a tool" without
saying how to find that set, and naive greps ranged **13 to 138** depending on how you looked —
instruction text is routinely a multi-line template literal, so single-line greps undercount and
file-level greps sweep in comments and imports.

The method used: **a guard is in scope when it can return `permissionDecision: "deny"` AND names a
tool or command.** `deny` is the discriminator because that is text an agent _obeys_ at a decision
point, rather than consults. Non-denying advisory text carries ordinary doc-staleness risk instead.

```
cd .minsky/hooks
DENY=$(grep -l 'permissionDecision.*"deny"' *.ts | grep -v '\.test\.ts$' | grep -v '^types.ts$')
echo "$DENY" | xargs grep -ln 'mcp__\|session_exec\|`gh \|`git '
```

### Population

|                                                 | count |
| ----------------------------------------------- | ----- |
| denying guards (non-test, excluding `types.ts`) | 28    |
| …naming a tool or command                       | 24    |
| …naming no MCP tool at all → **N/A**            | 4     |
| …**discharge** on the availability axis         | 19    |
| …**do not discharge**                           | 1     |

The four N/A: `block-secret-file-read.ts`, `check-guessed-session-path.ts`,
`loop-preflight-pr-merge-check.ts`, `require-review-before-merge.ts`. Nothing in their text can age
this way.

### The axis, stated honestly

All three originating instances failed on one axis: **is the named mechanism actually reachable and
adequate on every surface the guard covers.** That is the axis judged. This is not a line-by-line
review of every other way an instruction could be wrong; a deeper per-guard surface-fit read of the
19 passing guards remains unexamined and is recorded as residue rather than claimed as done.

### The one that does not discharge: `block-git-gh-cli.ts`

It fails twice, and the second is the structural one.

**(a) Six `mcp__github__*` redirects share one failure mode.** `list_pull_requests`,
`pull_request_read`, `merge_pull_request`, `issue_read`, `issue_write`,
`pull_request_review_write` are all named in `reason` strings. The github MCP server dies when the
Docker daemon is down — which is the situation an agent reaching for `gh` is typically already in.
**mt#3779 owns one of these (`gh pr view`); the class is six.** Widened there rather than re-filed.

**(b) Every redirect assumes an MCP server is reachable, and the fallback shares the assumption.**
The module header records one availability lesson already: `session_exec` is carved out so the hook
never _"denies the very fallback its own denial text offers."_ That is correct reasoning about a
fallback the **guard** blocks, and silent about a fallback that does not **exist**.

`session_exec` is `mcp__minsky__session_exec`. When the Minsky MCP server is disconnected its tools
do not load at all, so the ~34 `mcp__minsky__*` redirect targets **and the documented escape hatch**
go together, leaving a denial that names nothing callable.

Observed twice while running this audit: a plain `git log` was denied with _"Use
`mcp__minsky__git_log` instead of `git log`"_, and during a later day-long outage every
`mcp__minsky__*` tool returned _"No matching deferred tools found."_ With the CLI denied and the MCP
surface absent, reading `.git/HEAD` and `.git/refs/heads/` by hand was the only remaining way to see
git state — the guard training an agent to route around it, which is the harm mem#1078 names.

**A guard cannot be more available than the mechanism its instruction names.**

### The fix, and why it is not runtime truncation

`REDIRECT_UNAVAILABLE_ESCAPE` is appended once at the denial site, covering all redirects: it names
the availability condition, says the fallback shares the failure mode, points at `/mcp` first, and
names `MINSKY_HOOK_OVERRIDE=block-git-gh-cli` as the audited path if the server stays unreachable.
The override string is composed from `GUARD_NAME` so it cannot drift from the guard it unlocks.

The calibration record deliberately keeps the **base** reason, so records stay groupable by
redirect.

PR #3405 R1 asked for a truncation guard on the emitted text. Measured, the concern does not hold in
that form: the escape is **475 chars**, the longest existing reason is **503**, worst case **978** —
against `MERGED_CONTEXT_BUDGET_CHARS = 6627`, which governs merged `additionalContext`, a different
channel. No deny reason is truncated anywhere in the corpus, and 32 rules in this file already emit
unbounded reasons. Truncating a fixed constant at runtime is meaningless; its length is known at
authoring time. The real risk is the constant **growing** unnoticed, so the bound is a test against
`MAX_ESCAPE_CHARS` plus a worst-case-total assertion across every shipped rule.

## The instance that did not survive reproduction

mem#1078's third instance claimed the deploy-verification gate fires on `src/cockpit/web/**` and
instructs a check that "cannot terminate", because `services/cockpit` is the shared
`cockpit-preview` Railway service.

**`src/cockpit/**`is not a cockpit surface.**`DEPLOY_SURFACE_SERVICE_MAP`in`packages/domain/src/deployment/deploy-surface.ts`maps`/^src\//` to **`minsky-mcp`** and says so
verbatim: *"cockpit web source is a minsky-mcp deploy surface as a BUNDLED INPUT of that image … the
COCKPIT service is still not a merge-deploy target."* That mapping landed in `da1a84cf4`(mt#4013)
on **2026-08-12, five days before mem#1078 was written**.`resolveDeploymentConfig`never guesses
cockpit either: with several`deploy.config.ts`present it requires a configured default or a`RAILWAY_SERVICE_ID` match, else throws.

So the gate asked for a check on a service with a stable referent. The moving BUILDING ids were
observed on cockpit-preview — a service the gate never named. Corrected at the origin in mem#1078.

**The lesson is the one the rule already teaches, applied to itself.** A recorded diagnosis is a
hypothesis to re-reproduce, not a settled premise; the cost of skipping that step here would have
been a fix built for a problem the service map already prevents.

## Cross-references

mem#1078 (the originating class) · mt#4226 (instance 1, DONE) · mt#3779 (instance 2, widened to six
redirects) · mt#4013 (the service map that falsifies instance 3) · ADR-043 (Proposed — the
tool-surface registry a deterministic "does this tool still exist" check would read) · ADR-028
(dispatcher consolidation; `block-git-gh-cli.ts` is not yet migrated).
