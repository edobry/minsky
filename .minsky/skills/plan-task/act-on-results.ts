/**
 * Step 4 of /plan-task: act on gate results, plus the reference material that follows it.
 *
 * The pass/fail branches, the three-bucket gap classification, the worked failure examples, the state-transition map, the key constraints, and the regression example. tests/domain/plan-task-halt-citation.test.ts asserts against the halt-condition list this fragment carries.
 *
 * Extracted from skill.ts by mt#4698. The compiled
 * .claude/skills/plan-task/SKILL.md is byte-identical across the split — the fragments are
 * concatenated back in source order, so this is a source-layout change only.
 */
export const ACT_ON_RESULTS = `### Step 4: Act on gate results

**Output altitude (both branches).** Chat carries a plain-language account for the principal;
the **task record** carries the structured detail (premise-audit answers, per-criterion
verdicts, gap report). Never inline the structured half in chat — write it to the spec via
\`mcp__minsky__tasks_spec_patch\` and emit a \`minsky://task/mt%23<id>\` deeplink so the
principal can open it if they want. Chat is brief plain-language prose (1-3 sentences —
fewer on a clean pass, more on a fail) covering what the task is trying to do, what the
investigation found, and what happens next — with NO gate letters, premise-audit labels, or
criterion tables in the message. Each branch below specifies its own sentence count within
that range. Per \`user-preferences.mdc §Plain-language first
in chat reports\` (mt#2801) and \`communication-contract.mdc §The Tier-1 turn-report contract\`
("detail lives behind a pointer, never inline"; originating incident mt#3369 R5+: a 599-word
gate-failure report that duplicated content already written into the spec). This changes
DESTINATION, not rigor — every premise-audit answer and criterion verdict is still produced in
full; it lives in the spec instead of the chat scrollback.

**Chat is a terminal, not GitHub — emit no raw HTML.** The paragraph above sets the
destination; this one bounds the FORM chat may take. Chat is rendered as GitHub-flavored
markdown by a terminal renderer that does NOT execute HTML: a \`<details>\`/\`<summary>\` block
does not collapse, it prints its own tags as literal text directly above the content it was
meant to hide. So a collapsible cannot be used to smuggle the structured half back into chat —
it is not a pointer, it is the detail plus two visible tags. The same renderer means the same
failure for every other HTML affordance, so the prohibition covers them too (\`<br>\`,
\`<sub>\`, inline \`<table>\`). PR bodies and Notion pages are a different surface, where
\`<details>\` does work and stays available. Incident: mt#3371 (19 collapsibles across 12
conversations, all of them this skill's gate reports).

**All gate criteria pass:**

1. Write the full premise-audit answers and per-criterion verdicts to the task spec via
   \`mcp__minsky__tasks_spec_patch\` — append a \`## Planning Audit (READY)\` section carrying
   the checklist. This is the audit trail; chat does not carry it.
2. Report in plain language in chat: 1-2 sentences on what was checked and why the task is
   ready, plus a \`minsky://task/mt%23<id>\` deeplink so the principal can open the recorded
   audit if they want. No criterion dump inline, no gate letters.
3. Call \`mcp__minsky__tasks_status_set\` to transition the task to **READY**.

   **state-ops kind — no-session walk (mt#455).** For \`kind: "state-ops"\` tasks, SKIP
   item 4 below (the \`/implement-task\` chain-walk) entirely — state-ops work runs WITHOUT a session
   (\`session_start\` refuses the kind). Instead, walk the task in main-agent context:
   (i) \`tasks_status_set\` READY → IN-PROGRESS (a legal direct transition for this kind);
   (ii) do the investigation / state operation; (iii) record the deliverable in the spec
   via \`tasks_spec_patch\` under \`## Findings\`, \`## Outcome\`, or \`## Closeout evidence\`;
   (iv) \`tasks_status_set\` → DONE — the transition is refused unless that evidence
   section is populated. Then continue the conversation's next step as usual.

4. **Continue the lifecycle: invoke \`/implement-task mt#X\` directly** (do NOT stop and hand the next-step instruction back to the user). Per CLAUDE.md User Preferences ("Take direct action without asking: When the next step is clear, proceed immediately"), the post-READY default IS implementation. Stopping at READY with "Use \`/implement-task\` to begin" wording is the failure mode this step was rewritten to prevent (originating incident 2026-05-11; prior incident 2026-04-30 captured in memory \`feedback_auto_mode_chains_skills_at_affirmative_tokens\`, id \`4b83ff51-4bc2-49f5-84be-7e4eac073125\`).

   **Only halt before \`/implement-task\` if** one of these explicit halt conditions holds:

   - The user said something during planning that explicitly defers implementation ("don't implement yet", "just plan it", "I'll handle the impl").
   - The READY transition itself surfaced a new blocking signal (e.g., dependency status check failed mid-transition).
   - The task is gated on a principal-owned decision — and you can NAME which reserved category from \`principal-context.mdc §Decisions Eugene reserves\` it falls under.

   **The third condition is a positive citation test, not a judgment call (mt#3596).** Name the
   category out loud before halting on it. The closed list:

   - Naming (product names, customer-facing terms, domain naming that sets precedent, agent
     self-presentation to external parties)
   - Architectural moves that affect customer experience or product surface
   - Authorization for shared / production state changes
   - Scope changes to in-flight work
   - Vendor commitments
   - Framework choices when stakes are principal-level
   - Preferences that set a durable default (the default model, a standing tool or format
     choice). A one-off preference call is the agent's — make it and say what you picked.

   That list is restated here because the halt happens here, but it is a COPY. The canonical
   source is \`principal-context.mdc §Decisions Eugene reserves\` — edit there first; if the two
   ever disagree, that file wins and this copy is the bug.
   \`tests/domain/plan-task-halt-citation.test.ts\` fails on divergence.

   **If you cannot name one, it is not a principal decision and the chain walks.** Do NOT settle the
   question by checking your rationale against the known-bad list below: that list is illustrative,
   and an enumeration of bad reasons is defeated by a novel bad reason — walking it honestly returns
   "not a confabulated halt" for any rationale nobody has thought of yet. Ask positively, against
   the closed list.

   **What a failed citation means — act, do not re-route the same halt.** A rationale that names no
   category is one of three things, none of them a delegation boundary:

   - **Low confidence.** Say so plainly and work more carefully; do not promote a feeling into
     governance. The tell is affective, not logical: the halt follows a failure, an error, or a loss
     of confidence rather than following anything about the work itself (mem#367 §Anti-patterns,
     R5-shape). If the rationale would not have occurred to you before the failure, it is the
     failure talking.
   - **Missing information.** Run the lookup — \`/classify-before-deferring\` exists for exactly this
     classification.
   - **A real decision that is simply yours.** Make it, and say what you decided.

   Only when a category IS nameable does the halt stand — and then it routes through
   \`asks_create\` per the Ask-or-cite-ask paragraph below, never through chat prose.

   **Naming the category is necessary and NOT sufficient — cite the reserving ACT (mt#3855, R6).**
   A reservation needs **principal provenance**, which is exactly one of three things: a quoted
   principal message, an ask response, or the LABEL of an option the principal explicitly selected.
   **Agent-authored artifact text is NOT provenance** — not a spec criterion, not an option's
   description or preview, not a PR body, not a memory. Citing your own prose as a decision record
   is self-citation (\`claim-confidence.mdc §The corpus is agent-authored\`).

   R6 (2026-08-08) is how a halt passes the category test and is still fabricated. The agent wrote
   *"Principal approves the final hero headline before merge"* into the spec itself, shipped its own
   headline anyway, then halted a reviewer-APPROVED, checks-green PR citing that criterion plus
   "naming" — a real category, so mt#3596's test had nothing to catch. The fabrication had moved
   upstream out of the RATIONALE and into the RESERVATION. The principal's answer: *"it was you who
   decided that, i didnt 'keep it for [myself]'. you then made your own choices and went ahead with
   them. did you want my input or not?"*

   **Selecting an option endorses its LABEL, not a side-commitment buried in its preview.** You
   wrote the description and preview text, so a clause riding along inside one is agent-authored no
   matter which option the principal chose. To make it binding, confirm it on its own before
   encoding it as a principal decision.

   **The first condition is a positive citation test too (mt#3855, R8).** Quote the principal's
   words AND name which step the quote defers. Condition 1's own three examples each name the step
   outright — "don't implement yet", "just plan it", "I'll handle the impl". **A request to EXPLAIN
   is not a deferral of the work being explained**: *"Hold on, help me understand the session film
   stuff. What's going on here?"* names no step, so condition 1 does not hold and the chain walks.
   R8 (2026-08-16) quoted precisely that and recast it as "an explicit pause on implementation";
   the principal's next message was *"Why didn't you keep going? Help me understand."* — the same
   shape as R5's *"sorry, what's my decision?"*.

   **A quote must SUPPORT the claim — this binds on both conditions.** R8's quote was genuine and
   still did not say what the citation asserted it said, which is the failure a bare "quote the
   principal" requirement cannot catch. Read the quote back and ask whether it states the thing you
   are about to attribute to it.

   **Worked example — the 2026-08-03 halt (R5).** Asked to proceed on mt#3592, an ordinary
   READY-able TODO with a spec, the agent halted: *"blocked on a principal decision: mt#3592
   re-attempts the change that took production down an hour ago … re-attempting it unprompted is
   your call."* Against the negative enumeration that rationale appears on none of the three lines,
   so the old test returns "not a confabulated halt" and the halt stands — which is what happened,
   until the principal asked *"sorry, what's my decision? I don't understand."* Against the positive
   test: is implementing a planned task **naming**? No. **An architectural move affecting customer
   surface**? No. **Authorization for a shared/production state change**? Nearest, and still no —
   that category governs changing prod state, not writing code that will pass through review, CI and
   a merge gate first. **A scope change**, **a vendor commitment**, **a framework choice**? No, no,
   no. No category is nameable → **NOT a valid halt; the chain walks.** The agent's actual state was
   low confidence after causing an outage, which the first branch above covers. Incident: mem#823;
   family root mem#367 (R5).

   **Counter-example — a valid halt.** "Should this cockpit surface be called Attention or Inbox?"
   → **Naming** (a customer-facing term that sets precedent). The category is nameable, so the halt
   stands and routes through \`asks_create\`. The test is not a bias toward acting; it is a
   requirement that the halt cite something.

   **Confabulated halt rationales** (illustrative, NOT the test — each names no category):

   - "Planning is the skill's scope; implementation is a separate skill."
   - "User might want to review the gate report before I proceed."
   - "The next move is user-driven."
   - "Re-attempting the change that took production down is your call." (R5, 2026-08-03)

   When a brief affirmative ("proceed", "continue", "go", "ok", "yes") arrives at any planning hand-off point, treat it as confirmation to walk the chain forward — NOT as acknowledgment to stop. The bridge memory \`4b83ff51\` covers this verbatim; this step encodes the same discipline structurally so the agent doesn't have to recall the memory at hand-off time.

   **Multi-next-step disambiguation guard (mt#1842).** The chain-walk-on-affirmative discipline above assumes an UNAMBIGUOUS next step. When the just-READY'd task is a child of a parent with multiple unblocked siblings — i.e., walking to \`/implement-task\` on THIS task silently picks one of N possible next moves — invoke \`/disambiguate-next\` BEFORE the chain-walk to \`/implement-task\`. Trigger detection: call \`mcp__minsky__tasks_parent <this-task>\`; if a parent exists, call \`mcp__minsky__tasks_children <parent>\` and count tasks in walkable state (TODO + spec-substantive, READY, IN-PROGRESS). If count ≥ 2, the disambiguation guard fires — surface the option set in user-facing output BEFORE the \`/implement-task\` call. The exception: if the prior agent turn explicitly recommended THIS specific task as next and the user's brief affirmative followed that recommendation, no disambiguation is needed (the recommendation IS the disambiguation). See \`/disambiguate-next\` for the full skill including the stakes-filter sub-check.

   **Tracking task for the structural chaining mechanism:** mt#1478 (Auto-mode skill chaining: /plan-task → /implement-task → /prepare-pr → /merge-coordination walk the chain at gate-passes). When mt#1478's other deliverables ship (implement-task, prepare-pr, merge-coordination SKILL amendments + CLAUDE.md doc section), the chain is fully structural and this paragraph can be retired.

   **Ask-or-cite-ask at closeout (mt#2471).** If a gate criterion surfaced a dependency or
   open question that is gated on a **principal-owned decision** (the spec records it as
   "principal wants further discussion", "resolve before dependent impl", or the gate halted
   on "external decision the user owns"), the closeout MUST route it through the Ask substrate
   — file it via \`mcp__minsky__asks_create\` (kind \`direction.decide\`, packaged per
   \`humility.mdc §Escalation packaging\`, \`parentTaskId\` set) OR cite the id of an existing
   open ask that covers it. Do NOT reference the decision by pointer in chat prose ("the
   rail-axis discussion", "needs your call") and end the turn — chat prose evaporates and never
   reaches the attention surface. This is the planning-closeout enforcement of the
   escalation-packaging family (memory \`3e3f29d8\`; originating recurrences R3 2026-06-09 in
   THIS skill's closeout, R4 2026-06-12). For a NON-principal deferral (a next-step a lookup or
   standing default resolves), use \`/classify-before-deferring\` instead of an ask.

**One or more gate criteria fail:**

1. Do **not** call \`tasks_status_set\` → READY.
2. Task remains in PLANNING.
3. **Write the structured gap report to the task spec** via \`mcp__minsky__tasks_spec_patch\` —
   append a \`## Gap Report (PLANNING — not yet READY)\` section using the template below.
   This is the audit trail; the gap report does NOT go in chat.

\`\`\`
## Gap Report (PLANNING — not yet READY)

### Blocking gaps
- [criterion letter] [agent-actionable | operator-actionable | self-resolving] <description of gap>
- [criterion letter] [agent-actionable | operator-actionable | self-resolving] <description of gap>

### Required actions before READY
1. <concrete action the user or agent must take>
2. <concrete action the user or agent must take>

To re-run the gate after fixes: \`/plan-task <task-id>\`
(The re-run enumerates EVERY required-actions section in the spec, not only this one — see
Step 2 item 6. If you are appending a LATER list, that is fine and expected; do not renumber
this one.)
\`\`\`

   **If gate (o) is one of the failing criteria, ALSO write the falsified banner (mt#4561).**
   A gate-(o) failure means the spec's asserted cause did NOT reproduce — the premise under the
   whole task is dead. Recorded only as gap-report prose, nothing downstream can read it: a
   repo-wide grep for a consumer of \`## Gap Report\` returns zero. The task keeps whatever active
   status it had, and a later agent reads the status as availability while the body says the
   premise is gone. That is the mt#3473 / ask#10163 failure, where a measured-and-killed pilot led
   a principal-facing ask as its top option.

   So EMIT the verdict rather than leaving it to be inferred. Prepend to the spec, **above
   \`## Summary\`** — the position is what the reader lands on and what the check keys off:

\`\`\`
> **PROBLEM STATEMENT FALSIFIED — YYYY-MM-DD.** Gate (o) did not reproduce the cause this spec
> asserts. Evidence: \`## Gap Report (PLANNING — not yet READY)\`. Do not implement or recommend
> this task until the problem statement is re-established.
\`\`\`

   \`PROBLEM STATEMENT FALSIFIED\` is a literal token, defined once in
   \`.minsky/hooks/check-task-spec-read.ts\` as \`FALSIFIED_BANNER_TOKEN\` and matched from there —
   do not paraphrase it, and do not move it below a heading. Its position is load-bearing: the
   check honours the banner ONLY in the top block, which is what keeps a spec that DISCUSSES
   another task's falsification from firing. That leg advises (never denies) when an ask names a
   task whose spec you have read and which carries this banner.

   **Do NOT try to write this banner by inferring a verdict from prose later.** Reading the
   verdict back out was measured over 897 active specs and rejected — a fixed phrase set fires on
   94 with roughly one true positive, and 32 of those name a DIFFERENT task. The banner works
   only because the step that already KNOWS the verdict writes it.

4. **If any blocking gap requires a principal-owned decision** (a scope choice, a naming
   call, a framework selection, an architectural fork the user reserves) — route it through
   \`AskUserQuestion\` (options inline) or \`mcp__minsky__asks_create\`, per
   \`humility.mdc §Escalation packaging\`. Do NOT bury the decision as a bullet inside the
   spec's "Required actions" — chat/spec prose is not the attention surface for a decision
   the user has to make (originating half of the mt#3369 incident: an operator was asked to
   "decide the fix shape" via a prose bullet and replied that they could not see what they
   were deciding between).

5. **Emit a plain-language chat message**: 2-3 sentences naming what the task is trying to
   do, what actually blocks it (in plain words — no gate letters, no premise-audit labels),
   and a \`minsky://task/mt%23<id>\` deeplink to the recorded gap report. If step 4 filed an
   ask, cite the ask id (\`[ask#N](minsky://ask/<uuid>)\`) so the principal knows a decision
   is queued for them.

6. **Classify every blocking gap before you end the turn — the ending depends on it.**
   Each gap is one of THREE kinds, and the gap report records which (the marker in the template
   above):

   - **agent-actionable** — YOU can discharge it, here, in this turn. A stale spec reference, a
     criterion grounded in something that does not exist, an unreconciled overlap with another
     task, a fix-shape call that names no reserved category. **This is the largest bucket and it
     was missing until mt#4694** — see the counter-example below for what its absence costs.
   - **operator-actionable** — a human has to act. **Positive citation required, exactly as a HALT
     requires one** (mt#3596): name which category from \`principal-context.mdc §Decisions Eugene
     reserves\` applies, OR quote the principal's words deferring this specific step. A gap that
     can cite neither is **not** operator-actionable — it is agent-actionable, and the label is
     the only thing standing between you and doing it.
   - **self-resolving** — an external condition clears it on its own, with no operator
     involvement: an open PR merging, a CI run finishing, a deploy completing, a rate-limit
     window resetting. Gate (g) hits are USUALLY this kind, because the usual blocker is
     someone else's in-flight PR.

   **The citation requirement on the middle bucket is load-bearing, not tidiness.** Without it the
   third bucket is optional, and \`operator-actionable\` stays the path of least resistance for
   anything that is merely unresolved — which is exactly how the failure below happened.

   Then:

   - **Every gap self-resolving → do NOT stop. Arm a watcher and say so.** Register the wait on
     the specific unblocking event — \`mcp__minsky__pr_watch_create\` with \`event: "merged"\` for a
     PR (production-enabled since mt#1899), or the mechanism \`work-completion.mdc §External
     self-resolving waits\` names for the others — and close in the shape that rule prescribes:
     "PR #N is what this waits on; I've armed a watch and will re-run the gate when it merges —
     no action needed from you." Handing this wait to the operator is the anti-pattern, and
     ending here with "re-run the gate once #N merges" IS handing it over, however impersonally
     it is phrased.

     **Arm the watch AND a mechanism that re-invokes unconditionally — belt-and-braces, not a
     fallback (mt#4194).** \`pr_watch_create\` does not push. When a watch fires it writes a
     \`wake_pending\` row keyed to the REGISTERING session, and \`enrichWakeResponse\`
     (\`src/mcp/middleware/wake-enrichment.ts\`) drains it only when your next tool call satisfies
     BOTH halves of a conjunction: the tool is on \`WAKE_ENRICHMENT_ALLOWLIST\` — five tools as of
     mt#4194 (\`tasks.get\`, \`pr.watch.list\`, \`tasks.status.get\`, \`session.pr.get\`,
     \`session.pr.list\`), but READ THE CONSTANT rather than this enumeration, which is a snapshot
     and will drift — AND its args carry a \`session\`/\`sessionId\`/\`task\`/\`taskId\` that resolves
     to that session.
     \`/plan-task\` runs in the MAIN workspace with no session bound, where neither half reliably
     holds. This is NOT a claim that the watch is broken — registering and firing work; what is
     conditional is DELIVERY to the conversation that armed it.

     **The pairing is the recommendation rather than a recovery, because the miss is silent.** A
     call outside those five returns before the \`wake.enrichment.no_session_id\` telemetry is
     reached, so an undelivered wake leaves you no signal to notice — there is nothing to fall
     back FROM. So arm both: a backgrounded \`Bash\` poll per \`work-completion.mdc §External
     self-resolving waits\`, or \`session_pr_wait-for-review\` when a session exists. Let the
     closing sentence promise only what the unconditional mechanism delivers — and note that a
     watch is invisible to the principal from the moment it is armed (\`pr_watch_list\` is its
     only reader), so "I've armed a watch" asks them to trust something they cannot see.
   - **Any gap agent-actionable → do NOT stop. Discharge it in THIS turn, then report what you
     did.** This is the same refusal-to-hand-over the self-resolving branch makes, applied to work
     that is yours rather than to a wait that is nobody's. Repair the stale ref, write the missing
     criterion, do the reconciliation, make the call. A gap you can fix and instead describe is the
     \`work-completion.mdc §Never notice an issue without acting on it\` failure, arriving through a
     checklist rather than through prose. If discharging it changes what the task needs, re-run the
     gate on the repaired spec rather than ending on a report about it.
   - **Any gap operator-actionable → the turn ends on the human, as above** — but ONLY once its
     citation holds (see the definition above), and say which kind is which so the principal is not
     left tracking the other two. Discharge the agent-actionable ones and arm the watcher for the
     self-resolving ones BEFORE you end; a turn that stops on one operator gap while leaving three
     of its own undone has handed over a report, not a decision.

   **Why this step exists.** \`work-completion.mdc §External self-resolving waits\` already
   required the watcher, was always-loaded, and lost anyway — because this branch used to end
   "Then stop.", and a skill's terminal step is read AT the decision while an ambient rule is
   not. Originating incident (2026-08-16, mt#4184): a gate-(g)-only failure on open PR #3039
   ended with "once PR #3039 merges, re-running the gate on mt#4183 picks it up"; no watcher was
   armed, and the operator prompted to resume ~80 minutes later with the PR still open. This is a
   recurrence AFTER mt#2956 shipped that rule — see mem#641 R2.

   **Worked counter-example — what the missing third bucket cost (mt#4694, 2026-08-27).** A
   \`/plan-task mt#3831\` run failed its gate on four blocking gaps and labelled every one of them
   \`[operator-actionable]\`. Re-read against what that label asserts:

   | Gap | Labelled | Actually |
   | --- | --- | --- |
   | the proposed fix deviates from ADR-024 | operator-actionable | **agent's** — the same pass had established no reserved category was nameable |
   | unreconciled overlap with a sibling task | operator-actionable | **agent's** — the pass then did half of it unprompted |
   | a criterion grounded in a corpus that does not exist | operator-actionable | **agent's** — a spec repair |
   | a criterion written against a CLOSED task | operator-actionable | **agent's** — fixed in the same turn, by the same pass that labelled it operator-actionable |

   Three of four mislabelled, and the fourth was FIXED by the agent while still carrying the label
   that says a human has to act. The turn then ended per the routing above. The principal prompted
   twice — *"Can we keep going?"*, then *"why did you stop?"*

   **The mislabel was not carelessness, and that is the whole reason this bucket exists.** With
   only two options offered, \`self-resolving\` is plainly wrong for a gap no external event clears,
   so an agent answering honestly picks the nearer of two wrong labels — and \`operator-actionable\`
   routes the turn to the human on its own authority. The step PRODUCED the stop rather than
   permitting it. A second, independent instance is on record in the opposite direction: mt#4506's
   gap report labels a subsume-or-coordinate decision \`[self-resolving]\`, which no external event
   clears either. Two passes, two mislabels, opposite directions, one missing option.

   Note where this sits relative to mt#3596: that task closed the RATIONALE path into an
   unwarranted stop — a halt must now name a reserved category. This closes the LABEL path into the
   same stop, which asserts no category at all and so had nothing for a citation test to catch.

**Example (h) failure.** For a task that renames a config key (e.g., \`sessionDbPath\` →
\`sessiondb.path\`) whose spec says "Sole consumer is \`~/.config/minsky/config.yaml\`":

\`\`\`
## Gap Report for mt#1610 (PLANNING — not yet READY)

### Blocking gaps
- (h) Contract-propagation enumeration: spec claims sole consumer of \`MINSKY_SESSIONDB_*\`
  is \`~/.config/minsky/config.yaml\` but does not enumerate deployed-environment consumers.
  Missing: Railway service env vars (\`MINSKY_SESSIONDB_PATH\`, \`MINSKY_SESSIONDB_AUTH_TOKEN\`
  set on \`minsky-mcp\` Railway service), CI/CD env declarations (\`.github/workflows/\`
  references), and in-tree service configs (\`services/*/railway.config.ts\`).

### Required actions before READY
1. Add the Railway env-var consumers to \`## Scope\` → \`In scope\`:
   "Railway \`minsky-mcp\` service env vars: MINSKY_SESSIONDB_PATH, MINSKY_SESSIONDB_AUTH_TOKEN"
2. State explicitly whether CI/CD workflows or in-tree service configs reference this key
   (or confirm they do not after a verified grep).

To re-run the gate after fixes: \`/plan-task mt#1610\`
\`\`\`

**Example (j) failure.** For a task that amends a spec to label mt#1306 as "source-of-truth state"
without producing the citation-and-mapping protocol:

\`\`\`
## Gap Report for mt#1306 amendment (PLANNING — not yet READY)

### Blocking gaps
- (j) Premise label verification: spec applies the label "source-of-truth state" to mt#1306
  without producing the four-step protocol. The label triggers gate (j) per the trigger list.
  Required: cite \`decision-defaults.mdc §Datastores\`; quote the definition verbatim; map
  mt#1306's properties (derived measurement counts of GitHub-side review data) against the
  criteria ("authoritative product data the system owns"); state verdict.

### Required actions before READY
1. Produce the four-step protocol in the spec or amendment.
2. If the mapping fails, retire the label (and the policy treatment it implied) OR file an
   Ask to confirm whether a different label fits.

To re-run the gate after fixes: \`/plan-task <task-id>\`
\`\`\`

**Example (k) failure.** For a task that recommends adopting \`acme-corp/auto-summarizer\`
(a hypothetical proprietary-licensed GitHub project) as a summarization backend without
running any verification checks:

\`\`\`
## Gap Report for mt#XXXX (PLANNING — not yet READY)

### Blocking gaps
- (k) Third-party tool/dependency verification: spec recommends \`acme-corp/auto-summarizer\`
  but no verification checks were run. License check via \`gh api repos/acme-corp/auto-summarizer\`
  returns \`spdx_id: null, license: {name: "Proprietary"}\`. Minsky is commercial; this license
  is incompatible. Maintenance check: \`archived: false\`, but \`created_at == pushed_at\`
  (2024-11-03) and \`stargazers_count: 2\` — single-day abandoned project heuristic fires.
  Install path: \`pip install auto-summarizer\` returns HTTP 404 from PyPI — package does not
  exist in the registry. Canonical URL: spec links \`github.com/acme-corp/auto-summarizer\`;
  upstream README references \`acme-corp/summarizer-v2\` which returns 404 — URL mismatch.
  All four sub-checks block.

### Required actions before READY
1. Abandon \`acme-corp/auto-summarizer\` as a dependency recommendation — license is
   Proprietary (incompatible with Minsky's commercial use) and the project appears abandoned.
2. Research an alternative with a permissive license (MIT, Apache-2.0, BSD-*, ISC) AND
   active maintenance history. Run all four (k) checks before re-submitting.
3. Add \`Third-party dependency: <name>\` evidence block to \`## Context\` with the verified
   license, maintenance signal, install path, and canonical URL for the chosen replacement.

To re-run the gate after fixes: \`/plan-task mt#XXXX\`
\`\`\`

**Example (m) failure.** For a task whose spec cites the \`project_supabase\` memory to justify
a "dedicated direct Postgres connection bypassing Supavisor's transaction pooler" without
producing the four-step citation-and-mapping protocol:

\`\`\`
## Gap Report for mt#1852 (PLANNING — not yet READY)

### Blocking gaps
- (m) Factual-claim citation verification: the spec cites \`project_supabase\` to justify a
  substrate choice ("direct connection bypassing the pooler") but produces no verbatim quote +
  mapping. Walking gate (m): the memory names the SESSION POOLER (port 5432, same Supavisor) as
  the LISTEN/NOTIFY-capable alternative — NOT a direct connection bypassing Supavisor. The spec
  collapsed "session vs transaction pool mode" and "pooled vs direct connection" under the
  salient phrase "no LISTEN/NOTIFY." Verdict: claim NOT supported.

### Required actions before READY
1. Produce the four-step protocol: verbatim-quote \`project_supabase\`, map the substrate choice
   to the quote, enumerate the quote's scope conditions and state whether each holds, then state
   the verdict.
2. Re-frame the substrate decision to match the source (session-pool mode on the same pooler),
   or cite a different source that actually supports the direct-connection bypass.

To re-run the gate after fixes: \`/plan-task mt#1852\`
\`\`\`

**Example (n) failure.** For a task (modeled on mt#2435) that wires a service to post a GitHub
check-run per review, requiring the App's \`checks:write\` permission, without enumerating the
precondition or gating on its provisioning status:

\`\`\`
## Gap Report for mt#XXXX (PLANNING — not yet READY)

### Blocking gaps
- (n) External-system integration provisioning enumeration: spec adds a new
  \`octokit.rest.checks.create\` call requiring the \`checks:write\` App permission, but does not
  enumerate this precondition or state its provisioning status. Cross-checking the App's current
  permission set: \`checks:write\` is NOT currently granted. A separate provisioning task exists
  (mt#2500) but the spec does not link it, and mt#2500 is still TODO — provisioning is not yet
  satisfied.

### Required actions before READY
1. Add an \`## External preconditions\` subsection (or extend \`## Scope\` → \`In scope\`) naming
   \`checks:write\` as a required App permission.
2. Link mt#2500 as the provisioning task, and state explicitly that READY/merge is contingent on
   mt#2500 reaching DONE (verified, not merely linked) before the check-run path is considered
   live-functional.
3. Per \`/implement-task\` §7a/§10, plan for a live \`POST /check-runs\` exercise post-deploy —
   deploy-SUCCESS alone does not verify the permission is actually granted.

To re-run the gate after fixes: \`/plan-task mt#XXXX\`
\`\`\`

## State transition map

| Current status | Action                                           |
| -------------- | ------------------------------------------------ |
| TODO           | → PLANNING (first step), then investigate + gate |
| PLANNING       | Skip transition, investigate + gate              |
| READY          | Report already READY, stop (confirm to re-run)   |
| IN-PROGRESS    | Out of scope for this skill; inform user         |
| IN-REVIEW      | Out of scope for this skill; inform user         |
| DONE           | Out of scope for this skill; inform user         |
| BLOCKED        | Surface blocker, do not transition               |

## Key constraints

- **Never set DONE** — only the merge + post-merge audit flow does that.
- **Never start a session** — that is \`/implement-task\`'s responsibility.
- **Never create the task** — use \`/create-task\` for new tasks.
- **Idempotent transitions** — calling \`tasks_status_set\` → PLANNING when already PLANNING
  is a no-op; the skill handles this by reading status first.
- **Premise audit must precede spec-quality gate check** — READY recommendations, closure
  recommendations, and amendment recommendations are blocked until all four premise-audit
  checks (i)–(iv) have explicit answers in the agent's output.

## Reframe-trigger ergonomics

There is no reliable harness-level intervention that _produces_ a reframe. The harness can
block premature transitions and require audit answers, but it cannot force the agent to
recognize a structural pattern it has not already seen.

The load-bearing prompt-shape that unlocks a reframe is **Socratic premise-interrogation by
the user**: asking "what exactly is this fixing?", "what are the sub-operations?", "is this
the third time we've patched this?" These questions surface assumptions the agent has
silently inherited.

This skill encourages the agent to apply that Socratic shape to itself during the framing
check (iv): decompose the operation being patched, question whether sub-operations are being
conflated, and check whether the cluster of prior fixes points to a structural gap rather
than a series of independent incidents.

The agent should not wait for the user to ask these questions. If the framing check (iv)
produces no structural reframe, the agent should explicitly document why — not silently
pass.

## Regression example

**Example failure (2026-04-27, mt#1357 investigation).** Investigating three child tasks of
a sanitizer-cluster investigation, the agent:

(a) treated parent-investigation correlation as causation without checking what would
resolve the open hypothesis — premise check (i) failure;

(b) anchored on existing scope-calibration architecture when the actual problem was an
output-format issue, not a rigor-calibration issue — categorization check (ii) failure;

(c) inherited a classifier's verdict as truth (skill files matching \`*.md\` therefore being
"docs") — a second categorization check (ii) failure;

(d) skipped the parallel-work check because investigation felt like not-yet-acting — a
parallel-work check (iii) failure.

The user's premise-checking questions surfaced all four errors. The structural fix (this
premise-audit step) would have produced the same answers without that prompting.
`;
