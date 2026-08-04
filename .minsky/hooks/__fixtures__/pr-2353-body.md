## Summary

Session-film ribbon expanded rows now show the REAL content of the event — thinking text, message text, what was written, ask text, or a tool call's params+result — fetched lazily on first expand and rendered with `ConversationView`'s own per-block renderers (extracted into a shared module, not forked), plus an "open in conversation view →" deep-link. Converges the film and the conversation view AT THE SEAM per the task's recommended direction, without merging the two surfaces.

## What changed

- **`packages/domain/src/transcripts/event-schema.ts`** — adds `EventSourceRef { turnIndex, messageUuid?, toolUseId? }` and an optional `SemanticEvent.sourceRef`.
- **`packages/domain/src/transcripts/event-adapter.ts`** — populates `sourceRef` on every emitted event (speak/think/ask via `emitSimpleEvent`, tool calls via `emitToolCallEvents`); bumps `ADAPTER_VERSION` to `event-adapter-v1`.
- **`src/cockpit/routes/session-film.ts`** — new `GET /api/cockpit/session-film/content?conversationId=&verifiedRescrubbed=`: fetches the transcript via the same `getTranscript()` seam the events endpoint uses, converts it to `SessionContextSnapshotBlock[]` via `turnLineToBlock` (the identical per-index conversion `assembleSessionContextSnapshot` applies), and calls `assertScrubGate` exactly as `/events` does. Deliberately does NOT route through the ungated `/api/cockpit/context-inspector/snapshot`.
- **`src/cockpit/web/components/ConversationElementRenderers.tsx`** (new) — `ThinkingBlock`, `ToolInvocation`, `ToolResult`, `InjectedContentBlock`, `ElementView` and their supporting types, extracted verbatim out of `ConversationView.tsx` so both surfaces import the same code.
- **`src/cockpit/web/widgets/ConversationView.tsx`** — imports the extracted renderers instead of defining them locally; turn-level assembly (`pairToolInvocations`, `TurnView`, `CompactionBoundary`) is unchanged.
- **`src/cockpit/web/lib/session-film-client.ts`** — `fetchSessionFilmContent`, `sessionFilmContentQueryKey`, and `resolveEventContent` (maps a `SemanticEvent` + fetched blocks to a `PreparedElement` via `sourceRef`, reusing `snapshotBlockToConversationTurn`).
- **`src/cockpit/web/components/session-film/SessionFilmRibbon.tsx`** — expanded-row detail now fetches content lazily (one whole-transcript query per conversation, gated on `expandedRowIndex !== null`) and renders it via `EventContentView` (loading / content-unavailable / no-content-captured / real content), plus the deep-link.
- **`eslint.config.js`** — extends the existing `COCKPIT_PALETTE_EXEMPT_FILES` entry (categorical sky/violet chips) to the new shared renderer file, since the moved code carries the same exemption rationale as `ConversationView.tsx`.

## Design notes / findings during implementation

- **`deriveFilmSubjectAgentId` returns a NAMESPACED id** (`agents:<agentSessionId>`), not the bare conversation id — a live test caught this before it shipped (the deep-link initially pointed at `/conversation/agents%3Aa1`). The ribbon now derives the bare conversation id directly from any agent-actor event's `agentSessionId` (`filmConversationId`), separate from the namespaced `subjectAgentId` self-reference-elision already used.
- **`verifiedRescrubbed` is not threaded from `SessionFilmPage.tsx`** into the ribbon's content fetch (that page owns its own re-scrub-confirmation state, out of scope for this task's file list). Defaults to `false`; documented as a follow-up in the prop's doc comment.
- **Thinking text is NEVER stored — corrected 2026-07-28 by coordinator measurement.** An earlier draft of this note said Claude Code "sometimes" records an empty `{"type":"thinking","thinking":"","signature":"..."}` block. The corpus says always: across every transcript in this project's local corpus, `28945 EMPTY / 0 NONEMPTY`. Correct field name, signature present (~1300 chars), text discarded before it reaches disk. So SC2's THINK case cannot be satisfied by ANY UI change against the current corpus — this PR delivers real content for SPEAK, ASK, WRITE/CREATE and tool calls, and a correct, non-crashing, deep-linked summary row for THINK. Whether thinking text is capturable at all is **mt#3276**, which also owns making the THINK row's copy distinguish "this harness does not record thinking text" from "content failed to load."
- **Filed mt#3275**: the Vite dev server (`--dev` / HMR mode) hangs indefinitely (pegged CPU) on any request under `src/cockpit/web/components/session-film/`, including files this PR did not touch (`SessionFilmStage.tsx`). Reproduced twice, including after a full `node_modules/.vite` cache wipe. Did not block this PR — verification instead ran against the production Vite build (`bun run cockpit:build`, 2578 modules, no errors), served via `bun src/cli.ts cockpit start --port=<N>` (non-dev).

## Execution evidence:

Acceptance tests below use mt#3262's OWN spec numbering (AT1–AT5).

```
$ bun test --preload ./tests/setup.ts --timeout=15000 packages/domain/src/transcripts/event-adapter.test.ts
 17 pass
 0 fail
 85 expect() calls
# AT1 (sourceRef.turnIndex round-trips with the snapshot's turnIndex):
# "adaptTranscriptToEvents — mt#3262 AT1: sourceRef.turnIndex round-trips with
#  the snapshot's turnIndex" — asserts every event's sourceRef.turnIndex
#  resolves, via turnLineToBlock (the same conversion assembleSessionContextSnapshot
#  applies at the same index), to the SAME source transcript line.

$ bun test --preload ./tests/setup.ts --timeout=15000 src/cockpit/routes/session-film.test.ts
 19 pass
 0 fail
 40 expect() calls
# AT5 (pre-scrub-cutoff session refused by the content endpoint unless
# verifiedRescrubbed=true), both directions:
# "422s (unscrubbed) for a pre-cutoff session with no verifiedRescrubbed assertion"
# "200s for a pre-cutoff session when verifiedRescrubbed=true is asserted"
# against GET /api/cockpit/session-film/content — same scrub-gate shape as /events.

$ bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts --timeout=15000 \
    src/cockpit/web/lib/session-film-client.test.ts
 17 pass
 0 fail
 30 expect() calls
# AT2 (real content per verb kind): resolveEventContent unit tests for
# think / speak / ask / tool-call resolution.
# AT4 (missing content degrades gracefully, no crash): 4 cases — no sourceRef,
# blocks still loading, unknown turnIndex, unmatched toolUseId — all return
# null, never throw.

$ bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts --timeout=15000 \
    src/cockpit/web/components/session-film/SessionFilmRibbon.test.tsx
 33 pass
 0 fail
 72 expect() calls
# 6 new tests (mt#3262):
# AT2 — SPEAK / ASK / tool-call(WRITE) content rendering via the shared ElementView.
# AT3 (deep-link navigates to the conversation view) — asserts the
#      "open in conversation view" href resolves to /conversation/<bare id>.
# AT4 — the no-sourceRef degrade path.
# AT5 — the 422 scrub-gate degrade path as rendered in the ribbon.

$ bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts --timeout=15000 \
    src/cockpit/web/widgets src/cockpit/web/lib src/cockpit/web/components \
    src/cockpit/web/pages src/cockpit/web/hooks
 1457 pass
 0 fail
 3073 expect() calls
Ran 1457 tests across 120 files.
# full cockpit-web component suite — the extraction's regression net
# (ConversationView must keep rendering identically): no new failures.

$ bun run cockpit:build
vite v5.4.21 building for production...
✓ 2578 modules transformed.
✓ built in 2.78s
# ConversationElementRenderers-CNUMoM3B.js present in the output — the shared
# module bundles correctly.

Typecheck: clean (mcp__minsky__validate_typecheck, 0 errors, both root +
src/cockpit/web workspaces).
Lint: clean (mcp__minsky__validate_lint, 0 errors after the eslint.config.js
palette-exemption addition).

AT2 live-browser evidence (screenshots below, per verb kind).
AT3 live-browser evidence (deep-link href confirmed in the ASK screenshot).
AT2 THINK sub-case: live-verified as the structurally-empty real-data case —
see the "Thinking text is NEVER stored" design note above and mt#3276. No
screenshot of rendered thinking text is obtainable against the current corpus
(28945/28945 blocks empty), so AT2's THINK leg is satisfied by the
graceful-degrade path plus the non-empty ThinkingBlock unit test rather than
by a live screenshot.
```

## Live-browser verification (mem#734 / mem#561 discipline)

Driven via chrome-devtools MCP against the production build (`bun run cockpit:build` → `bun src/cli.ts cockpit start --port=<N>`, non-dev — see the mt#3275 note above for why dev mode was unusable here). Exercised as a user would: opened `/session-film`, clicked a real session from the picker (session `9ac533fc-d31c-4b9c-93b9-bf5933fe1d1d`), then clicked real rows in the ribbon (never hand-typed a `?session=&t=` URL to a known-good state). Asserted END content, not a loading state, in every screenshot.

- **ASK** — expanding the film's opening ASK row shows the real, full prompt text the operator typed, plus the deep-link.
  ![ASK expanded](https://github.com/edobry/minsky/releases/download/pr-2353-mt3262-screenshots/ask-expanded.png)
- **SPEAK** — expanding a SPEAK row shows the real assistant message text.
  ![SPEAK expanded](https://github.com/edobry/minsky/releases/download/pr-2353-mt3262-screenshots/speak-expanded.png)
- **THINK** — expanding a THINK row: this corpus's thinking blocks are all recorded empty (see the design note); the row still shows a correct, non-crashing detail (Target/Verb/Outcome/Duration + deep-link).
  ![THINK expanded](https://github.com/edobry/minsky/releases/download/pr-2353-mt3262-screenshots/think-expanded.png)
- **Tool-call (RUN/Bash)** — expanding a tool-call row shows the collapsed `ToolInvocation` summary (real tool name + args digest + outcome); clicking it further expands to the full args JSON via `ToolPayload`. WRITE-verb tool calls render through this SAME `ToolInvocation` component (verified live for `RUN`/Bash; verified for WRITE specifically via `SessionFilmRibbon.test.tsx`'s dedicated WRITE test, asserting `session_write_file` / `a.ts` / `ok` render).
  ![Tool-call collapsed](https://github.com/edobry/minsky/releases/download/pr-2353-mt3262-screenshots/run-expanded.png)
  ![Tool-call expanded](https://github.com/edobry/minsky/releases/download/pr-2353-mt3262-screenshots/run-tool-invocation-expanded.png)

No overlap or clipping observed at any scroll position across all five screenshots — the expanded row's real content pushes neighboring rows down in normal document flow (per the ribbon's `ResizeObserver`-fed virtualizer height, unchanged from the pre-existing `expandedRowExtra` mechanism).

Screenshots are hosted as assets on the `pr-2353-mt3262-screenshots` prerelease (mem#739 method). Per mem#739's corrected guidance, that prerelease is RETAINED after merge — deleting it would 404 the evidence above.

## Reviewer finding disposition

`minsky-reviewer[bot]` APPROVED with 0 blocking and 1 NON-BLOCKING finding: the content query's `queryKey` is built with an empty conversation id (`sessionFilmContentQueryKey(filmConversationId ?? "", …)`) while the query is disabled. Accepted as-is: `enabled` gates on `filmConversationId !== null`, so `queryFn` never runs under the `""` key and no data is ever cached against it. Zero user-visible or correctness impact; not worth a re-review round.
