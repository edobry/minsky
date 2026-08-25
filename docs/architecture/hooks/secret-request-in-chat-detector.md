# secret-request-in-chat-detector

**Task:** mt#2428 · **Event:** `UserPromptSubmit` · **Posture:** calibration-first, log-only
(`INJECTION_ENABLED = false`) · **Override:** `MINSKY_SKIP_SECRET_REQUEST_IN_CHAT`

Fires when the assistant asks the principal to hand over a secret **through the conversation** —
"paste your bot token here", "give me the API key". The chat transcript is persisted to disk AND
ingested into the transcripts DB, so a pasted secret becomes durable, searchable, embedded stored
data. Retracting the message does not unsend it.

The correct surface is **`credentials.request`** (mt#4030): it names a provider plus a reason and
has no field that can carry a value. The advisory names that one surface and explicitly forbids
`config.credentials.add` over MCP, which takes a `token` parameter — an agent calling it writes the
secret into its own tool-call input, and the masking there is CLI-only.

## Why the false-positive class is the design

ADR-024 §Context records that this family "over-fires on quotes/discussion of the trigger phrases
themselves, which is exactly the content the detectors' own subject matter generates." For this
detector that is not an edge case — it is the dominant class. Minsky's corpus discusses
asking-for-secrets at length: in rules, specs, memories, handoffs, and in this very page.

Measured on the inherited patterns before the carve, over
`.minsky/operator-deferral-calibration.jsonl`: **five fires in sixteen days, zero true positives.**

| Date          | Phrase                 | What it actually was                                        |
| ------------- | ---------------------- | ----------------------------------------------------------- |
| 2026-08-10 ×2 | `paste the token`      | The agent REFUSING — "Don't paste the token into this chat" |
| 2026-08-08 ×2 | `paste a bearer token` | A PR summary naming what a security fix was about           |
| 2026-08-24    | `paste a secret`       | The handoff sentence announcing mt#2428 itself              |

The last one is the shape to keep in mind: **a detector for secret-request prose lives inside a
corpus that discusses secret-request prose.** The sentence that tripped it was the task's own
announcement.

## Suppressions, and why they are split the way they are

Governed by **mt#3987** (DONE), which decided the family's discussion-framing question: build no
new shared mechanism, reuse the existing helper, and keep a detector's non-quotation causes its
own.

1. **Quoted / code / blockquote spans** — the shared `elideQuotedAndCodeContexts`
   (`.minsky/hooks/elision.ts`), applied by the adapter before matching. Not reimplemented.
2. **Negation** — "Don't paste the token into this chat". The agent refusing to receive a secret
   is the security-correct behaviour; firing on it would advise degrading the very thing it fired
   on. Shape borrowed from the sibling's proven `NEGATION_LEAD_PATTERN`.
3. **Describes-rather-than-requests** — prose ABOUT a secret request. Matched only BEFORE the
   phrase and only within the same sentence, via a third-person attribution ("an agent asking you
   to…") or a describing head noun ("the detector that flags…"). This is the one
   `elideQuotedAndCodeContexts` cannot reach: the 2026-08-24 record carries no code span, no
   fence, no blockquote and no double quotes.

**`isDetectorMetaDiscussion` is deliberately NOT imported.** Its own docblock says so: it is
whole-turn suppression tuned to `retrospective-trigger-scanner`'s subject matter, and whole-turn
bluntness inverts here.

### Known miss, accepted

A real request phrased in the third person about the speaker — "the agent is asking you to paste
the token" — is suppressed. Accepted for a log-only v1, pinned by a test so it stays a decision
rather than a belief, and re-measured at the first calibration review.

## The carve against operator-deferral

Both detectors match the same words; the harms do not, and their remedies are opposed —
operator-deferral says _go check, you can probably do it yourself_, this one says _never receive
that value at all_. Separate detectors keep the two separately measurable instead of forcing a
rater to disambiguate intent per row.

The split is by **verb class plus recipient**, and the sibling's tests are what forced that shape:
deleting its credential pattern outright regressed mt#3865's and mt#4111's negation controls,
which are real deferrals that happen to say "provide the token".

| Shape                                                                          | Owner             |
| ------------------------------------------------------------------------------ | ----------------- |
| DEPOSIT verbs — paste / enter / type / post / drop                             | this detector     |
| GENERIC verbs WITH a recipient — "give **me** the token", "share **your** key" | this detector     |
| GENERIC verb, bare `the`, no recipient — "until you provide the token"         | operator-deferral |
| Capability claim — "requires a Railway token"                                  | operator-deferral |

Records that changed hands when the carve landed, measured by replaying one snapshot through both
trees rather than asserted: exactly three, all `paste`
(`2026-08-24T01:31:48`, `2026-08-10T10:32:24`, `2026-08-10T10:35:40`). Nothing else moved.

**Do not re-add the moved patterns to either detector.** Both sides carry carve-boundary tests
that fail loudly if you do — re-adding means one sentence fires twice and double-counts across two
calibration logs.

## Surfaces

Two, both read from the completed turn at `UserPromptSubmit`:

- **Assistant prose** — elided before matching.
- **`AskUserQuestion` option labels** — NOT elided. Quote _characters_ are stripped so a decorated
  label still matches, but no span is blanked: a label is the agent's own structured proposal, so
  it cannot be quoting a request. Getting this backwards deletes signal in one direction or the
  other; the sibling's mt#3273 audit found the false-negative half of it.

The sibling registers its label surface on `PreToolUse` so it _could_ deny the ask. This one does
not, deliberately: at `INJECTION_ENABLED = false` the hook denies nothing, so pre-tool placement
buys zero coverage while adding a second event's failure modes. Revisit at the injection flip.

## Review threshold

Per ADR-024's coverage-receipt gate this detector is not "done" until its calibration log shows a
live true positive within 7 days of ship. It may well show none — the population may be empty:
mt#4030 gave the agent a correct channel and the always-loaded rule states the prohibition every
turn, which is plausibly why the inherited patterns produced nothing real.

**Zero fires in 14 days means asking whether the residue is a real population — NOT loosening the
predicate.** That is mt#4111's standing reading for a silent surface on this same detector family,
and it applies here directly.

Both `renderWorstCase` axes (match count, surface count) are uncapped, so the registry's
`attentionCost` is a saturated sample rather than a proved ceiling. An `…and N more` cap is owed
before injection is ever enabled — and that flip is an operator decision (mt#3769).

## Files

- `packages/domain/src/detectors/secret-request-in-chat.ts` — the matcher
- `.minsky/hooks/secret-request-in-chat-detector.ts` — the adapter
- `.minsky/hooks/registry-prompt-scan-guards.ts` — registration + canary
- `.minsky/operator-deferral-calibration.jsonl` — where the pre-carve evidence lives
- `scripts/replay-operator-deferral-calibration.ts` — the replay used to measure the carve
