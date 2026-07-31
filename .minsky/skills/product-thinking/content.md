# product-thinking — derive principal-facing surfaces from the supervision loop

You are deciding **what a principal-facing surface should be** — a cockpit page, a widget, a tray
glyph, a vitals card, any surface the principal reads or acts through. This skill is the
product/derivation layer that sits ABOVE `/cockpit-design` (entity conventions, visual patterns) and
`/minsky-brand` (register): those tell you how to render a surface; this one tells you how to decide
what the surface is, derived from the principal's actual workflows instead of dashboard convention.

Invoke it BEFORE sketching, and as the audit frame when reviewing an existing surface. If you are
about to place a table, a card grid, or a filter bar because that's what dashboards have, stop —
that is the valley this skill exists to climb out of.

## When to invoke

- Designing a new cockpit page/widget or any new principal-facing surface
- Auditing an existing surface ("why does this page feel generic?")
- A redesign or product-pass request touching `src/cockpit/web/**`
- Answering "what should this page/widget be?" or "should X be shown here?"
- Reviewing a PR that adds or restructures a principal-facing surface

## Step 0 — the frame (fixed, not re-derived)

Every derivation below happens inside this frame. Do not re-infer it from local signals:

- **One expert operator.** The principal (see `principal-context.mdc`) uses this surface many times
  a day, forever. The comparable is a Bloomberg terminal or a one-person NASA console — NOT a
  multi-tenant SaaS dashboard optimized for first-run friendliness.
- **Attention is the binding constraint.** The entire system exists to conserve principal
  attention (ADR-008, mt#1034). A surface that spends attention to be understood is working
  against the product.
- **The work is a loop, not a set of entities.** The principal's supervision loop:
  **triage → decide → steer → verify**, with investigate / catch-up / curate as slower cycles.
  Entities (tasks, sessions, asks, PRs) are operands of the loop, not the organizing principle.
- **Push is the destination; pull must be excellent meanwhile.** The ambient-cockpit RFC (Notion
  `37a937f0-3cb4-8148-acc2-c9b54c177276`) fixes the orientation: ambient presence → threshold push
  → deliberate pull. Every pull surface you design should also answer "what slice of me becomes a
  pushed signal later?"
- **The founding five** (theory essay, Notion `33a937f0-3cb4-819a-8865-e11164cbb1c8`): show state
  not history; algedonic not comprehensive; support orientation not just observation; recursive
  coherence; executable not decorative. The shipped cockpit drifted from these once already —
  treat them as tests, not aspirations.

## The method (six moves, in order)

### 1. Name the job (Job Story, not persona, not entity)

Write the job the surface serves in Job Story form (Klement/Intercom):
`When [situation], I want to [motivation], so I can [outcome].` The situation is causal — it names
the trigger, which is what the surface must be designed around.

The canonical supervision-loop jobs (extend only with evidence, e.g. transcript/ask history):

| Job                     | Story (compressed)                                                                                                                                  | Frequency / dwell              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Triage**              | When I glance at Minsky, I want to know whether anything needs me, so I can act or get back to my own work                                          | Many×/day, seconds             |
| **Decide**              | When an agent routes a decision, I want it packaged with options + recommendation, so I can answer in one read                                      | Several×/day, 30s–2min         |
| **Supervise**           | When N agents are working, I want to see who is healthy/stuck/silent, so I catch stalls without reading transcripts                                 | Continuous/ambient             |
| **Steer**               | When an agent is off-course or blocked, I want to redirect/kill/answer from where I noticed, so I don't context-switch                              | Few×/day, <1min                |
| **Investigate**         | When something surprising happened, I want to replay what the agent did, so I can diagnose and encode the fix                                       | Few×/week, minutes             |
| **Catch up**            | When I've been away, I want what-changed-since-last-look, so I don't re-scan everything                                                             | Daily                          |
| **Curate**              | When deciding what to fund next, I want streams ranked by state and blockage, so I dispatch the highest-leverage work                               | Weekly-ish                     |
| **Trust the substrate** | When the rails degrade (MCP, reviewer, embeddings, guards), I want it surfaced as an anomaly, so I never discover it via a weird downstream failure | Ambient; loud only when broken |

**Rule: a surface with no named job from this table (or an evidence-backed addition) is
entity-CRUD by default — redesign or demote it.**

### 2. Name the owning question

One question per surface/widget, phrased as the operator would ask it ("what needs me right
now?", "is this stream moving?"). Then apply the **receipt test** (same distinction as
`communication-contract.mdc`): mechanical successes — tests green, credentials configured, uptime,
counts of healthy things — are receipts. Receipts go to the record (detail pages, drill-down,
logs), never the lead surface. A widget whose honest answer is "everything is as expected" earns
one calm line, not a card.

Convergent external evidence: "dashboards are where data goes to die" (Brownlow); the
47-dashboards→"one dashboard, three questions" observability case study. More widgets is the
wrong response to "we missed something" — fewer, owned questions is the fix.

### 3. Decompose the job (lightweight HTA)

For the surface's job, run a 2–3 level Hierarchical Task Analysis: goal → plan (ordering,
conditions) → operations. Two hard rules:

- **P×C stopping rule**: decompose further only where probability-of-error × cost-of-error is
  high (that's where design effort goes).
- **Leaf = affordance**: every leaf operation maps to a concrete, locatable affordance on the
  surface. A leaf with no affordance is a missing feature; an affordance serving no leaf is
  decoration. ("Decide" whose leaves are read-options → weigh → answer, but whose surface only
  offers a link to another page, fails the mapping — the answer affordance belongs where the
  deciding happens.)

### 4. Pick the altitude

Three altitudes; every surface declares one (a page may compose two, labeled):

- **Radiator** (glance, no query): answers its question in peripheral vision / one glance.
  Endsley Level 2–3 support — pre-integrated meaning ("2 need you, 1 stalled"), not raw feeds.
  The home page, the tray, any default view.
- **Console** (triage + act): ranked actionable items with inline actions. The asks inbox, the
  fleet table.
- **Detail** (investigate): full state, replay, forensic depth. Conversation view, task detail,
  activity log.

The ambient-cockpit RFC's mechanisms map onto these: ambient presence = radiator; threshold push
= a radiator item promoted to interrupt; pull = console/detail. History-shaped surfaces
(activity feeds, logs) are detail-altitude by definition — never the default view (founding
principle 1).

### 5. Apply the decision-forcing principles

Ordered — earlier wins on conflict. Each is a ranking a rational person could argue against
(Zhuo's test); each has a real satisfies/violates example from the 2026-07-16 cockpit audit
(mt#2880) so it discriminates (Smashing reality-check).

1. **Needs-me over newest.** Default order is always "what requires the human," recency only
   within a group. _Violates:_ /agents sorted by activity put a blocked old session below fresh
   healthy ones. _Satisfies:_ Claude Code Agent View's needs-input-first grouping.
2. **Anomaly over inventory.** Surface deviations; healthy steady-state collapses to a calm
   line. _Violates:_ home's "Credentials 6/6 configured" card co-equal with a degraded
   embeddings card. _Satisfies:_ plant board's calm-field-at-rest / deviation-breaks-harmony.
3. **State over history.** Lead surfaces show the situation now; chronology is drill-down.
   _Violates:_ activity feed as a triage surface. _Satisfies:_ workstream health chips
   ("stalled 8d" is state; the event list behind it is history).
4. **The loop over the entity.** IA and adjacency follow the supervision loop; entity list
   pages are browse/drill-down, never the spine. _Violates:_ tasks/agents/asks/activity as
   co-equal top-level destinations. _Satisfies:_ rail order attention → workstreams → browse.
5. **Act-here over navigate-away.** The action lives where the noticing happens (inline
   respond, peek panels, optimistic UI + undo). _Violates:_ ask rows that only link to a detail
   page. _Satisfies:_ driven-session composer answering an agent in place.
6. **Blast-radius over action-type.** Gating, labeling, and urgency track damage potential and
   reversibility, not action category or surface size. A small prod-secret change outranks a
   large test refactor. _Violates:_ five identical P2 "commit authorization" asks for one PR.
   _Satisfies:_ an ask stating "approves push to prod config; reversible via rollback."
7. **Glance over query.** If the operator must open, filter, or ask to learn whether anything
   needs them, the default has failed (radiator, not interrogation). _Violates:_ 37 workstreams
   needing expansion to find the stuck one. _Satisfies:_ rail attention badge.
8. **Density over whitespace.** Value ÷ (time + space). Expert daily-loop surfaces reward
   compression — monospace anchors, tabular-nums, compact rows — bounded by Gestalt grouping,
   not by marketing aesthetics. _Violates:_ one-fact cards with card-title chrome.
   _Satisfies:_ `/cockpit-design` density patterns; Bloomberg's no-whitespace stance.
9. **Honest over lively.** No fabricated motion, no fake health: a failed query renders as
   degraded, never as a clean zero; no event → no motion (plant canon's honest-motion law,
   generalized). _Violates:_ a widget whose queries all threw rendering healthy-looking zeros
   (the mt#2076 five-week blind spot). _Satisfies:_ `queryFailureCount` → AnomalyBanner
   convention (mt#2758).
10. **Derived identity over raw internals.** Every label is a derived human-legible name plus
    the canonical anchor (`mt#X`, `PR #N`, short id). Raw prompt text, `unknown:hash:` actor
    ids, and bare UUID hashes are internals — never primary identity. (This sharpens, not
    contradicts, `/cockpit-design`'s "don't abstract entity IDs": anchors stay; the missing
    layer is the human name beside them.) _Violates:_ tab strip of hash prefixes; agent rows
    labeled with leaked `<skill-format>` markup. _Satisfies:_ "plan-task agent · mt#2505".

### 6. Audit before presenting (Do-Confirm)

Trigger: a design/redesign is about to be presented, or a surface-touching PR is under review.
Confirm each; any failure goes back to the corresponding move above.

1. **Job + owning question named?** (moves 1–2; receipts demoted to the record)
2. **SAGAT freeze test passes?** Look at the surface 10 seconds, blank it: can you state what
   needs the operator, fleet health, substrate health — and does that match ground truth?
3. **Tier discipline holds?** ≤3 urgency tiers; top tier ≲5% of items (ISA-18.2 ~5/15/80);
   standing items >24h are themselves a surfaced signal, capped by a budget; flood state
   (>10 new items/10min) collapses to summaries.
4. **No attentional tunnel?** No hero panel so compelling it starves exception detection at the
   periphery (Wickens); the one anomalous thing must win against the most decorated healthy thing.
5. **Leaf↔affordance mapping complete?** (move 3) Every operation reachable; every control
   serving an operation.
6. **Analogy test passed?** If any element's justification is "other tools do it this way,"
   re-derive it from the job or delete it. Precedents (Agent View, agent-inbox, terminals) are
   evidence about the job, not authority.
7. **Uniqueness test passed?** If another agent given the same prompt would produce the same
   surface, the design has failed (`src/cockpit/CLAUDE.md` §No template defaults).

For visual verification mechanics (live cockpit, objective-defect checklist), defer to
`/cockpit-design` Step 0 and memory `67676430` — this skill owns the product judgment, not the
render pipeline.

## Anti-patterns (refuse on sight)

- **Entity-CRUD IA as the spine** — a nav of entity list pages as the primary structure.
- **Recency-sorted default views** on any supervision surface.
- **Receipts on the lead surface** — uptime, versions, configured-counts, all-green summaries.
- **Unbounded standing alarms** — stale items accumulating without a budget or staleness signal.
- **Approval-fatigue queues** — N micro-approvals where one unit-of-work bundle would do;
  approve-as-path-of-least-resistance (one keystroke to approve, essay to reject).
- **Raw internals as identity** — prompt text, hash ids, ascribed-actor strings as labels.
- **Fake vitality** — decorative motion, zeros-instead-of-errors, skeleton theater.
- **New principle as virtue-noun** — additions to §5 must be "X over Y" rankings that pass the
  rational-disagreement test and carry a real satisfies/violates pair; derive them from incident
  evidence (Spool: principles come from documented failures), not values brainstorms.

## Cross-references

- `/cockpit-design` — the entity/visual/density layer below this one; consult after this skill
  has settled what the surface is. `/minsky-brand` — register; `docs/brand-system.md` — tokens.
- Ambient-cockpit RFC (Notion `37a937f0-3cb4-8148-acc2-c9b54c177276`) — push-not-pull orientation
  this skill's altitudes implement; the algedonic filter is its Phase 1 artifact.
- "The cockpit problem" theory essay (Notion `33a937f0-3cb4-819a-8865-e11164cbb1c8`) — the
  founding five principles §Step 0 encodes.
- `communication-contract.mdc` — receipts-vs-judgment-calls, the chat-side sibling of move 2.
- ADR-008 / mt#1034 — attention allocation (the constraint in Step 0); mt#2880 — the cockpit
  product pass that first applied this skill (audit record + worked examples).
- Research digest (2026-07-16, five areas, ~50 sources): claude.ai artifact
  `89d802b5-7294-4ee4-9d25-ca6d0722c94d` — JTBD/job stories, HTA, Endsley/Wickens/ISA-18.2,
  Bloomberg/Linear/Superhuman, Agent View/agent-inbox/approval fatigue, Spool/Zhuo principle
  tests. Cite it rather than re-searching.
