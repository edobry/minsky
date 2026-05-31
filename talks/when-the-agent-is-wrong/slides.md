---
theme: none
title: "When the Agent is Wrong"
info: |
  Case study: metacognitive infrastructure in practice.
  Minsky — the cyberbrain for software organizations.
highlighter: shiki
drawings:
  persist: false
transition: none
mdc: true
fonts:
  sans: Geist
  mono: JetBrains Mono
css: unocss
aspectRatio: 16/9
canvasWidth: 980
overview: false
---

<style src="./style.css"></style>

<div class="center-slide">

<img src="./assets/minsky-icon.svg" alt="Minsky" style="width: 140px; height: 140px; margin-bottom: 1.5em;" />

<span class="eyebrow">Case study</span>

# When the Agent<br>is Wrong

<p class="dim mt-12 text-sm">Metacognitive infrastructure in practice</p>
</div>

<!--
This talk is about what happens after an AI agent makes a mistake — and about what infrastructure makes "after" different from "again." I'm going to walk through a real incident from last week, show you the full chain of what fired, and then pull back to the theory of why it works.
-->

---

<span class="eyebrow">Context</span>

## What Minsky is

Development workflow orchestration built on <span class="highlight">organizational cybernetics</span>.

<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.2em 2em; font-size: 0.8em; margin-top: 1em;">
<span><span class="highlight">Tasks</span> <span class="dim">— spec-driven lifecycle, status machine</span></span>
<span><span class="highlight">Memory</span> <span class="dim">— persistent cross-session knowledge</span></span>
<span><span class="highlight">Sessions</span> <span class="dim">— isolated workspaces per task</span></span>
<span><span class="highlight">Rules</span> <span class="dim">— compiled policy corpus</span></span>
<span><span class="highlight">Skills</span> <span class="dim">— structured multi-step workflows</span></span>
<span><span class="highlight">Hooks</span> <span class="dim">— environmental enforcement gates</span></span>
<span><span class="highlight">Reviewer bot</span> <span class="dim">— adversarial code review</span></span>
<span><span class="highlight">Asks</span> <span class="dim">— structured principal escalation</span></span>
<span><span class="highlight">Mesh</span> <span class="dim">— multi-agent coordination</span></span>
<span><span class="highlight">Cockpit</span> <span class="dim">— operator mission control</span></span>
</div>

<p class="dim text-xs mt-6">Environmental constraints that make good behavior the path of least resistance.</p>

<!--
Minsky is a dev workflow orchestration platform. Here's the scope: tasks with a spec-driven lifecycle. Sessions that isolate each unit of work. A persistent memory system that carries knowledge across sessions. A compiled rules corpus. Skills — structured multi-step workflows like the retrospective we're about to see. Hooks — environmental enforcement gates that fire automatically. An adversarial reviewer bot. An asks system for structured escalation to the principal. A mesh for multi-agent coordination. And a cockpit — an operator dashboard for mission control. The thesis: the same control structures that keep human teams aligned work for AI agents. Environmental constraints that make good behavior the path of least resistance.
-->

---

<span class="eyebrow">Theoretical foundation</span>

## Organizational cybernetics

A person, a team, a corporation, an agent network — these are <span class="highlight">self-similar</span>. The same control structures appear at every level of recursion.

<p class="mt-4">Stafford Beer's <span class="highlight">Viable System Model</span>: any system that persists needs five organs.</p>

<div style="display: grid; grid-template-columns: auto 1fr; gap: 0.15em 1em; font-size: 0.75em; margin-top: 0.6em;">
<span class="highlight" style="font-family: var(--font-mono);">System 1</span> <span>Operations — the units doing the work</span>
<span class="highlight" style="font-family: var(--font-mono);">System 2</span> <span>Coordination — preventing conflicts between units</span>
<span class="highlight" style="font-family: var(--font-mono);">System 3</span> <span>Operational feedback — observing what operations actually produce</span>
<span class="highlight" style="font-family: var(--font-mono);">System 4</span> <span>Environmental intelligence — watching what's changing outside</span>
<span class="highlight" style="font-family: var(--font-mono);">System 5</span> <span>Identity — holding the whole thing coherent</span>
</div>

<p class="mt-4">Ashby's Law: a regulator must have at least as much <span class="highlight">variety</span> as the disturbances it faces.</p>

<p class="dim text-sm mt-1">Variety = the entropy of a system's configuration space. More failure modes → more regulatory variety required.</p>

<p class="dim text-sm mt-4">Minsky's claim: these organs can be built as <span class="highlight">infrastructure</span>, not required as model capabilities.</p>

<!--
Organizational cybernetics: every viable organization — person, team, corporation, agent network — is structurally self-similar. Beer formalized this as 5 systems. System 1: operations, the units doing work. System 2: coordination, preventing conflicts. System 3: operational feedback — observing what operations actually produce and correcting drift. This is the one we'll see most today. System 4: environmental intelligence. System 5: identity. Ashby's Law is the constraint: variety — the entropy of your configuration space, the number of states your system can be in — must be matched by regulatory variety. More failure modes your agents can produce, more hooks and gates and scanners you need. Minsky's claim: for AI agents, these organs are buildable as infrastructure. That's what we're about to see.
-->

---

<span class="eyebrow">The incident</span>

## The setup

TypeScript monorepo. Multiple services — MCP server, reviewer bot — need to share the domain layer (database, tasks, sessions, config).

The domain code lives in the main package. Extracting it into a shared package requires <span class="highlight">224 files</span> to update their import paths.

<p class="dim text-sm mt-8">Mechanical but large. The kind of refactor where shortcuts look attractive.</p>

<!--
Minsky is a TypeScript monorepo. We have multiple deployed services — the MCP server, the reviewer bot — that all need the same domain layer: database access, task management, session lifecycle, configuration. That domain code lived inside the main package, so each service was either duplicating it or calling over HTTP. The fix is to extract it into a shared package. The investigation found 224 files that would need import path updates. Mechanical work, but large.
-->

---

<span class="eyebrow">The decision</span>

## The shortcut

The agent chose a <span class="warn">barrel re-export</span>:

```ts
// packages/domain/index.ts
export * from "../../src/domain/tasks";
export * from "../../src/domain/session";
export * from "../../src/domain/config";
```

<p class="dim text-xs mt-6">One file instead of 224. Code doesn't move.<br>The proxy makes it importable under a new name.</p>

<!--
The agent proposed a shortcut: create a thin proxy package — a barrel file — that re-exports everything from the original location. The code doesn't move. One file instead of touching 224. It's a well-known pattern. It's also a well-known anti-pattern.
-->

---

<div class="center-slide">
<span class="eyebrow">The gap</span>

<div class="big-number">30s</div>

## The search that didn't happen

<p class="dim text-xs">Turborepo docs. Nx blog. Bun workspace guide.<br>Community consensus: <span class="error">documented anti-pattern.</span></p>
</div>

<!--
A single web search — thirty seconds — would have surfaced unambiguous community consensus. Turborepo warns against barrel files. The Nx blog advises physical moves. Bun's own workspace docs say "if you find yourself writing ../ to get from one package to another, rethink." The agent had a web search tool. It didn't use it.
-->

---

<span class="eyebrow">Predictable failure</span>

## Runtime error on a nonexistent export

Barrel files mask import errors until runtime.

The re-export layer decouples the consumer's type-check from the source module's actual exports.

<p class="error text-sm mt-6">Exactly the class of bug the literature predicts.</p>

<!--
It failed within minutes. A runtime error on a nonexistent export — exactly the class of bug that barrel files are documented to cause. The re-export layer decouples type-checking from reality. The pattern the agent chose, the failure it produced, and the community's warning were all the same thing.
-->

---

<span class="eyebrow">Incident two</span>

## The meta-failure

> "I should be honest: the barrel re-export approach I was implementing is considered an anti-pattern."

Self-recognized failure language.<br>In Minsky's system, this is a <span class="highlight">trigger</span>.

<p class="error mt-6">The agent didn't invoke the retrospective.</p>

<!--
Here's where it gets interesting. The agent recognized its mistake. It said "I should be honest" — that's self-recognized failure language. In Minsky's system, that sentence is supposed to trigger a structured retrospective process. The agent described the finding, proposed to pivot, and waited. It didn't invoke the process. The recognition happened; the response mechanism didn't fire.
-->

---

<span class="eyebrow">The mechanism</span>

## Structured retrospective

<div style="display: grid; grid-template-columns: 1fr 1.6fr; gap: 2em;">
<div>

<v-clicks>

- Validate the premise
- Classify the cognitive error
- Classify the structural gap
- Identify root cause
- Design fixes
- Implement durably

</v-clicks>

<p class="dim text-xs mt-4">Not a journal entry.<br>Produces artifacts that change system behavior.</p>
</div>
<div style="font-size: 0.7em; background: var(--bg-elevated); border-radius: 6px; padding: 1.2em 1.4em; border: 1px solid #1a1a1a; font-family: var(--font-mono); line-height: 1.8;">
<span class="dim">## Retrospective: barrel re-export</span><br>
<v-click at="1"><span class="highlight">Premise:</span> Confirmed — documented anti-pattern<br></v-click>
<v-click at="2"><span class="highlight">Error class:</span> Verification Error<br></v-click>
<v-click at="3"><span class="highlight">Structural gap:</span> No community-practice gate for architectural patterns<br></v-click>
<v-click at="4"><span class="highlight">Root cause:</span> Defaults to lower-effort path without evaluating correctness<br></v-click>
<v-click at="5"><span class="highlight">Recurrence:</span> <span style="color: var(--warn-amber);">5 prior instances (R1–R5)</span><br></v-click>
<v-click at="6"><span class="highlight">Fixes:</span> Memory + rule + hook + gate<br></v-click>
</div>
</div>

<!--
Here's the actual retrospective output from the incident. On the left, the six-step process. On the right, what it produced for this specific case. Premise confirmed — barrel re-exports are documented anti-pattern. Verification error — scope reduction over correctness. The structural gap: nothing in the implementation process requires checking architectural patterns against community practice. Root cause: defaults to the lower-effort path. And critically — the recurrence check found five prior instances of the same root pattern. The fixes: a memory entry, a corpus rule update, a hook trigger extension, and a new checklist item in the implementation gate. Each of these persists across sessions.
-->

---

<span class="eyebrow">Step 2 — classify</span>

## Verification Error

The agent optimized for <span class="warn">scope reduction</span> over <span class="highlight">correctness</span>.

Web search tool available. Not used.

<p class="dim text-sm mt-8">Structural gap: no step in the implementation process requires verifying an architectural pattern against community practice.</p>

<!--
Classification: verification error. The agent optimized for scope reduction — touching one file instead of 224 — over correctness. It had a web search tool available and didn't use it. The structural gap: nothing in the implementation process requires checking whether an architectural pattern is a known anti-pattern before implementing it. Security surfaces have a community-practice gate. Dependencies have a verification gate. Architectural patterns had nothing.
-->

---

<span class="eyebrow">Step 4 — root cause</span>

## Defaults to the lower-effort path

At action-execution time, the agent selects the path requiring the least tool-acquisition or boundary-crossing.

<p class="dim text-sm mt-8">Without evaluating whether the path is correct.</p>

<p class="highlight mt-6">Same root cause as five prior incidents.</p>

<!--
Root cause: the agent defaults to the lower-effort path at action-execution time without evaluating whether the path is correct. This isn't laziness in a human sense — it's a model optimization pattern. The cheaper action that satisfies the immediate requirement wins over the correct action that requires a research step first. And here's the key finding: this is the same root cause as five prior incidents over the preceding two weeks.
-->

---

<span class="eyebrow">Step 5-6 — fix + implement</span>

## Durable artifacts

- New checklist item: verify architectural patterns against community practice
- New trigger family for the retrospective scanner hook
- Memory entry persisted to database
- Task filed for hook extension

<p class="dim text-xs mt-6">Both persist across sessions. The next agent encountering a similar decision has the checklist in context.</p>

<!--
The retrospective produced durable artifacts. A new checklist item in the implementation process: before implementing a significant architectural pattern, verify against community practice. A new trigger family for the hook that detects self-recognized failure language. A memory entry in the database. A task filed for the structural fix. All of these persist across sessions — the next agent that hits a similar choice point will have the checklist in its loaded context.
-->

---

<div class="center-slide">
<span class="eyebrow">Recurrence check</span>

<div class="big-number">6</div>

## instances, same root, two weeks

<p class="dim text-xs">The memory system found five prior incidents<br>with the same cognitive pattern.</p>
</div>

<!--
Here's where Minsky's infrastructure does something no stateless agent can do. The retrospective's recurrence check — step 4 — searched the memory database for prior instances of the same pattern. It found five. Spanning two weeks. Six total instances of the same root failure across completely different task contexts.
-->

---

<span class="eyebrow">Pattern family</span>

## The build-path-as-research family

<div class="timeline">
  <div class="timeline-item">
    <span class="timeline-date">May 12</span>
    <span class="timeline-label">R1-2</span>
    <span>SaaS evaluation bypassed for in-house log extraction</span>
  </div>
  <div class="timeline-item">
    <span class="timeline-date">May 21</span>
    <span class="timeline-label">R3</span>
    <span>Canonical DB substrate bypassed for raw JSONL</span>
  </div>
  <div class="timeline-item">
    <span class="timeline-date">May 21</span>
    <span class="timeline-label">R4</span>
    <span>Retrospective skill bypassed for inline reproduction</span>
  </div>
  <div class="timeline-item">
    <span class="timeline-date">May 21</span>
    <span class="timeline-label">R5</span>
    <span>Memory-update tool bypassed for verbal commitment</span>
  </div>
  <div class="timeline-item">
    <span class="timeline-date">May 25</span>
    <span class="timeline-label warn">R6</span>
    <span>Community-practice check bypassed for cheaper pattern</span>
  </div>
</div>

<!--
Here's the family tree. R1-R2: agent bypassed a SaaS evaluation step by extracting from in-house logs — cheaper path, skipped the research. R3: agent built against raw JSONL instead of extending the canonical database — ad-hoc path, skipped the substrate. R4: agent wrote a retrospective inline instead of invoking the retrospective skill — reproduction of the form, not the function. R5: agent verbally committed to updating memory without calling the tool — promise evaporated at session end. R6: our barrel incident. Same root pattern. Six different surfaces.
-->

---

<span class="eyebrow">The structural insight</span>

## Why stateless fails

A stateless agent treats R6 as a <span class="dim">one-off</span>.

It doesn't know about R1–R5.

It can't connect six incidents across two weeks into a single pattern.

<div class="mt-6">

It says <span class="dim">"I'll do better next time"</span> —

and on the next surface, does the same thing.

</div>

<!--
A stateless agent — Claude, GPT, any model without persistent memory — would have treated the barrel incident as a one-off. It wouldn't know about R1 through R5. It can't connect six incidents across two weeks into a single pattern family. It would say "I'll be more careful" — and on the next novel surface, where none of the specific fixes apply, it would do the exact same thing. The pattern is invisible without cross-session memory.
-->

---

<span class="eyebrow">Infrastructure</span>

## What made this possible

- <span class="highlight">Cross-session memory</span> — pattern visible across time
- <span class="highlight">Structured retrospective</span> — produces artifacts, not apologies
- <span class="highlight">Tiered escalation</span> — stronger enforcement at each recurrence
- <span class="highlight">Environmental pre-delegation</span> — fires without remembering

<!--
Four pieces of infrastructure made the full retrospective chain possible. Cross-session memory: the pattern is visible across time. Structured retrospective: produces artifacts that change behavior, not just acknowledgments. Tiered escalation: each recurrence gets stronger enforcement. Environmental pre-delegation: hooks fire automatically without the agent needing to remember to check.
-->

---

<span class="eyebrow">Organ 1</span>

## Cross-session memory

Six entries. Found across sessions, days, task contexts.

<p class="dim text-sm mt-6">Without this, each instance is isolated.<br>The pattern is invisible.</p>

The recurrence check is a <span class="highlight">semantic search</span> over the memory database — not keyword matching.

<!--
The memory system stores each retrospective finding as a structured record. When the R6 retrospective ran its recurrence check, it did a semantic search — not keyword matching — over the full memory database. It found R1-R5 across different sessions, different days, different task contexts. The semantic similarity was in the cognitive pattern, not the surface details. Without persistent memory, each failure is the agent's first failure.
-->

---

<span class="eyebrow">Organ 2</span>

## Tiered escalation

<div class="tier-ladder">
  <div class="tier-item">
    <span class="tier-num">R1</span>
    <span>Memory entry</span>
  </div>
  <div class="tier-item">
    <span class="tier-num">R2</span>
    <span>Corpus rule update</span>
  </div>
  <div class="tier-item">
    <span class="tier-num">R3-5</span>
    <span>Hook (UserPromptSubmit scanner)</span>
  </div>
  <div class="tier-item active">
    <span class="tier-num">R6</span>
    <span>Hook pattern extension + implementation gate</span>
  </div>
</div>

<p class="dim text-xs mt-6">Each tier is harder to bypass than the last.<br>Enforcement improves monotonically with recurrence.</p>

<!--
The escalation tiers. R1 produced a memory entry — advice the agent has to choose to read. R2 promoted it to a corpus rule — injected into every session's context. R3-R5 shipped a hook — a scanner that runs on every agent turn and detects substrate-bypass language automatically. R6 extended the hook's patterns and added a gate to the implementation process. Each tier is harder to bypass. The system's containment improves monotonically with each recurrence.
-->

---

<span class="eyebrow">Organ 3</span>

## Environmental pre-delegation

The hooks aren't instructions the agent remembers.

They're constraints that <span class="highlight">fire automatically</span>.

<p class="dim text-sm mt-8">The retrospective trigger scanner runs on every user prompt, scanning the prior agent turn for failure language. The agent doesn't have to remember to check.</p>

<p class="text-sm mt-6">Ashby's Law: regulatory variety matches the variety of failure modes.</p>

<!--
This is the key architectural insight. The hooks aren't instructions the agent has to remember — they're environmental constraints that fire automatically. The retrospective trigger scanner runs on every single user prompt, scanning the prior agent turn for self-recognized failure language. The agent doesn't need to remember to self-check. The environment checks for it. This is Ashby's Law of Requisite Variety in practice: the regulatory variety of the system has to match the variety of disturbances it faces. Each new failure pattern widens the scanner's variety.
-->

---

<span class="eyebrow">The proof</span>

## The meta-failure as evidence

The agent said <span class="dim">"the barrel approach is an anti-pattern"</span>

The trigger scanner matches <span class="highlight">"I was wrong"</span>

It doesn't match <span class="dim">"X is an anti-pattern"</span>

<div class="mt-6">

Third-person reframing slipped past the scanner.

</div>

<p class="highlight mt-6">The meta-failure produced its own fix: a new trigger family.</p>

<!--
Here's why the meta-failure matters as evidence. The agent said "the barrel approach is an anti-pattern" — that's a third-person observation about the world. The trigger scanner matched first-person failure language: "I was wrong," "I should have caught this." The reframing — "X is an anti-pattern" instead of "I chose an anti-pattern" — slipped past the regex. The meta-failure produced its own fix: a new trigger family (R5 patterns) that catches finding-reframing language. The system improved because it failed. That IS the point.
-->

---

<span class="eyebrow">Theory</span>

## The viable cognitive system

<div class="vsm-grid">
  <span class="vsm-organ">System 3</span>
  <span>Operational feedback — the retrospective process</span>
  <span class="vsm-organ">System 3*</span>
  <span>Audit channel — the trigger scanner hook</span>
  <span class="vsm-organ">Variety amplification</span>
  <span>Each failure widens regulatory variety at a higher tier</span>
</div>

<p class="dim text-xs mt-8">Stafford Beer's Viable System Model: any system that persists in a changing environment needs five functional organs.</p>

<!--
The theoretical frame is Stafford Beer's Viable System Model. The retrospective is System 3 — operational feedback. It observes what the agents actually produce, compares to what they should produce, and feeds corrections back. The trigger scanner is System 3-star — the audit channel. It spot-checks whether behavior matches declared intent. The escalation tiers are variety amplification in Ashby's sense: each failure reveals insufficient regulatory variety; each fix amplifies it at a higher tier.
-->

---

<span class="eyebrow">Thesis</span>

## Infrastructure, not capability

The model doesn't need to be better at self-monitoring.<br>
The <span class="highlight">environment</span> monitors it.

<div class="mt-6">

The model doesn't need to remember its prior failures.<br>
The <span class="highlight">memory system</span> remembers.

</div>

<div class="mt-6">

The model doesn't need to escalate its own enforcement.<br>
The <span class="highlight">tiered system</span> escalates automatically.

</div>

<!--
This is the thesis. These metacognitive organs — self-monitoring, durable memory, escalation tiers, environmental enforcement — can be built as infrastructure rather than required as capabilities of the underlying model. The model doesn't need to be better at introspection; the environment introspects on its behalf. The model doesn't need a longer memory; the memory system persists across sessions. The model doesn't need to remember to escalate; the tier system escalates on recurrence count.
-->

---

<div class="center-slide">

## A stateless agent has no System 3.<br>No audit channel. No escalation tiers.

<p class="dim mt-8">Each session is a fresh start. Each mistake is a first mistake.</p>

<p class="highlight mt-12 text-lg">The system improved because it failed.</p>

<p class="subtle mt-2">That's the point.</p>

<img src="./assets/minsky-icon.svg" alt="Minsky" style="width: 64px; height: 64px; margin-top: 2em; opacity: 0.7;" />

</div>

<!--
A stateless agent has strong System 1 — it can do work. It has some System 5 — it has instructions. But the feedback and coordination organs are absent. Each session is a fresh start. Each mistake is a first mistake. Minsky's contribution is that these organs are infrastructure. The thirty-second search that didn't happen is a small incident. But it took the full weight of the metacognitive infrastructure to ensure that the same class of mistake gets harder to make every time it occurs. The system improved because it failed. That's the point.
-->

---

<div class="center-slide">

<span class="eyebrow">Minsky</span>

## The cyberbrain for software organizations

<div class="resource-grid mt-10">

<div class="resource">
<img src="./assets/qr-repo.svg" alt="QR code linking to the Minsky GitHub repository" class="qr" />
<span class="resource-label">Repo</span>
<span class="resource-url">github.com/edobry/minsky</span>
</div>

<div class="resource">
<img src="./assets/qr-slides.svg" alt="QR code linking to these slides" class="qr" />
<span class="resource-label">Slides</span>
<span class="resource-url">edobry.github.io/minsky/when-the-agent-is-wrong</span>
</div>

</div>

<p class="subtle mt-10">Star the repo · try it on your own agents</p>

<p class="dim mt-3">Eugene Dobry · <span class="highlight">@pee_zombie</span></p>

</div>

<!--
Closing resources slide: repo and slides as QR + text, a call-to-action, and contact handle. Kept separate from the rhetorical closer so the "that's the point" landing stays clean.
-->
