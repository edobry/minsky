# turn-end-bare-ref-scan

> Extracted from `.minsky/rules/hook-observers.mdc` (mt#4032) — full narration, posture history,
> and design rationale for this observer. The compiled rule corpus carries only a terse index
> entry; this file is the durable detail.

Scans the turn's closing message for an entity reference the reader cannot click.

- **Event:** `Stop`
- **Enforcement:** per finding class — see the posture table below. Never denies.
- **Override:** `MINSKY_ACK_BARE_ENTITY_REF=1`
- **Source:** `.minsky/hooks/turn-end-bare-ref-scan.ts` (shell) + `.minsky/hooks/bare-entity-ref-scan.ts`
  (matcher)
- **Task:** mt#3286 (build) · mt#3897 / mt#3960 (the posture swaps) · mt#3860 / mt#3937 (the chain
  cap)

## Why it exists

`cockpit-deeplinks.mdc` sets a FLOOR: link the first mention of an entity in every message where
it appears, and link every pending-decision entity again in the turn's closing message. The floor
exists because a link three messages up is not at hand where the operator acts. Recurrences
mem#623 R3–R6 were all compliant with the rule's one-link-per-entity CEILING and unusable anyway,
which is what a missing floor looks like. This guard is that floor's advisory enforcement,
calibration-first per ADR-024.

## Posture is per finding class, and it tracks the linkifier's COMPLEMENT

mt#2565's display linkifier (`linkify-message-display.md`) repairs some classes at display time.
A warning about a class the display path already fixes is false by construction, so mt#3897
SWAPPED the two bare classes so the flag set tracks what the linkifier does NOT reach:

| Finding class                                | Posture         | Why                                                                    |
| -------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `bare-short-id` (`ask#N` / `mem#N` / `ws#N`) | **LIVE**        | the UUID target is not derivable (ADR-029)                             |
| `malformed-target`                           | **LIVE**        | a link that is present but wrong is not repaired by anything           |
| `raw-uuid-label`                             | **LIVE**        | same                                                                   |
| `bare-ref` (`mt#N` / `PR #N`)                | **RECORD-ONLY** | the linkifier repairs these; 13 of 13 injected warnings measured false |

Both halves were operator decisions, not agent judgment: **ask#7415** enabled the short ids,
**ask#7639** retired the task/PR warnings while keeping the two malformed classes live.

## The complement is COMPUTED per finding, not per class (mt#3960)

mt#3914 shipped a short-id→UUID map, so a MAPPED short id is auto-repaired at display exactly like
`mt#N`, while an UNMAPPED one — minted since the last sweep, or any id at all when no cockpit is
running to refresh the map — still reaches the reader bare. Flagging the whole class would
therefore be wrong in one direction and flagging none of it wrong in the other.

The scan consults the same map the display path reads and flags only what it cannot resolve. A
suppressed finding is recorded as `linkable-short-id`, so a later calibration pass can measure how
much of the class mt#3914 absorbs. **An absent or corrupt map flags everything** (ADR-024
fail-to-Rung-1), never nothing.

This narrowing needed no ask because it retires no class. **Retiring `bare-short-id` outright is
still an operator decision, and mt#3947 holds the fire data for it.** Measured before the
narrowing: 5 of the first 6 injected phrases after mt#3914 named ids the map already held.

## The advisory is chain-capped at one follow-up (mt#3860)

The guard's remedy message is itself a closing message, so the guard can react to text it caused.
Measured: **42% of fires were exactly that.** A second consecutive Stop-continuation records but
stays silent, and mt#3937 made the last advisory before that silence SAY so — an advisory that
goes quiet without warning reads as the guard having been satisfied.

## Covers / Does NOT cover

**Covers:** a closing message carrying a bare short id the display map cannot resolve; a
`minsky://` target that is malformed; a raw UUID used as the human-readable label.

**Does NOT cover:** a link that is present, well-formed, and points at the WRONG entity — nothing
downstream repairs that either, and no matcher can decide it. Whether the floor was met across the
whole turn rather than in the closing message alone is also out of reach: the scan sees one message.

## Cross-references

`.minsky/rules/cockpit-deeplinks.mdc` (the floor this enforces) ·
`docs/rules-rationale/cockpit-deeplinks.md §The one-link-per-entity ration is provisional` ·
`linkify-message-display.md` (the complement) ·
`docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md` ·
`docs/architecture/adr-029-numeric-short-ids-foundation.md` · mem#623 (the family root) ·
mt#3914 (the short-id map) · mt#3947 (the retirement decision's fire data).
