# Merge-review REQUEST_CHANGES grant-channel override (mt#2989)

The `require-review-before-merge` PreToolUse gate denies `session_pr_merge` while the reviewer
bot's newest structured-provenance review on HEAD concludes `REQUEST_CHANGES`. Before mt#2989 that
denial had **no** in-band escape valve: a verified-false-positive finding (e.g. a grep-disproven
"duplicate section" the reviewer repeats across rounds — the mt#2921 / mt#2542 incidents) was
un-mergeable, and the agent had no operator-authorized way past it (`forceBypass` is denied at this
branch; a launch-time env var is unreachable to a mid-session agent — the reason mt#2989's original
env-var design was superseded via ask#5422).

mt#2989 adds an override on **that branch only** (stale / structural-gap / smoke / required-checks
denials are NOT overridable) built on the ADR-028 **D8 grant channel** — extended with a stricter,
operator-verified variant because this guard alone gates an irreversible action (a merge).

## How to use it (operator-authorized, agent-invokable)

1. The agent files an `authorization.approve` Ask stating the PR, the finding, and the disproof.
   The approving option's **value** must be approve-shaped (`approve` / `approved` / `yes`) — the
   verifier (`ask-verification.ts`, mt#3007) only honors a structured approval, never free-text.
2. On operator approval, issue a grant:

   ```
   bun scripts/grant-guard-override.ts --guard require-review-before-merge \
     --scope <owner/repo>#<pr>@<reviewedCommitSha> --ask <askId> --reason "<disproof>"
   ```

   `--ask` is **required** for this guard (issuance refuses without it). The scope binds both the PR
   and the reviewed commit SHA.

3. Re-attempt the merge. The gate consults the grant, re-verifies the linked Ask **server-side**,
   and — only on an operator-approved Ask — permits, marking the grant **consumed (one-shot)** and
   emitting an audit line + a `overrideSource: "grant"` fire-log record naming the Ask.

## Containment (all five load-bearing — do not relax)

- **Operator-approved Ask required**, re-verified server-side at decision time (a grant `reason`
  alone is insufficient — unlike the plain self-serve D8 guards).
- **Scope binds PR + reviewed commit SHA** — a new commit (new HEAD) invalidates the grant, so a
  legitimate REQUEST_CHANGES landing inside the TTL is not silently covered.
- **One-shot consumption** — the grant is spent on first use; a second merge attempt needs a fresh
  operator-approved grant.
- **TTL** — the grant expires (default 30 min).
- **Full audit** — the consumed grant record (with `askId`, `reason`, `consumedAt`), a stdout audit
  line, and a fire-log entry.

A grant present but with no `askId`, or whose Ask does not verify as operator-approved, is **denied
with a loud fabrication warning** — this branch does NOT inherit D8's fail-open read posture on the
verification leg.

## Escape / override

There is no env-var skip for this branch (that was the superseded design). The only path past a
REQUEST_CHANGES is the operator-approved grant above, or fixing the finding.

## Source

- `.minsky/hooks/require-review-before-merge.ts` — `makeRequestChangesOverrideResolver`, the
  REQUEST_CHANGES branch of `validateReviewContent`, and the entry-point audit.
- `.minsky/hooks/guard-grant-store.ts` — `askId` / `consumedAt` fields, `markGuardGrantConsumed`.
- `.minsky/hooks/ask-verification.ts` — `verifyApprovedAsk` (mt#3007).
- `scripts/grant-guard-override.ts` — `--ask` issuance.
- Decision lineage: mt#2902 (parent), ask#5422 (grant-channel decision superseding the env var),
  mt#2888 (the sibling D8 escape valve on `require-checks-on-bypass-merge.ts`).
