---
name: analyze-adjacent-product
description: >-
  Produce a Minsky landscape-alignment analysis of an adjacent or competitive
  product, published as a Notion analysis page under the Minsky home. Use when
  comparing a third-party product to Minsky's architecture, surfaces, or
  positioning — to identify validation, gaps, and adjacency rather than to
  declare a winner.
user-invocable: true
---

# Analyze an adjacent product

Concise authoring path for a landscape-alignment analysis comparing a third-party product to Minsky. Output is a Notion page under the Minsky home, following the established `Analysis: ... — ... (<month> <year>)` pattern (LangGraph, Graphify, 6 Plugins, Second Brain, Pyramid of Success, Agent SDK landscape).

## Arguments

Required: the product being analyzed. A short phrase or URL (e.g., `/analyze-adjacent-product macro.com`, `/analyze-adjacent-product factory.ai`, `/analyze-adjacent-product LangGraph`).

## When to use this skill vs alternatives

- **Use `/analyze-adjacent-product`** when: a third-party product (competitor, adjacent product, framework, platform) is in scope and you want a Minsky-grounded comparison — overlaps, gaps, validation, divergence.
- **Use `/draft-rfc`** instead when: the output is a _proposal_ (build/buy/adopt) rather than a landscape map. RFCs argue for a direction; analyses describe the terrain.
- **Use `/draft-adr`** instead when: a specific architectural decision is being recorded (e.g., "we will adopt AG-UI"). ADRs follow from analyses; they aren't analyses themselves.
- **Use `/incident-memo`** instead when: the trigger is something that happened to Minsky, not something that exists in the market.

See `documentation-taxonomy.mdc §The eight categories` for the full taxonomy. Analysis pages belong to the "Architecture reference" / "Vision / Insight / Field notes" cluster — Notion-hosted, no formal lifecycle status, dated.

## Research discipline — PRIMARY sources only

**Default research path: load the product's live site through Chrome devtools** (`mcp__chrome-devtools__new_page` + `take_snapshot`). Most AI-product sites are JavaScript-rendered; WebFetch returns a near-empty DOM and forces you to fall back to review aggregators (capterra, futuretools, automateed). Those aggregators are routinely 6–18 months stale, especially for products that have pivoted. A confident-but-wrong "no overlap" verdict is the failure mode this discipline prevents.

Sequence:

1. **Live site via Chrome devtools** — homepage, /pricing, /docs, /blog, any "what we learned from X" or manifesto posts. Snapshot the a11y tree (richer than screenshots for text content); screenshot when visual layout matters.
2. **GitHub org** if the product has one — README, top-level package structure, recent commits. Architectural overlap shows up here.
3. **Founder / company primary sources** — X/Twitter, podcast appearances, funding announcements. Date everything; signals older than ~6 months get a confidence discount.
4. **Aggregators / review sites — last resort, with explicit staleness caveat.** If you fall back to these, state it inline: "Aggregator data dated <month>; no primary 2026 source found."

If primary sources don't exist for the question you're trying to answer, say so in the analysis — don't fabricate or extrapolate.

## Process

### 1. Search Notion + memory for existing mentions

Before writing anything new:

- `mcp__plugin_Notion_notion__notion-search` for the product name, its category, and adjacent products. Search the Minsky workspace (`query_type: "internal"`).
- `mcp__minsky__memory_search` for the same.
- Read sibling landscape docs for tone and depth precedent. Current examples:
  - [Analysis: LangGraph × Claude Agent SDK × Minsky](https://www.notion.so/340937f03cb481c8b4d1ca8bfcbcd67e)
  - [Analysis: Agent SDK landscape](https://www.notion.so/348937f03cb48161a31fe344ada6fb28)
  - [Analysis: 6 Claude Code Plugins](https://www.notion.so/341937f03cb4811f93ace3c2dc98eb12)
  - [Analysis: Graphify](https://www.notion.so/341937f03cb48123869ee5583a420db5)
  - [Analysis: Second Brain with Claude Code v2.0](https://www.notion.so/341937f03cb481e3aa56e2f72ec37ae3)

If the product already has an analysis page, decide: extend (date-stamped revision section) vs. file a new dated page (when the product has materially changed). Pivots warrant a new page.

### 2. Research the product via primary sources

Apply the discipline above. Capture quotes verbatim where the framing is distinctive — the analysis is more credible when claims are pinned to landing-page wording.

### 3. Map to Minsky strategic concepts

Before writing the comparison, name the Minsky concepts the product touches:

- **Cockpit** — mission-control UI for the operator
- **Mesh** — multi-agent coordination substrate
- **Asks subsystem** (mt#1034) — taxonomy of asks, attention routing
- **Attention-allocation subsystem** — System 3\* meta-cognitive detector
- **Memory subsystem** — durable knowledge store with similarity search
- **Task / session lifecycle** — the orchestration spine
- **Subagent dispatch** — the inner-loop work primitive
- **MCP server / hosted MCP** — the protocol surface
- **Skills / rules / subagents spectrum** — the structural-strength gradient
- **Persistence-provider architecture** (ADR-002) — capability-based pluggable backends
- **Forgebackend subinterfaces** (ADR-005) — Git-forge abstraction
- **In-band review semantics** (ADR-009) — reviewer subagent as load-bearing gate

Per `principal-context.mdc`, name the **framework** you're evaluating under — commercial-product-workflow-fit, not OSS-purity or lock-in-minimization. Don't import generic-SE frameworks (per `decision-defaults.mdc §Build vs buy`).

### 4. Draft the analysis

File the Notion page under the Minsky home (`33a937f0-3cb4-8197-a93e-cd4a98a94261`). Use this title pattern:

```
Analysis: <product>[ × <product>] × Minsky — <descriptor> (<month> <year>)
```

Or, for single-product depth:

```
Analysis: <product> — <descriptor> & Minsky relevance (<month> <year>)
```

Use this skeleton:

```markdown
<Date>. <One-paragraph framing: what triggered this, what the product is, what the analysis covers.>

---

## Source material

<Primary sources with URLs and dates. Note explicitly if you fell back to aggregators, and date them.>

---

## What the product is

<2-3 paragraphs in your own words: category, surfaces, ICP, distinguishing claims. Use direct quotes from the live site for distinctive framing.>

---

## Overlap with Minsky

### What directly validates Minsky

<Surfaces / claims that mirror Minsky's thesis or design. Cite the matching Minsky concept by name.>

### Where Minsky is ahead

<Surfaces Minsky has that the product doesn't, with Minsky-internal links/concepts.>

### Where Minsky is behind / gaps the product exposes

<Surfaces the product has that Minsky doesn't. This section is where the analysis earns its keep — be specific.>

---

## What's NOT relevant

<Product features or framings that look like overlap but aren't. Filters out noise from the adjacency surface.>

---

## Action items for investigation

<Numbered investigation paths. Each names a question, why it matters, what to investigate, and connects to existing Minsky concepts. Mark prospective Minsky tasks with a tag like:>

> 🏷️ _Future Minsky task: <short task title>_

---

## Cross-references

- Sibling analyses: [...]
- Related RFCs / ADRs: [...]
- Related tasks: mt#NNNN
- Memory entries: <ids>
```

Keep prose tight. The "Where Minsky is behind" section is where most analyses are weak; spend the most time there. Avoid the temptation to declare a winner — analyses describe terrain, they don't pick teams.

### 5. Decide on follow-up artifacts

After publishing the page, evaluate which of these are warranted:

- **A Minsky task** for each investigation path you tagged. File via `mcp__minsky__tasks_create` with the analysis page URL as the spec's source.
- **A memory entry** if the analysis surfaced a durable pattern (e.g., "products in category X consistently expose gap Y in Minsky"). Use `mcp__minsky__memory_create`.
- **An RFC** if the analysis surfaced a strategic decision Minsky should make in response. Use `/draft-rfc`.
- **An ADR** if a specific architectural decision was crystallized. Use `/draft-adr`.

Don't auto-file these — surface them to the user as a decision per `humility.mdc §Escalation packaging`.

## Output checklist

When the skill completes, verify:

- [ ] Notion page created under Minsky home (`33a937f0-3cb4-8197-a93e-cd4a98a94261`)
- [ ] Title matches the canonical pattern with date suffix
- [ ] Primary sources cited with URLs and dates; aggregator fallbacks explicitly flagged
- [ ] Live-site research used Chrome devtools snapshot, not WebFetch-only
- [ ] Existing Notion / memory cross-references surfaced (no duplicate page filed)
- [ ] "What validates / Where ahead / Where behind" sections all present
- [ ] Investigation paths tagged with 🏷️ _Future Minsky task: ..._ lines
- [ ] Follow-up artifacts (tasks / memories / RFCs / ADRs) surfaced to user, not silently filed

## Anti-patterns

- **Aggregator-only research** — capterra, futuretools, automateed, g2 are stale by default for AI products. State the staleness if you must use them.
- **Picking a winner** — analyses describe terrain. If the conclusion is "product X is better than Minsky" or "Minsky beats X," reframe as gap or validation observations, not verdicts.
- **Generic-SE framing** — applying OSS-hedge / lock-in-minimization / vendor-neutrality frameworks where commercial-product-workflow-fit is the relevant frame (per `principal-context.mdc` and `decision-defaults.mdc §Build vs buy`).
- **Treating "no overlap" as a safe default** — if the first-pass research says "no overlap," verify by probing one more layer. Pivots are common; review aggregators miss them.
- **Confabulating a strategic frame** — per `feedback_confabulated_strategic_frame_to_justify_tactical_preference`, don't invoke a Minsky policy section (e.g., `§Datastores`) to justify a recommendation unless the policy actually covers the question.

## Cross-references

- `documentation-taxonomy.mdc` — the rule that names this as an analysis-page category
- `draft-rfc/SKILL.md` — sibling skill for proposing direction in response to analysis
- `draft-adr/SKILL.md` — sibling skill for recording a single architectural decision
- `engineering-writing/SKILL.md` — writing-craft skill (analyses benefit from its discipline on concision and source-anchoring)
- `principal-context.mdc` — persona frame that determines which evaluation framework applies
- `decision-defaults.mdc §Build vs buy` — adjacent rule on commercial-product framing
