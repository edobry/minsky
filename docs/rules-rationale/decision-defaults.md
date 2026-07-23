# Decision Defaults — extended rationale

> Extracted from `.minsky/rules/decision-defaults.mdc` (mt#3052 corpus trim). The compiled rule
> corpus carries only the per-turn directive (the Minsky answer, the generic-SE override it
> replaces, and a terse origin pointer); this file holds the fuller self-check detail and the
> consolidated cross-reference index. Nothing here changes agent behavior.

## Build vs buy — biases to watch for in self (full detail)

(1) **Policy-laundering** — citing `§Datastores` to justify building auxiliary analytics on
Postgres; that policy covers source-of-truth state only. The tell: recommending the cheaper
option AND describing it as "principled." Any "per `§X`"-style claim that a rule section covers
the current case is a trigger to re-verify that section's actual scope first — full trigger
enumeration in memory `88d92439`.

(2) **Build-path-as-research at action time** — "use existing signals" / "grep what's already
there" reads as research but is functionally the build path, skipping the user-sequenced
evaluation step; see `feedback_build_path_as_research_at_action_time`.

## Cross-references (full index)

`humility.mdc` (the design principle this corpus operationalizes); `operational-safety-dry-run-first.mdc`;
`work-completion.mdc §Temporary mechanism budget`; mt#1034 / mt#1035; mt#2755; mt#1508
(originating audit); `/declare-framework` (mt#1789); `/restate-plan` (mt#1784). Per-section
origins are cited inline in the rule.
