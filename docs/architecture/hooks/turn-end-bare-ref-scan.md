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

`bare-ref` is record-only because mt#2565's display linkifier repairs those refs
at display time; 13 of 13 injected warnings for the class were measured false.

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
