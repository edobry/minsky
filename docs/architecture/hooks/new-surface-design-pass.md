# `new-surface-design-pass` — did anyone JUDGE the surface, not just photograph it

**Task:** mt#4124 · **Seam:** `PreToolUse` on `mcp__minsky__session_pr_create` ·
**Posture:** calibration-first, recorder-only · **Override:** `MINSKY_SKIP_NEW_SURFACE_DESIGN_PASS=1`

## The gap this closes

mt#2421 added the render-path surface to the execution-evidence gate so that a PR changing
something whose purpose is to be LOOKED AT hands the principal something to look at. It checks the
PR body for a URL or an image.

That check cannot distinguish two different things:

| Proposition                                         | Does artifact-presence discriminate?                         |
| --------------------------------------------------- | ------------------------------------------------------------ |
| "I produced an artifact"                            | **Yes** — stripping every URL and image from a body flips it |
| "I looked at this surface and judged it acceptable" | **No** — same answer either way                              |

Per mem#704, a probe that returns the same result whether or not the thing is true carries no
information. On the judgment axis, artifact-presence is that probe. This guard asks the other half.

Note the per-proposition nuance: mt#2421's check is not useless, and this does not replace it. It is
accurate about the proposition it tests and silent on the one the pipeline was reading it as
answering.

## The incident

**mt#3694 / PR #2942 (2026-08-13)** shipped the cockpit side peek. It:

- produced two browser screenshots of the running surface,
- served the branch and asserted `/api/health` identity so the right build was under test,
- wrote a step-by-step reproduce recipe into the PR body,
- and caught a real visual defect that way (a pane titled with 36 characters of raw UUID).

The gate was satisfied — replayed at planning time against the real 12,562-byte body and real file
list: `applicable: true`, `hasArtifact: true`, no warning emitted.

The pane still shipped with zero padding, page-scale typography in a ~416px column, and a card
border plus a second scrollbar nested inside the pane's own scroller. The principal reported it on
sight: _"its p obviously bad, for instance, there's no padding."_ Fixed by mt#4123.

### Why the artifact was produced and the judgment was not

The screenshots were examined **against a checklist of the spec's criteria**, and the spec's only
aesthetic criterion was conformance-shaped — "uses the semantic token layer and the dark-first
elevation convention" — which is satisfiable by reading class names. A checklist-driven look at a
badly-styled pane returns PASS on every item.

That is also why the raw-UUID title WAS caught and the padding was not: the UUID collided with a
criterion being held (the readable-label convention); the padding collided with nothing.

## Why the discriminator is skill invocation

The obvious fix — "add a looks-good criterion to the spec" — fails for a structural reason. The
agent authoring the spec is the agent verifying it, in the same session, and will author an equally
weak criterion. Per mem#736, self-authorship is an **aggravating** factor, not a mitigating one. A
criterion-tier fix has exactly the problem the criterion had.

**The discriminator has to be something the agent cannot satisfy by writing prose about itself.**

`/impeccable` and `/cockpit-design` both exist, are correctly scoped to this work (visual hierarchy,
spacing, typography, density), and neither was invoked at any point across the entire feature. That
was established empirically at planning time, not assumed: extracting every `Skill` tool_use from
the authoring conversation `93e98f39-ab98-47e5-b04b-82b17165f3ad` yields `plan-task` x2,
`implement-task`, `retrospective`, `handoff` — no design skill of any kind.

This mirrors the discriminator the corpus already trusts elsewhere ("was this symbol read this
turn?") rather than asking the agent to self-report diligence.

**The content was already correct; only the invocation was missing.** `/cockpit-design`'s
"Verifying a render change, and handing it over (mt#2421)" section already prescribes exercising the
surface as a user, capturing the FULL uncropped render at ≥1440×900, and presenting it without an
aesthetic verdict. Coverage was not the failing variable — which is the meta-pattern mt#4124's
`## Context` records, observed twice in one day across two unrelated families.

## What fires

A branch **ADDS** a render-path file (git status `A`) **and** no design skill ran in the authoring
conversation.

- **Render-path classification** is `isRenderPathFile` from `render-path-evidence.ts`, reused rather
  than re-derived: `src/cockpit/web/**/*.tsx` and `cockpit-tray/**/*.tsx`, test files excluded.
- **Design skills** are a fixed enumeration: `impeccable`, `cockpit-design`, `frontend-design`,
  `interface-design`, `web-design-guidelines`, `product-thinking`. A skill added to the tree later
  does not silently join — joining is a decision about what counts as design review, not a naming
  coincidence.
- **Skill names** are normalized for the three spellings the harness accepts: bare, `/`-prefixed,
  and `plugin:skill`. The TOOL name goes through the shared `normalizeToolName` from
  `evidence-provenance-table.ts` rather than a second local normalizer.

### Why ADDED-only

Skill invocation unqualified is too blunt: a one-line CSS tweak on a render path should not demand a
design pass. `git diff --name-status main...HEAD` yields A/M status, so "adds a new user-facing
surface" is decidable without a semantic guess, and an edit is `M` and never fires.

A **rename** (`R`) is deliberately not counted. Relocating an existing component is not designing a
new surface, and counting it would fire on every refactor that moves a file.

PR #2942 added `PeekBody.tsx`, `PeekHost.tsx` and `ui/sheet.tsx`, so the worked example survives the
narrowing — which is the point of choosing it.

## The second trigger, and why the first one was not enough (mt#4356)

The original module fired only on an **ADDED** render-path file, deliberately: a one-line tweak to
an existing component should not demand a design pass, and `A` vs `M` decides that without a
semantic guess.

**That proxy missed the largest class of design work — changing how an existing surface looks.**
mt#4251's whole deliverable was a visual treatment across five controls; it modified two
render-path files and added none, so this module could not fire, and the principal reported the
appearance of the merged result. That is the SECOND instance of the exact failure this module
exists to prevent (R1 mem#1026 / mt#3694; R2 mem#1156 / mt#4251) — a recurrence after the fix
shipped DONE, which makes it a containment gap rather than a diligence one. The whole cockpit
redesign sequence — mt#4220, mt#4250, mt#4251, mt#4348 — is `M`-only and purely visual, and every
one of them was invisible to the detector built for it.

So there are two triggers now:

1. **`added-surface`** — the branch ADDS a render-path file. Unchanged.
2. **`modified-surface-visual-spec`** — the branch MODIFIES one AND the bound task's spec declares
   the change is visually judged (`SPEC_VISUAL_PHRASES`: screenshot, viewport, "for the principal
   to judge", "aesthetic acceptance", …).

Trigger 2's discriminator is the SPEC, not the diff, because the diff cannot answer it: a one-line
functional fix and a one-line visual retreatment produce identical `M` status and similar hunks,
and only the spec says which the author was making. Trigger 1 is checked first and wins, so the
spec fetch — a CLI round trip — runs only when it can change the answer.

### Measured split

Replayed over three real transcripts (`scripts/replay-new-surface-design-pass.ts`), reading each
PR's real per-file statuses from `gh api` and each bound spec from the `minsky` CLI:

| Verdict                          | Count | PRs                                               |
| -------------------------------- | ----- | ------------------------------------------------- |
| FIRES                            | 3     | #3171 (mt#4251), #3180 (mt#4348), #3086 (mt#4250) |
| NOT-APPLICABLE                   | 6     | #3074, #3085, #3129, #3090, #3098, #3099          |
| UNKNOWN (PR number unresolvable) | 3     | —                                                 |

3 of 9 measured calls fire, and all three are cockpit visual work; the six silent ones are ordinary
non-render PRs. **Both directions are represented** — the discriminator is not firing on
everything, which is the property a widened trigger most needs to demonstrate. UNKNOWN is reported
separately and excluded from the rate rather than counted as a pass.

Note what this corpus does NOT establish: it is nine calls from three transcripts, not a systematic
sample, and it contains no example of a MODIFIED render-path file whose spec is non-visual — the
false-positive case trigger 2 is designed to exclude. That case is covered by fixture
(`new-surface-design-pass.test.ts`, "does NOT fire on the same diff when the spec is not visual")
and remains unmeasured against real PRs. The posture stays log-only; the calibration log is what
supplies the larger sample.

### Harness note worth keeping

The first run of this measurement reported `NOT-APPLICABLE` for both mt#4251 and mt#4348 — a clean
zero that was entirely an artifact. The replay derived the bound task id from the PR **title**, and
`session_pr_create` titles are description-only by convention (the `fix(mt#NNNN):` prefix is added
by the tool afterwards), so the id was always `null`, no spec was ever fetched, and trigger 2 could
never fire. The live guard reads `tool_input.task` and was never affected. The replay now reads the
same param. A measurement harness that cannot reproduce a known positive is not measuring anything,
and its zero is indistinguishable from a clean corpus.

## Why this seam and not the merge gate

The discriminator's input is a `Skill` tool_use in the conversation that **wrote the code**. At merge
time that conversation is not at hand: the merge gate holds only the merging conversation's
`transcript_path`, and reaching the authoring one would need the `pr_author` link
(`minsky_session_links`, mt#3101) plus DB access from a merge gate, which no merge gate performs
today.

At `session_pr_create` the hook's own `transcript_path` IS the authoring conversation.

**Corollary:** the merge-time artifact-presence check in `render-path-evidence.ts` is unchanged.
This is a sibling surface, not a replacement — the two ask different questions at different seams.

## Posture

**Recorder-only, log-only.** The fire rate against real render-path PRs has not been measured, and
the narrowing that makes the check plausible is itself what calibration has to size. Injecting
before that is the mem#719 failure mode: noise that trains the reader to discount the true positives.

Per ADR-024's ladder — which does **not** govern this module (ADR-024 scopes itself to
`UserPromptSubmit` guidance hooks matching trigger phrases in the agent's own output; this is a
PreToolUse seam guard reading a diff and a tool list) but whose cheapest-sufficient-first discipline
is the nearest accepted precedent. The sibling `render-path-evidence.ts` records the same
extend-not-govern relationship for itself.

Registered per **ADR-028 §D7**: a registry entry in `registry-pr-create-guards.ts`, receiving the
dispatcher-resolved transcript as a parameter rather than re-deriving it. Not a standalone
`PreToolUse` hook.

## The absent-transcript case

**A run with no transcript records `skipped`, never `matched`.**

This guard's entire discriminator is session state, so with no session state there is no finding to
report. "I could not look" is not "it did not happen" — recording a fire there would flag every
transcript-less invocation, which is precisely the unmatchable output that erodes trust in a
detector's correct output.

`needsTranscript: true` is load-bearing on the registration for the same reason: `ctx.transcriptLines`
is populated ONLY for a registration that declares it (ADR-028 D6). Without it the guard would record
`skipped` on every live run — present, tested, green, and inert.

Every evaluation is recorded, fired or not, so the MISS rate is measurable rather than only the fire
count. A fire-only log cannot support a rung decision.

## Cross-references

- **mt#4124** — this guard · **mt#2421** — the mechanism whose containment this repairs
- **mt#4123** — the styling defect that got through · **mt#3694 / PR #2942** — the incident
- **mt#2386** — the rule-tier sibling, `humility.mdc §Stakes filter → Subjective quality is not
yours to certify`. It governs what an agent may ASSERT about a finished render; this governs
  whether design guidance was consulted while BUILDING it. They do not overlap: PR #2942 already
  complied with that rule's substance and shipped the defect anyway.
- **mem#704** — a probe that cannot fail carries no information · **mem#736** — self-authorship
  aggravates · **mem#719** — why a noisy detector costs its own true positives
- `.minsky/hooks/render-path-evidence.ts` · `.minsky/hooks/evidence-provenance-table.ts`
