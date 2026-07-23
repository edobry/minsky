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

## Missing MCP tool — full incident list

Origins: mt#1983, shipped via mt#1988; memories `3408717a` (bridge), `b30bfabe`, `39701a9a`,
`7f67af43`; siblings mt#1196/mt#1197/mt#1989.

## Agent todos vs. Minsky tasks — worked examples

The position paper [_Agent todos vs. Minsky tasks_](https://www.notion.so/35e937f03cb4812e9734f0c0f9a8b26c)
carries worked examples plus the Shape A/B/C frame (first instance mt#1316; Shape-C follow-up
mt#1797).

## Cross-references (full index)

`humility.mdc` (the design principle this corpus operationalizes); `operational-safety-dry-run-first.mdc`;
`work-completion.mdc §Temporary mechanism budget`; mt#1034 / mt#1035; mt#2755; mt#1508
(originating audit); `/declare-framework` (mt#1789); `/restate-plan` (mt#1784). Per-section
origins are cited inline in the rule.
