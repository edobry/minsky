# Cockpit Deeplinks in Terminal Output — extended rationale

> Extracted from `.minsky/rules/cockpit-deeplinks.mdc` (mt#3087 corpus trim, Phase 4). The
> compiled rule corpus carries the format instruction, the entity-type table, and the format
> rules in full; this file holds the mechanism detail and dependency notes. Nothing here changes
> agent behavior — the directive text in the rule is the complete behavioral contract.

## Renderer mechanism and the Surface A/B split

Claude Code's renderer turns `[label](minsky://...)` into an OSC-8 terminal hyperlink; macOS
terminals pass `minsky://` to `open`, and the cockpit-tray scheme handler (mt#2528) routes it to
the cockpit — **launching the cockpit first if it is not running**. So always emit the link;
never gate on whether the cockpit is currently open and never read cockpit state to decide.

**Dependency:** clickability requires the cockpit-tray app's `minsky://` OS scheme handler
(mt#2528) to be registered with the operating system. Where it is not — the tray app is not
installed, or the terminal is non-macOS / lacks OSC-8 — the link degrades to the plain label text
(which is why the label must always be a readable ref). This does NOT gate emission: emit the
link unconditionally and let it degrade gracefully.

This is Surface A (the terminal). There is no harness hook that rewrites assistant output, so
this linking is **agent discipline** — you emit the markdown by hand. (Surface B, the
in-cockpit transcript view, linkifies the same refs on its own side via mt#2518.)

## Additional examples

- `Routed the decision to ask [38b1c0de](minsky://ask/38b1c0de-0000-0000-0000-000000000000).`
- `Merged [PR #1234](minsky://changeset/1234) — reviewer-bot approved.`

## Cross-references

- mt#2517 — parent umbrella (cockpit deeplinks); mt#2519 — the compiled rule (Surface A / terminal).
- mt#2518 — Surface B (cockpit transcript linkifier) + the shared `(type,id) ↔ minsky:// URI ↔ path` codec this format matches.
- mt#2528 — the `minsky://` OS scheme handler in the cockpit-tray app (required for a terminal click to actually open the cockpit).
- mt#2535 — `/changeset/:id` cockpit detail route (ships the page the changeset URI navigates to).
- mt#2536 — PR/changeset linkification (adds `changeset` to RoutableEntityType + linkifier PR #N recognition).
- `docs/architecture/adr-022-session-vs-conversation-terminology.md` (Accepted) / `.minsky/rules/terminology-workspace-conversation.mdc` — the workspace/conversation/transport-session vocabulary for NEW code, docs, and cockpit UI copy. The `session` URI type above is deliberately NOT part of that rename (stage 1, mt#2686) — it stays `session` until the deferred stage-2 mechanical `session_*` → `workspace_*` tool-surface rename (mt#2527), which is the only stage that would touch this table.
