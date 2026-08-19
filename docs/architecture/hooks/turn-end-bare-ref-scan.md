# turn-end-bare-ref-scan

Stop-event observer (mt#3286): the turn's closing message carries an entity
reference the reader cannot click.

This page holds the narration that `hook-observers.mdc` deliberately does not —
it was extracted verbatim from that rule's index entry when the entry alone had
grown past a third of the rule's per-rule ceiling (mt#3676). Nothing here is
new; the index entry now carries the trigger, the posture, and the override, and
points at this page for the rest.

## Why it exists

`cockpit-deeplinks.mdc` sets a FLOOR: link the first mention of an entity in every message where
it appears, and link every pending-decision entity again in the turn's closing message. The floor
exists because a link three messages up is not at hand where the operator acts. Recurrences
mem#623 R3–R6 were all compliant with the rule's one-link-per-entity CEILING and unusable anyway,
which is what a missing floor looks like. This guard is that floor's advisory enforcement,
calibration-first per ADR-024.

## Finding classes and enforcement posture

Posture is per finding class, not per guard. mt#3897 SWAPPED the two bare
classes so the flagged set tracks the COMPLEMENT of what the display linkifier
repairs:

| Class                                             | Posture     |
| ------------------------------------------------- | ----------- |
| `bare-short-id` — bare `ask#N` / `mem#N` / `ws#N` | LIVE        |
| `malformed-target`                                | LIVE        |
| `raw-uuid-label`                                  | LIVE        |
| `bare-ref` — bare `mt#N` / `PR #N`                | RECORD-ONLY |
| `author-linked-short-id`                          | RECORD-ONLY |

`bare-ref` is record-only because mt#2565's display linkifier repairs those refs
at display time; 13 of 13 injected warnings for the class were measured false.
`author-linked-short-id` is record-only for a different reason — see below.

Both halves of that posture are operator decisions, not maintainer ones:
ask#7415 enabled the short-id class, and ask#7639 retired the task/PR warnings
while keeping the two malformed classes live.

## The complement is computed per finding, not per class (mt#3960)

mt#3914 shipped the short-id→UUID map that the display path reads, so a MAPPED
short id is auto-repaired exactly like `mt#N`, while an UNMAPPED one — minted
since the last sweep, or any id at all when no cockpit is running — still
reaches the reader bare.

The scan therefore consults that same map and flags only what it cannot resolve.
A suppressed finding is recorded as `linkable-short-id`, so a later pass can
measure how much of the class mt#3914 absorbs. An absent or corrupt map flags
EVERYTHING (ADR-024 fail-to-Rung-1), never nothing.

This narrowing needed no ask because it retires no class. Retiring
`bare-short-id` outright is still an operator decision, and mt#3947 holds the
fire data for it. Measured before the narrowing: 5 of the first 6 injected
phrases after mt#3914 named ids the map already held.

## The author may have linked it already (mt#4160)

The `bare-short-id` check has always been MESSAGE-scoped: `linkedShortIds` is
collected across every occurrence before deciding, so linking the first mention
and writing the rest bare does not flag. What it keyed on was the LABEL — the
short id had to sit inside `[mem#1045](minsky://memory/<uuid>)`.

`collectLinkLabelRanges`'s doc comment says why that was the only key available:
an `ask#N` target is a UUID with no trace of `N` in it, so position was the only
thing tying the two together. That holds given only the message text, and stops
holding once the short id can be RESOLVED.

The gap it left is the `/handoff` skill's own closing line, which puts a prose
title in the label and the short id in a trailing parenthetical:

```
Handoff recorded: [interception taxonomy + thin-hooks RFC](minsky://memory/764137ed-…) — memory `764137ed` (mem#962).
```

The link and the flagged ref name the same entity, one clause apart, and the
label check cannot see it. That message is fully compliant with
`cockpit-deeplinks.mdc` — the floor is "link the first mention of an entity in
every message where it appears," the ceiling is "one per entity per message is
plenty" — so the advisory was asking for a link that was already there.

**Measured, replayed over the whole calibration log by
`scripts/replay-bare-entity-ref-suppression.ts`: 23 of 43 lifetime
`bare-short-id` fires had the entity linked in their own message.** Of the 26
that mt#4160's calibration pass hand-classified from transcripts, the
suppression removes exactly the 16 rated false and none of the 10 rated real.

### Rating a fire no longer needs the transcripts (mt#4161)

The pass above had to recover each judged message by scanning session
transcripts by timestamp, because the records carried `matches` and nothing to
judge them WITH. That worked and was never guaranteed to: transcripts age out
(mt#3821 measured 12 of 959 records with none left), so the archaeology step
could simply fail for a later pass.

Records now carry the message they judged. Each one has `captureSchema` (the
mt#3607 marker) and `judgedMessage` — a bounded `captureArtifact` snapshot with
`excerpt`, `hash`, `length` and `truncated`. A rating pass reads the record.

The WHOLE message is captured rather than a per-match window, because two of the
three questions that settle a fire are about the message as a whole: was this the
FIRST mention of the ref, and was a UUID in hand somewhere else in the message.
`extractMatchContext`'s 240-char window answers neither. `truncated` is recorded
so a pass reading a capped capture reports partial rather than a verdict.

**Reading the marker: it lives in the record's `detectorFields` passthrough, not
at the top level.** No per-kind parse branch names `captureSchema`, so
`parseDetectorFields` routes it there for every log kind, and
`hasCaptureMarker` reads it from there and requires a NUMBER (mem#888).

Retention: the captured text flows verbatim into shared `guard_events` like
every other ingested stream, per ask#8908 — mt#3872's original "local-only"
premise was falsified by mt#4035's ingest, and mt#4060 owns restating the posture
corpus-wide.

### The bindings come from the transcript, not a lookup

Resolving a short id the map does not hold cannot be done with a query.
`src/cockpit/short-id-map-cache.ts`'s header records the measurement:
`domain-bootstrap.ts` caps a hook process's Postgres connect at 2s against a
measured cold connect of 4.3–5.5s, so "a DB read from hook context does not
resolve slowly — it resolves to null every time." A resolver built that way
would pass every injected-dependency test and be inert in production.

`collectShortIdBindings` reads the pairing out of `ctx.transcriptLines` instead.
That is free (the transcript is already resolved for this guard) and it is the
AUTHORITATIVE source for the population that matters: an id the map missed is
one minted since the last sweep, and the call that minted it returned both
halves of the binding in the same transcript.

It keys on VALUE SHAPE rather than field names, because the names are inverted
between tools — `memory_create` answers `{ id: <uuid>, shortId: "mem#1045" }`
while `refs_status` answers `{ id: "mem#996", uuid: <uuid> }`. A short id seen
bound to two different UUIDs is dropped rather than guessed.

### Why this needed no ask

It retires no class and changes no posture — `bare-short-id` stays LIVE and
still fires on 20 of the 43 lifetime fires. It narrows the matcher, which is the
same move mt#3960 made on this same class, where the standing was recorded as
"needs no operator decision, because it changes no CLASS." Retiring
`bare-short-id` outright remains an operator decision.

Failure is fail-open in both directions: no candidate, no bindings, or an
ambiguous binding all leave the finding flagged — today's behavior, and the
direction ADR-024's "fail to Rung-1, never silent-skip" requires.

## The advisory is chain-capped (mt#3860, mt#3937)

The remedy message this guard injects is itself a closing message, so the guard
can fire on text it caused — 42% of measured fires were exactly that. The
advisory is capped at one follow-up: a second consecutive Stop-continuation
records but stays silent, and the last advisory before that silence says so
(mt#3937).

## Covers / Does NOT cover

**Covers:** a closing message carrying a bare short id the display map cannot resolve; a
`minsky://` target that is malformed; a raw UUID used as the human-readable label.

**Does NOT cover:** a link that is present, well-formed, and points at the WRONG entity — nothing
downstream repairs that either, and no matcher can decide it. Whether the floor was met across the
whole turn rather than in the closing message alone is also out of reach: the scan sees one
message.

## Override

`MINSKY_ACK_BARE_ENTITY_REF`.

## Cross-references

`.minsky/rules/hook-observers.mdc` (the index entry) ·
`.minsky/rules/cockpit-deeplinks.mdc` (the authoring rule this enforces) ·
mt#3286 (origin) · mt#3897 / mt#3960 (class posture) · mt#3914 (the short-id
map) · mt#3947 (fire data for the retirement decision) · mt#3860 / mt#3937
(chain cap) · mt#2565 (the display linkifier whose complement this is).
