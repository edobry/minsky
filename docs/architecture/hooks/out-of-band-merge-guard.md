# Out-of-Band Merge Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A PreToolUse hook on `mcp__minsky__session_pr_merge` and on `Bash`/`session_exec` (when the
command invokes `gh api PUT /pulls/N/merge`) blocks a merge when the PR body documents a
coupled out-of-band coordination step. Mt#1681 / PR #1013 was merged with a documented
"out-of-band" Railway service-config flip that was never executed; the codebase + Railway
entered a half-shipped state where the next push would crash the build. This hook catches
that class at the merge surface.

**Hook file:** `.claude/hooks/block-out-of-band-merge.ts`

**How it works:**

1. Resolves the PR number — for `session_pr_merge`, via `gh pr list --head task/<id>`; for
   the `gh api PUT` bypass path, by extracting `<N>` from the URL pattern `/pulls/<N>/merge`.
2. Fetches the PR body via `gh pr view <N> --json body`.
3. Scans the body for trigger phrases (case-insensitive — 2 standalone + 3 pair-required
   per mt#2002/mt#2019, down from 6 at the mt#1020 R1 count): `post-merge config`,
   `serviceInstanceUpdate` (standalone), `Railway config change`, `rootDirectory`,
   `dockerfilePath` (pair-required). `out-of-band` is a PAIR_PARTNER but not a trigger
   (see Pair-requirement section below).
   Each phrase is either a literal substring of the mt#1681 PR body or a Railway/GraphQL
   identifier with near-zero benign use.
4. On match, blocks with a structured message naming each matched phrase, a short surrounding
   excerpt for context, and the override mechanism.

**Markdown-aware filtering (mt#1707):** before substring scanning, the hook elides three
markdown contexts that carry textual references rather than coordination instructions, per
CommonMark:

- **Inline code spans** — backtick-delimited with variable run length
  (`` `rootDirectory` `` and ` `rootDirectory` ` both elided). The closing run must
  match the opening run length and not be followed by another backtick.
- **Fenced code blocks** — backtick OR tilde fences (3+ markers), opening line indented
  up to 3 spaces, optional info string, CRLF-tolerant; closing fence matches the opening
  marker exactly.
- **Blockquote lines** — up to 3 leading spaces, one or more `>` markers (covers nested
  quotes like `>>`), CRLF-tolerant.

The elision pass replaces matched content with same-length whitespace, preserving
character positions so excerpts in the denial message still slice from the ORIGINAL
body and show real surrounding context. Trigger phrases in bare prose (e.g., "after
merge, set rootDirectory to empty") continue to fire — only textual references in
markdown contexts are filtered out. Originating false-positive: mt#1701 PR #1021
(2026-05-09) DEPLOY.md docs update, where field-name references in code spans tripped
the substring matcher and the author worked around it by paraphrasing in the PR body.

**Known limitation:** CommonMark "lazy continuation" — a blockquote paragraph wrapped
onto subsequent lines without a leading `>` marker — is not elided on the wrapped lines.
The first marked line is still elided; only the wrapped continuation remains scannable.
This is rare in PR bodies (CommonMark renderers do handle it, but humans usually repeat
the `>` marker per line); flagged here so a future false-positive can be diagnosed
quickly.

**Pair-requirement (mt#2002, narrowed mt#2019):** the trigger phrases are split into two
categories:

- **STANDALONE phrases** (fire on any bare-prose occurrence): `post-merge config`,
  `serviceInstanceUpdate`. These describe coordination shapes with no benign use pattern.
  `out-of-band` was removed from this category in mt#2019 to prevent false positives
  on architectural prose (e.g., "out-of-band consumers" describing module callers in
  the import graph — originating incident mt#2010 PR #1217). It remains a PAIR_PARTNER.
- **PAIR-REQUIRED phrases** (fire only when paired with a partner in the same
  CommonMark paragraph): `rootDirectory`, `dockerfilePath`, `Railway config change`.
  These are Railway/config-field identifiers that legitimately appear in PR bodies
  as test-plan documentation, synthesizer-shipping descriptions, or synthesizer
  cross-references.

The PAIR_PARTNER phrases are `out-of-band` and `post-merge` (the bare `post-merge`
form matches both `post-merge` and `post-merge config`). When a pair-required
phrase appears in the SAME PARAGRAPH (text separated by a blank line) as a partner,
the combination is the strong signal; when it appears alone, it's likely a reference.
`out-of-band` is a PAIR_PARTNER (activates pair-required phrases when co-occurring)
but is NOT itself a trigger — it doesn't fire alone on architectural prose.

Originating false-positive cluster (mt#2002): PR #1028 self-fire on mt#1707 (docs
referencing Railway field names); PR #1204 self-fire on mt#1964 chunk 1
(synthesizer-shipping description). Both bypassed via `MINSKY_ACK_OOB_MERGE=1`
before mt#2002 shipped; post-mt#2002 the bare-prose mentions are correctly suppressed
unless a partner is in the same paragraph.

Additional false-positive fixed by mt#2019: mt#2010 PR #1217 used "out-of-band
consumers (smoke scripts, unit tests)" to describe module callers in architectural
prose. The hook fired; the author worked around by rephrasing. After mt#2019,
bare `out-of-band` in architectural prose no longer fires. The originating
mt#1681 true-positive still fires via `serviceInstanceUpdate` in bare prose.

**Known limitation:** historical-incident descriptions that put both a pair-required
phrase AND a partner in the same paragraph (e.g., "mt#1681 PR #1013 (rootDirectory
flip documented as out-of-band)") still fire under pair-requirement because the
pair-partner is in the same paragraph. Resolving this without breaking the actual
mt#1681-style coordination signal requires a different mechanism (e.g.,
`## Originating-Context` heading exclusion or NLP-based intent classification) and
is out of scope for mt#2002.

**On block:** the hook denies with this shape:

> "PR #N's body documents a coupled out-of-band step. Confirm the step is completed (or
> pre-authorized) BEFORE merging. Matched trigger phrases: [list with excerpts]. If the
> out-of-band step has been completed (or is intentionally deferred with acknowledgment),
> set `MINSKY_ACK_OOB_MERGE=1` in your environment and retry. The override is audit-logged."

**Override mechanism:** Set `MINSKY_ACK_OOB_MERGE=1` in your environment before invoking
the merge. The override emits an audit-log line to stdout naming the PR, matched phrases,
and timestamp. Use only when the out-of-band step is genuinely complete (or intentionally
deferred with operator acknowledgment).

**Fail-open posture:** if `gh pr view` fails (network, auth, PR not found), the hook emits
a warning to stderr and ALLOWS the merge. This matches `check-branch-fresh.ts` — the hook
should never block a merge for reasons unrelated to its own concern.

**Tracking task:** mt#1695. **Originating incident:** mt#1681 PR #1013 (2026-05-09) — Railway
`rootDirectory` + `dockerfilePath` flip was documented as "out-of-band, post-merge" in the PR
body but never executed; the auto-mode classifier denied the GraphQL mutation post-merge,
leaving the deploy in a half-shipped state.

**Relationship to mt#1626 (`/plan-task` gate criterion (h)):** mt#1626 is the planning-time
complement — it catches contract-propagation gaps at task-planning time. This hook is the
merge-time complement; both fire independently. mt#1626's gate has a coverage hole when a
task doesn't go through `/plan-task` (mt#1681 was planned via main agent and bypassed it).
This hook catches the class at the actual decision point regardless of the planning path.
