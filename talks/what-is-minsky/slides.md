---
theme: none
title: "What Is Minsky?"
info: |
  Demo-night talk. A year in, and I still can't say it in one line —
  but here's my best answer, and the field it has to stand against.
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

<img src="./assets/minsky-icon.svg" alt="Minsky" style="width: 132px; height: 132px; margin-bottom: 1.4em;" />

<span class="eyebrow">Fractal Weekly Demo Party #2</span>

# What Is Minsky?

<p class="dim mt-8 text-lg">I built it for a year and still can't say.</p>

<p class="subtle mt-12 text-sm">Eugene Dobry · <span class="highlight">@pee_zombie</span> · AI coding orchestration</p>

</div>

<!--
I'm Eugene. I've been building this thing called Minsky for about a year — roughly, an orchestration system for AI coding work. This is less a demo than a discussion. I'm not going to pitch you; I want your reaction. Last week I showed you one piece of it actually working. Today I want to zoom out — and admit I can't yet explain the whole thing. Come argue with me after all the talks.
-->

---

<div class="center-slide">

<span class="eyebrow">Origin, in one breath</span>

<img src="./assets/lane.svg" alt="A bowling lane with the bumpers raised" class="lane-img" />

<p class="tagline-xl">Don't instruct the agent.<br><span class="highlight">Build the lane.</span></p>

</div>

<!--
I left my job last year, took a sabbatical, and went all-in on AI coding to understand what this stuff actually is. I started building tooling for myself — session isolation, a memory system, hooks. It kept growing. Here's the thing I noticed: these agents are brilliant programmers and weirdly myopic at the same time — not self-aware — in a way that reminded me of managing my own ADHD. So instead of trying to instruct the agent into behaving, I started building the environment around it. Bumpers, not lectures. And I stayed heads-down on that for months.
-->

---

<span class="eyebrow">What it actually is</span>

<p class="ground-lead">It runs <span class="highlight">under</span> your coding agent. The substrate lives <span class="highlight">underneath</span>.</p>

<img src="./assets/arch.svg" alt="Architecture: the principal declares intent to Claude Code or any harness, which talks over MCP to the Minsky substrate — sessions, memory, tasks, hooks, reviewer bot, asks — backed by Postgres, with a cockpit you watch it run in" class="arch-img" />

<!--
Concretely, here's the shape — so the rest of the talk isn't abstract. You work in your coding agent: Claude Code, or whatever harness you use. Minsky sits underneath it, over MCP. And underneath THAT is a real system — sessions, a memory that persists across them, a task lifecycle, hooks that fire automatically to catch mistakes, an adversarial reviewer bot, an escalation channel called asks — all backed by Postgres. It's not an app you open instead of your agent. It's the substrate your agent runs inside.
-->

---

<span class="eyebrow">…and you watch it run</span>

<p class="ground-lead">The cockpit — mission control for the flock.</p>

<img src="./assets/cockpit.png" alt="The Minsky cockpit — a mission-control web UI showing system health, attention/asks, credentials, memory, and a widget grid for agents, tasks, and sessions" class="product-shot" />

<!--
And here's the part you actually look at — the cockpit. A web UI over the whole substrate: system health, what's waiting on your attention, which credentials are wired, memory and embedding coverage, and a grid for agents, tasks, sessions, the dependency graph, asks. This is the "mission control you fly" — not a dashboard you read after the fact, but the surface you watch the flock run in. Last week I showed one piece of this actually working; today it's the backdrop.
-->

---

<span class="eyebrow">In practice</span>

<p class="ground-lead">You work in your agent. It's <span class="highlight">calling Minsky</span> the whole time.</p>

<div class="term">
  <div class="term-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="term-title">claude code — task/mt-2272</span></div>
  <div class="term-body">
<div class="tl"><span class="tp">›</span><span class="tu">implement mt#2272</span></div>
<div class="tl"><span class="tc">→ minsky.tasks_get</span>  <span class="td">spec · scope · acceptance tests</span></div>
<div class="tl"><span class="tc">→ minsky.session_start</span>  <span class="td">isolated workspace</span></div>
<div class="tl"><span class="tc">→ minsky.memory_search</span>  <span class="td">12 prior decisions → context</span></div>
<div class="tl"><span class="to">  … editing 4 files …</span></div>
<div class="tl"><span class="te">⨯ hook  edit blocked: generated file</span>  <span class="td">edit the source</span></div>
<div class="tl"><span class="tc">→ minsky.session_commit</span>  <span class="td">pre-commit guards pass</span></div>
<div class="tl"><span class="tc">→ minsky.session_pr_create</span>  <span class="td">reviewer bot dispatched</span></div>
<div class="tl"><span class="tr">↺ /retrospective  recurrence check</span>  <span class="td">5 prior, same root</span></div>
  </div>
</div>

<!--
This is what it looks like from the inside — and it's the clearest answer to "what is it." You're just working in Claude Code. But every step, it's calling Minsky underneath: pull the task spec, start an isolated session, search memory and inject the prior decisions, edit — and a hook fires to block an edit to a generated file before it happens, commit through the pre-commit guards, open the PR and dispatch the reviewer bot, and when I slip into a known failure pattern, a retrospective runs a recurrence check across everything that came before. None of that is me remembering to do it. The substrate does it. That's the lane.
-->

---

<div class="center-slide">

<span class="eyebrow">The crisis</span>

<p class="tagline-xl">Then I looked up —<br>and the field had <span class="warn">filled in.</span></p>

</div>

<!--
Then a few months ago I looked up. The models had gotten dramatically better, and a dozen teams had shipped things that look a lot like Minsky. And I realized I'd lost the plot on what actually makes Minsky Minsky. So I did the obvious thing — I taught the agent to do competitive and semiotic-branding analysis, and mapped the whole landscape.
-->

---

<span class="eyebrow">The field</span>

<p class="field-line">Everyone agrees code is no longer the bottleneck. The fight is over what the bottleneck <span class="highlight">is</span> — and <span class="highlight">where you put the intelligence</span> to handle it.</p>

<div class="comp-wall">

  <a class="comp-card" href="https://conductor.build" target="_blank" rel="noopener">
    <img src="./assets/comp-conductor.png" alt="Conductor homepage" class="comp-shot" />
    <span class="comp-name">Conductor <span class="comp-host">conductor.build</span></span>
    <span class="comp-line">"you are the conductor"</span>
    <span class="comp-tag">Mac app · terminal-light indie</span>
  </a>

  <a class="comp-card" href="https://multica.ai" target="_blank" rel="noopener">
    <img src="./assets/comp-multica.png" alt="Multica homepage" class="comp-shot" />
    <span class="comp-name">Multica <span class="comp-host">multica.ai</span></span>
    <span class="comp-line">"your next 10 hires won't be human"</span>
    <span class="comp-tag">substitution myth · serif/pastoral</span>
  </a>

  <a class="comp-card" href="https://www.cortex.io" target="_blank" rel="noopener">
    <img src="./assets/comp-cortex.png" alt="Cortex homepage" class="comp-shot" />
    <span class="comp-name">Cortex <span class="comp-host">cortex.io</span></span>
    <span class="comp-line">"Code is no longer the bottleneck. Everything else is."</span>
    <span class="comp-tag">enterprise governance</span>
  </a>

</div>

<div class="comp-support">

  <a class="comp-card" href="https://smithers.sh" target="_blank" rel="noopener">
    <img src="./assets/comp-smithers.png" alt="Smithers homepage" class="comp-shot" />
    <div class="comp-meta">
      <span class="comp-name">Smithers</span>
      <span class="comp-tag">durable TS workflow runtime</span>
    </div>
  </a>

  <a class="comp-card" href="https://t3.codes" target="_blank" rel="noopener">
    <img src="./assets/comp-t3.png" alt="T3 Code homepage" class="comp-shot" />
    <div class="comp-meta">
      <span class="comp-name">T3 Code</span>
      <span class="comp-tag">open-source control plane</span>
    </div>
  </a>

  <a class="comp-card" href="https://macro.com" target="_blank" rel="noopener">
    <img src="./assets/comp-macro.png" alt="Macro homepage" class="comp-shot" />
    <div class="comp-meta">
      <span class="comp-name">Macro</span>
      <span class="comp-tag">"operating system for your startup"</span>
    </div>
  </a>

</div>

<!--
Here's the field. Conductor: you are the conductor. Multica: your next 10 hires won't be human. Cortex: code is no longer the bottleneck, everything else is. Smithers, T3 Code, Macro down here. A dozen serious teams, shipping fast. When I first saw this wall, my stomach dropped — because at a glance, they look like me.
-->

---

<span class="eyebrow">Same parts</span>

## Features don't separate us.

<div class="chip-row">
  <span class="chip">orchestrate agents</span>
  <span class="chip">worktree isolation</span>
  <span class="chip">bring your own model</span>
  <span class="chip">skills layer</span>
  <span class="chip">review gate</span>
</div>

<p class="tagline-xl">Everyone has the parts.<br>What differs is the <span class="highlight">bet</span> — what the system is <span class="highlight">for</span>.</p>

<!--
But when I actually mapped them, the panic faded. Because they all have the same parts. Orchestrate multiple agents, isolate each in a git worktree, bring your own model, a skills layer, a human review gate. That's the whole checklist, and everyone ships it. So features can't be the answer to "what is Minsky" — we'd all give the same list. What actually separates these products is the bet underneath: what unit the system serves, and where the intelligence lives. That's the only axis that matters — and it's a question about myth, not features.
-->

---

<span class="eyebrow">My best current answer</span>

<div class="answer-stack">

<p class="answer-lead">The field built apps for <span class="dim">driving</span> agents.<br>Minsky is the <span class="highlight">substrate</span> the agents — and you — live <span class="highlight">inside</span>.</p>

<p class="answer-sub">Conductor says <span class="highlight">you</span> are the conductor. Minsky says the orchestra should conduct <span class="highlight">itself</span> — so you're free to think.</p>

<div class="word-row">
  <span>exocortex</span><span class="sep">·</span><span>cyberbrain</span><span class="sep">·</span><span>the substrate</span>
</div>

</div>

<!--
Here's where I've landed. Everyone else built an app you sit in front of to drive your agents. I think Minsky is the thing you and the agents live inside — an exocortex. A substrate that holds the same way whether you're a solo dev or a whole org. That's my best current answer. My actual problem: Cortex says their whole thing in one line on a homepage, and I can't do that yet. The thesis is real; the one-liner isn't. That's what I'm stuck on.
-->

---

<span class="eyebrow">The part I'm surest of</span>

## Same substrate, every rung.

<div class="rung-row">
  <div class="rung"><span class="rung-tag">solo dev</span><span>one principal, a flock of agents</span></div>
  <div class="rung"><span class="rung-tag">tech lead</span><span>a principal over a team of those</span></div>
  <div class="rung"><span class="rung-tag">the org</span><span>a principal over teams of teams</span></div>
</div>

<p class="dim mt-6">Everyone else picked one rung. Minsky is the same substrate at <span class="highlight">every</span> rung — because being a principal is <span class="highlight">recursive</span>.</p>

<!--
One more, if the clock allows — the part I'm most sure is right and least able to say fast. Every competitor picked a rung: you're a solo dev, or a team, or an org, and the product is built for that one. Minsky is the same substrate at every rung, because being a principal is recursive. The solo dev directing a flock of agents is a principal. The lead directing a team of those is a principal. The VP over teams of teams is a principal. Same shape, all the way up. Nobody else is built that way — and I still can't compress it into a sentence.
-->

---

<div class="center-slide">

<span class="eyebrow">The ask</span>

<p class="ask-q">If you had to explain Minsky<br>in <span class="highlight">one sentence</span> —<br>what would you say?</p>

<p class="ask-cta">Can't yet? Even better for me — tell me <span class="highlight">where I lost you</span>, or what you'd want to see. The confusion is the data I'm after. Come find me after; I'll be around.</p>

<p class="dim mt-8 text-sm">Eugene Dobry · <span class="highlight">@pee_zombie</span></p>

</div>

<!--
So that's my ask, and it's a real one. If you can say Minsky in one sentence — tell me, because I can't. But if you can't either — that's actually more useful to me. Tell me where I lost you, what confused you, what you'd have wanted to see. I'm trying to make this thing legible, and the gap between what I said and what landed is exactly the data I need. Come find me after — I'll be around. Thanks.
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
<span class="resource-label">These slides</span>
<span class="resource-url">edobry.github.io/minsky/what-is-minsky</span>
</div>

<div class="resource">
<img src="./assets/qr-lastweek.svg" alt="QR code linking to last week's talk, When the Agent is Wrong" class="qr" />
<span class="resource-label">Last week</span>
<span class="resource-url">…/when-the-agent-is-wrong</span>
</div>

</div>

<p class="subtle mt-10">Missed last week? It's the piece I mentioned — grab it. Then come argue with me about the one-liner.</p>

<p class="dim mt-3">Eugene Dobry · <span class="highlight">@pee_zombie</span></p>

</div>

<!--
Resources slide: repo and slides as QR + text, plus the contact handle. The slides URL is live once this deck merges to main and the deploy-talks Pages workflow runs. Kept separate from the "one sentence?" ask so that rhetorical closer lands clean.
-->

---

<span class="appendix-tag">Appendix · if there's time or a question</span>

<p class="ground-lead">More of the cockpit — <span class="highlight">one surface, the whole substrate</span>.</p>

<div class="montage">
  <figure>
    <img src="./assets/cockpit-tasks.png" alt="Cockpit task list — sortable, filterable task table with status pills" />
    <figcaption><b>Task list</b> — every task, its status and lifecycle</figcaption>
  </figure>
  <figure>
    <img src="./assets/cockpit-agents.png" alt="Cockpit agents view — active sessions with liveness and PR state" />
    <figcaption><b>Agents</b> — live sessions, liveness, PR state</figcaption>
  </figure>
  <figure>
    <img src="./assets/cockpit-workstreams.png" alt="Cockpit workstreams — parent tasks with active child counts" />
    <figcaption><b>Workstreams</b> — parent tasks, active child counts</figcaption>
  </figure>
  <figure>
    <img src="./assets/cockpit-embeddings.png" alt="Cockpit embeddings infrastructure — provider health and index coverage" />
    <figcaption><b>Memory & embeddings</b> — coverage across the corpus</figcaption>
  </figure>
</div>

<!--
Backup slide — not part of the 3-minute run; here to jump to if someone after the talk asks "what else is in it" or "show me the cockpit." Four more surfaces: the task list (every task and its lifecycle), agents (live sessions with liveness and PR state), workstreams (parent tasks with their active children — the flock view), and the embeddings/memory coverage across tasks, memories, and the principal corpus. One surface over the whole substrate.
-->
