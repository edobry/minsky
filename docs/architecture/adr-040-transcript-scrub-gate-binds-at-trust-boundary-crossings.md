# ADR-040: The transcript scrub gate binds at trust-boundary crossings, not at authenticated reads

**The call: `assertScrubGate` gates transcript content where it LEAVES the operator's trust boundary — a file written to disk, a link handed to an anonymous viewer — and does not gate the operator reading their own stored history behind their own authentication.**

## Status

**Proposed** — 2026-08-13, under mt#3268. The code implementing it ships in the same PR.

Ratification is pending rather than assumed. The posture decides what a deployed cockpit surface
refuses to render, which is an architectural move affecting the product surface per
`principal-context.mdc §Decisions Eugene reserves` — the same reasoning ADR-039 records for the CLI
rendering default. The agent recommended this posture and the principal was told so in the
originating conversation; flip this to **Accepted** on confirmation, or to **Rejected** and take the
opposite branch recorded under "Alternative considered" below, which is a small and mechanical
reversal.

## Context

`assertScrubGate` (`packages/domain/src/transcripts/gource-exporter.ts`) refuses any conversation
ingested before `CREDENTIAL_SCRUB_CUTOFF_ISO` (`2026-07-18T00:00:00.000Z`) unless the caller asserts
`verifiedRescrubbed`. The cutoff is the date the mt#2864 sweep confirmed the stored corpus scrubbed
to residue=0 — that sweep found all four live Minsky-config API keys in plaintext across 35
conversations (mem#634), so the risk it addresses is real and measured, not hypothetical.

The gate was written for ONE caller: `exportGourceLog`, which writes a file. Later surfaces
inherited it by proximity rather than by decision, and by 2026-08-13 the surfaces reading stored
transcripts disagreed with each other:

| Surface                                                                                                    | Gate before this ADR             |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `exportGourceLog` — writes a `.log` file                                                                   | gated                            |
| `POST /api/shares` + `GET /api/shares/public/:token` — renders to an anonymous viewer                      | gated at mint AND read (mt#4024) |
| `GET /api/cockpit/session-film/{events,content}` — renders to the authenticated operator                   | gated                            |
| `GET /api/cockpit/context-inspector/snapshot` → `ConversationView` — renders to the authenticated operator | **ungated**                      |

mt#3268 was filed against the last two rows: the operator could not watch a pre-cutoff session as a
film "because its stored transcript may contain unscrubbed credentials," but could read that same
transcript's raw bytes in the conversation view one route over. Exactly one of those is right and
nobody had recorded which.

The task's original framing distinguished EXPORT (a file that leaves the machine) from LOCAL RENDER
(both cockpit surfaces drawing to the operator's own browser on localhost). **That framing is no
longer accurate**, which is what forced a decision rather than a cleanup. mt#4023 passkey-gated the
`cockpit-preview` Railway deployment — the cockpit is a deployed service reachable over the
internet, not a localhost-only tool. mt#4024 then added `/s/:token`, which renders a stored
conversation to a fully anonymous viewer. "Local render" no longer names a category.

## Decision

**The gate binds on the CROSSING, not on the READ.** A caller must pass `assertScrubGate` when the
transcript's bytes leave the operator's trust boundary:

- **Export** — `exportGourceLog` writes a file that outlives the process and travels.
- **Publish** — minting or serving a share link hands the content to someone who has not
  authenticated.

A caller must NOT gate when the operator is reading their own stored data behind their own
authentication — the film's events and content endpoints, and the context-inspector snapshot.

The reasoning is that the gate conflated two sub-operations with opposite answers. "May this
content leave?" and "may the operator look at their own data?" are different questions, and the
single label "is this transcript scrubbed?" hid the difference. Refusing to show operators their own
credentials, behind their own passkey, protects nobody — and it costs access to every conversation
ingested before the cutoff, which for a tool whose purpose is reading conversations is a large and
permanent loss. Refusing to hand those same bytes to an anonymous share recipient is precisely the
case the gate was written for.

This also promotes mt#4024's shipped behavior from a local choice to the general rule: the publish
path already gated at both mint and read, and it stays exactly as it is.

## Consequences

- **`assertScrubGate` keeps two callers, both crossings.** Its doc comment now names them, so the
  next consumer does not have to grep call sites to learn what the gate is for — and its thrown
  message no longer opens `"Export refused:"`, which was reaching a publish dialog.
- **The film stops carrying a gate it should never have had.** `scrubGateOk`, the picker's disabled
  rows and refusal copy, the `verifiedRescrubbed` query param, and the `unscrubbed` error code all
  go. Pre-cutoff conversations become filmable.
- **The context-inspector snapshot's lack of a gate is now correct by decision rather than by
  omission**, and this ADR is the record a future reader will find if they go looking for why.
- **This gate is a credential floor, not a privacy control — do not mistake it for one.** The
  scrubber matches CREDENTIAL patterns. ADR-025 §Security/access-control names three categories of
  sensitive transcript content — "secrets, tokens, and PII" — and the gate addresses roughly the
  first two and is silent on the third. It says nothing about PII, file contents, or customer data
  an agent read into a transcript. So passing the gate is NOT evidence that publishing a
  conversation is safe; it only means no known credential shape was matched. The real mitigation on
  the publish path is procedural: publishing is an explicit per-conversation act behind a
  confirmation that states what becomes readable (mt#4024).
- **Anyone widening the publish surface re-opens this.** Bulk publishing, a public index, or
  longer-lived links weaken the procedural mitigation the bullet above rests on, and this decision
  does not cover them.
- **The trust boundary is "authenticated," which is currently a set of one.** mt#4023 enrolled the
  operator and flipped `enrollmentOpen` to false. If enrollment reopens to other people, "the
  operator reading their own data" stops describing every authenticated read, and the read half of
  this decision should be re-read. The crossing half is unaffected.

## Alternative considered

**Extend the gate to every read surface**, so the context-inspector snapshot refuses pre-cutoff
conversations the way the film did. This satisfies mt#3268's SC2 equally well and is the more
conservative-looking option. It was rejected because the protection is illusory — it withholds the
operator's own credentials from the operator — while the cost is concrete: every conversation
ingested before 2026-07-18 stops rendering in the cockpit. If this ADR is rejected, this is the
branch to take; the reversal is mechanical.

## Cross-references

- `docs/architecture/adr-025-transcript-storage-object-store-system-of-record.md` — the content-risk
  premise this extends from storage to read surfaces.
- mt#3268 (this decision) · mt#3262 (discovered the asymmetry) · mt#4023 (passkey gate) ·
  mt#4024 (share links) · mt#2763 / mt#2864 (the scrubber and the sweep that set the cutoff).
- mt#3850 (PLANNING) — live secrets still reaching transcripts via `ps` output. Upstream of this
  gate: it is about what ENTERS the corpus, where this ADR is about what leaves it.
- mem#634 — the mt#2864 triage that measured the leak this cutoff responds to.
