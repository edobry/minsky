# ADR-008: In-Band Review Semantics — Compile Reviewer Findings to GitHub Primitives

## Status

**ACCEPTED** — Documented 2026-04-27. Builds on [ADR-005](./adr-005-forgebackend-subinterfaces.md) (`ReviewOperations` sub-interface) and [ADR-006](./adr-006-agent-identity.md) (bot identity for review submission). Tracks the cluster of work under [mt#1335](../../process/tasks/mt%231335.md).

## Context

### What we observe today

The `minsky-reviewer[bot]` agent posts findings as Markdown text in the body of a PR review. Each finding follows a pattern like `**[BLOCKING]** \`file:line[-range]\` — body`. PR #815 is the canonical example: 14+ findings, every one citing a specific `file:line`or`file:line-range`, **zero** anchored review comments (`get_review_comments`totalCount: 0). The`submitReview`tool already accepts a`comments[]` array of line-anchored comments end-to-end (`src/domain/repository/github-pr-review.ts:23-32, 89-96`), and the MCP tool schema exposes the same shape (`src/adapters/shared/commands/session/session-parameters.ts:664-691`). The capability is wired; the prompt simply never instructs the reviewer to populate it. Two reasons compound that gap:

1. **The reviewer prompt** (`.claude/agents/reviewer.md`) teaches an output format of `[BLOCKING] file:line — body` as Markdown text, never `comments[]`.
2. **The context tool** (`session_pr_review_context`) returns the diff as a single unified-diff string. To produce a valid `comments[]` entry, the reviewer must parse `@@` hunk headers, pick a line that lies in a hunk, and pick a matching `side`. GitHub rejects the _entire_ `createReview` call with 422 if a single comment is off-diff. That foot-gun makes attempts costly and pushes the model back to body-Markdown output.

### Why this matters

A review finding has structure: a path, a line (or line range), a severity, often a suggested fix, sometimes a verification status, and a thread lifecycle (open → resolved or outdated). GitHub has primitives for every one of those:

- **Path + line + side** → review comment anchor (`octokit.rest.pulls.createReview` `comments[]`)
- **Path + line range** → multi-line review comment (`start_line` / `start_side`)
- **Suggested fix** → ` ```suggestion ` fence inside a comment body, renders as a one-click apply button
- **Severity** → check-run annotation (`failure` / `warning` / `notice`), can gate merge via branch protection
- **Lifecycle** → review thread state (`isResolved`, `isOutdated`), mutated via the GraphQL `resolveReviewThread` / `unresolveReviewThread` mutations

The current pipeline collapses all of that to a body Markdown blob. The structural information GitHub designed primitives for — anchor, severity, lifecycle, suggestion, outdated-ness — is recoverable only by re-parsing the body. That has three concrete costs:

1. **No per-finding lifecycle.** Body-blob findings can't be resolved, can't be marked outdated when code changes. Every review round restarts from scratch.
2. **No PR-conversation→code navigation.** The body blob has no anchors GitHub renders next to the diff.
3. **Iteration burns convergence.** On round N+1 the reviewer goes in blind: it can't see what was already raised, what was resolved, what's outdated. Result: duplicate findings, stale threads accumulate. The `mt#1110` calibration data shows reviews of non-trivial PRs take 7+ rounds to converge for this reason (PR #763).

### Adjacency to ADR-005

ADR-005 introduced the `ReviewOperations` sub-interface and added `submitReview` (mt#847) for bot-identity reviews. That ADR established the **shape** of the abstraction (sub-interface, optional method, GitHub-first). This ADR extends it with the **semantic content** of a review — the per-finding primitives that compile to GitHub's review surface.

## Decision

We compile each reviewer finding to GitHub's structured review primitives at the forge boundary, not at the prompt boundary. The review _body_ becomes the executive summary on top of a live data structure (anchored comments + check annotations + suggestion blocks + thread state) instead of being the substrate.

The work is decomposed into 10 sibling tasks (mt#1336–mt#1348) spanning four layers:

### Layer 1 — Context (read side)

Surface the structural information the reviewer needs to produce valid anchored comments:

- **mt#1336** — `parsedDiff` in `session_pr_review_context`. Pre-parse `@@` hunks into `[{ path, status, hunks: [{ oldStart, oldLines, newStart, newLines, lines: [{ side, oldLine, newLine, content }] }] }]`. Removes the off-diff foot-gun that currently pushes the reviewer back to body Markdown.
- **mt#1343** — `reviewThreads` in `session_pr_review_context`. Surface existing thread state (id, path, line, isResolved, isOutdated, comments) so the reviewer can confirm-resolved or carry-forward existing threads instead of duplicating.

### Layer 2 — Forge primitives (write side)

Extend the forge to expose every primitive GitHub offers:

- **mt#1337** — Multi-line review comments. Extend `ReviewComment` with `startLine` / `startSide` and the Octokit mapping. Most findings are range-shaped; single-line shape forces them back into body prose.
- **mt#1341** — Suggestion-block compilation. Add a `Suggestion { path, line, suggestion, rationale }` shape that compiles to a comment with a ` ```suggestion ` fence — turns rote nits into one-click applies.
- **mt#1342** — `resolveReviewThread` / `unresolveReviewThread` via GraphQL. Required for iteration to converge; missing today.
- **mt#1346** — Check Run annotations as a parallel surface. Each finding compiles to both a review comment (human-shaped) and a check annotation (machine-shaped, branch-protection-eligible, scales past the soft cap on inline review comments).
- **mt#1348** — Auto-apply review-state labels (`review:needs-changes`, `review:bot-approved`, etc.) on review submission for cheap external consumption (sweepers, cockpit).

### Layer 3 — Validation guard

- **mt#1347** — Pre-flight validation against `parsedDiff`. Each `comments[]` entry's `(path, line, side)` is checked before the Octokit call; off-diff anchors return a typed error with the nearest valid anchor instead of an opaque 422 that fails the whole batch.

### Layer 4 — Reviewer prompt + iteration loop

- **mt#1340** — Update `.claude/agents/reviewer.md` to consume `parsedDiff` and emit `comments[]` for every location-bearing finding. Reserve the body for executive summary, spec-verification table, CI status. Worked examples for ranged `[BLOCKING]` and single-line `[NON-BLOCKING]`.
- **mt#1345** — Reply-to-thread + auto-resolve-on-fix loop. With thread state in context (`mt#1343`) and the resolve mutation available (`mt#1342`), the reviewer replies to existing threads instead of opening duplicates, and resolves threads when the next push addresses them. Closes the convergence loop. Bot-authored threads only — never auto-resolves human threads.

### Dependency edges

```
mt#1335 (parent)
  ├── mt#1336 (parsedDiff) ──────────┐
  ├── mt#1337 (multi-line comments) ─┤
  │                                  │
  ├── mt#1340 (prompt update) ◄──────┤  (blocked on mt#1336 + mt#1337)
  ├── mt#1347 (validation guard) ◄───┘  (blocked on mt#1336)
  │
  ├── mt#1341 (suggestion blocks)
  ├── mt#1346 (check run annotations)
  ├── mt#1348 (review-state labels)
  │
  ├── mt#1342 (resolve thread mutations) ─┐
  ├── mt#1343 (reviewThreads in context) ─┤
  │                                       │
  └── mt#1345 (reply + auto-resolve) ◄────┘  (blocked on mt#1342 + mt#1343)
```

## Consequences

### Benefits

- **Per-finding lifecycle.** Threads can be resolved, replied-to, and marked outdated. Round N+1 becomes incremental (only-new-or-still-broken) instead of restart-from-scratch.
- **One-click suggestion apply.** Rote nits become applicable from the GitHub UI without a manual edit by the author.
- **Branch-protection integration.** Check-run conclusions can gate merge on `[BLOCKING]` count > 0; review comments cannot do this directly.
- **Machine-readable consumers.** Cockpit widgets, sweepers, and other bots can consume check annotations and labels without re-parsing review-body Markdown.
- **Survives across rounds.** Check runs replace each other on each push; comments can be replied to and resolved. Both shapes are stable in ways the body blob is not.

### Trade-offs

- **More forge surface to maintain.** GraphQL plumbing (`octokit.graphql`) adds to the GitHub backend alongside the existing REST-based `submitReview`. The thread-resolution mutations and the `reviewThreads` query are GraphQL-only.
- **Dual review surfaces.** Posting both a review (with `comments[]`) and a check run on every review is two writes per round. The duplication is intentional (review comments are the human-facing thread surface; check annotations are the machine-facing severity-aware surface) but it does double the write traffic.
- **Reviewer prompt complexity grows.** The reviewer must now understand thread state, decide reply-vs-new-thread, classify resolve-vs-outdated, and choose between prose / suggestion / check annotation. The prompt update (`mt#1340`, `mt#1345`) is non-trivial and will need calibration alongside `mt#1110`.
- **Migration cost is per-tool, not per-call-site.** Unlike ADR-005, this isn't a renaming campaign — it's adding new forge methods and a new tool field. Existing consumers continue to work; the new shapes are additive. Reviewer behavior change is one prompt edit gated on the layer-1/2 prerequisites.

### Negated alternatives

- **Keep everything in body Markdown; build a parser.** Rejected: brittle (each prompt revision can break parsing) and recovers only the syntactic part of the structure, not the lifecycle (resolved / outdated). The forge already has the structural API; using it is strictly cheaper than parsing free text.
- **Use only check-run annotations; abandon review comments.** Rejected: check annotations are read-only from the author's perspective. There's no thread, no reply, no human-facing conversation. Necessary for branch protection and machine consumption, not sufficient for human review.
- **Use only review comments; abandon check runs.** Rejected: review comments don't gate merge, accumulate across rounds (no replace-on-push), have a soft scaling limit before the UI degrades, and are not designed for machine consumption. Necessary for human review, not sufficient for branch protection or machine consumers.
- **Land the reviewer prompt update first; backfill the substrate later.** Rejected: the prompt-only path produces 422s on off-diff anchors and silently fails the whole review. The substrate (mt#1336 parsedDiff + mt#1337 multi-line + mt#1347 validation) is a hard prerequisite. The dependency edges enforce this ordering.

## Mapping: finding → primitives

| Reviewer finding shape                             | GitHub primitive                             | Implemented in    |
| -------------------------------------------------- | -------------------------------------------- | ----------------- |
| `[BLOCKING] path:line — body`                      | review comment, `failure` annotation         | mt#1340 + mt#1346 |
| `[NON-BLOCKING] path:line — body`                  | review comment, `warning` annotation         | mt#1340 + mt#1346 |
| `path:line-range` (range)                          | multi-line review comment + range annotation | mt#1337 + mt#1346 |
| `body: replace X with Y`                           | review comment with ` ```suggestion ` block  | mt#1341           |
| Carried forward from previous round (still broken) | reply-in-thread (no new thread)              | mt#1345           |
| Fixed by latest push                               | `resolveReviewThread`                        | mt#1342 + mt#1345 |
| Code rewritten — finding no longer applies         | `isOutdated` (auto), reviewer marks resolved | mt#1343 + mt#1345 |
| Per-PR review state                                | label (`review:needs-changes`, etc.)         | mt#1348           |
| Spec verification, CI status, executive summary    | review _body_ (the only thing left there)    | mt#1340           |

## Implementation status

In progress as of 2026-04-27:

- **PR [#831](https://github.com/edobry/minsky/pull/831)** (mt#1337) — multi-line review comments — IN-REVIEW. Initial review flagged a side-defaulting hole (caller passing `{ startLine, startSide: "LEFT", no side }` produced a mismatched payload that GitHub would reject); fix landed in commit `2416acde5` to infer `side` from `startSide` when only one is provided.
- **PR [#835](https://github.com/edobry/minsky/pull/835)** (mt#1336) — `parsedDiff` in context — IN-REVIEW.
- **PR [#838](https://github.com/edobry/minsky/pull/838)** (this ADR) — IN-REVIEW.

mt#1340 (prompt update) is blocked on mt#1336 and mt#1337. The remaining tasks (mt#1341–mt#1348) are READY-able once mt#1340 is in flight; they're independently schedulable across the four layers.

## References

- [ADR-005: ForgeBackend Sub-Interfaces](./adr-005-forgebackend-subinterfaces.md) — predecessor; established `ReviewOperations`
- [ADR-006: Agent Identity](./adr-006-agent-identity.md) — bot identity used by `submitReview` and the new GraphQL mutations
- [mt#1335](../../process/tasks/mt%231335.md) — parent task and sibling cluster
- `.claude/agents/reviewer.md` — reviewer subagent prompt (target of mt#1340)
- `src/domain/repository/github-pr-review.ts` — current forge layer (extended by mt#1337, mt#1342, mt#1346)
- `src/domain/session/commands/pr-review-context-subcommand.ts` — context tool (extended by mt#1336, mt#1343)
- `src/adapters/shared/commands/session/session-parameters.ts` — MCP tool schema (extended by mt#1337, mt#1341)
- `mt#1110_calibration` memory — observed cost of body-blob review iteration
