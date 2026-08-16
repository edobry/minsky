# Constructed-Identifier Detector (calibration)

> Extracted from `.minsky/rules/hook-observers.mdc` (mt#3667) — full narration,
> cross-references, and design rationale for this observer. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

**Hook file:** `.minsky/hooks/constructed-identifier-batch-detector.ts`
**Status:** calibration-first (mt#3125, mt#3340)
**Override:** `MINSKY_ACK_CONSTRUCTED_IDENTIFIER_BATCH`

Catches an agent writing an identifier it could not yet know — a task id, ask id, or memory id
that no tool call has returned. Root-tier sibling of the guessed-session-path guard and the
pre-narration detector: all three cover the same underlying failure, asserting a value the
substrate alone can mint.

## Two passes, deliberately different in kind

### (1) Batch — categorical, co-occurrence-based

An id-minting call (`tasks_create` / `session_start` / `session_pr_create` / `asks_create` /
`memory_create`) batched with an id-consuming call **in the same parallel tool-call batch**. Since
the batch is dispatched as one message, the consuming call cannot have seen the minting call's
result — so the consumed id was constructed. This pass needs no comparison of values; the
co-occurrence is sufficient.

### (2) Consume-before-mint — exact, cross-message (mt#3340)

A write naming an `mt#` / `ask#` / `mem#` id that has **no source earlier in the transcript**,
followed LATER in the same turn by a call that mints that kind of id.

This pass runs post-hoc, which lets it be EXACT rather than categorical: it compares the written
token against the id the minting call actually returned. It exists because the batch pass's
same-message-only rule silently assumed mint-before-consume, and the opposite order — write the
id you expect, then create the thing — was invisible to it.

## Consume surfaces

Both passes watch file writes (`session_write_file`, `session_edit_file`, `Write`, `Edit`) as
well as `session_commit`, `session_pr_create`, `session_pr_edit`, `tasks_spec_patch`, and
`memory_create`.

File writes are included for a specific reason: **a constructed id in SOURCE CODE ships**, and is
then read as fact by everyone downstream — a materially worse outcome than the same fabrication in
chat, which is ephemeral and contradictable.

## Cross-references

- mt#3125 — the batch pass.
- mt#3340 — the consume-before-mint pass.
- `guessed-session-path-guard.md` — root-tier sibling.
- `CLAUDE.md §Sequence Dependent Tool Calls` — the rule this enforces ("Never construct an
  identifier").

## The consume-before-mint pass carries an EXISTENCE discriminator (mt#3991)

A written `mt#` id that **already exists** is not a construction — it is an ordinary
cross-reference. The pass checks this with **one bounded DB lookup per turn**.

Without that check the pass fired on ordinary citations and measured **9/10 false**. Its original
discriminator was a prior-source check: assume a legitimate citation has a source earlier in the
transcript. That assumption is wrong in the common case — an agent citing a task it read from the
task graph, or knows from the session it planned, has no transcript source for it at all.

Two deliberate asymmetries:

- **A lookup that cannot run fires anyway** (fail-toward-firing). A DB the hook cannot reach must
  not silently convert the detector into a no-op; that is the mem#534 dead-detector shape.
- **`ask#` and `mem#` are unchecked.** Every measured fire was `mt#`, and each additional id space
  costs another lookup in a bounded per-turn budget. Widen it when a fire justifies it.
