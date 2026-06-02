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

<span class="eyebrow">Demo night</span>

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
I left my job last year, took a sabbatical, and went all-in on AI coding to understand what this stuff actually is. I started building tooling for myself — session isolation, a memory system, hooks. It kept growing. Here's the thing I noticed: these agents are brilliant programmers and weirdly myopic at the same time — not self-aware — in a way that reminded me of managing my own ADHD. So instead of trying to instruct the agent into behaving, I started building the environment around it. Bumpers, not lectures.
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

  <div class="comp-card">
    <img src="./assets/comp-conductor.png" alt="Conductor homepage" class="comp-shot" />
    <span class="comp-name">Conductor <span class="comp-host">conductor.build</span></span>
    <span class="comp-line">"you are the conductor"</span>
    <span class="comp-tag">Mac app · terminal-light indie</span>
  </div>

  <div class="comp-card">
    <img src="./assets/comp-multica.png" alt="Multica homepage" class="comp-shot" />
    <span class="comp-name">Multica <span class="comp-host">multica.ai</span></span>
    <span class="comp-line">"your next 10 hires won't be human"</span>
    <span class="comp-tag">substitution myth · serif/pastoral</span>
  </div>

  <div class="comp-card">
    <img src="./assets/comp-cortex.png" alt="Cortex homepage" class="comp-shot" />
    <span class="comp-name">Cortex <span class="comp-host">cortex.io</span></span>
    <span class="comp-line">"Code is no longer the bottleneck. Everything else is."</span>
    <span class="comp-tag">enterprise governance</span>
  </div>

</div>

<div class="comp-support">

  <div class="comp-card">
    <img src="./assets/comp-smithers.png" alt="Smithers homepage" class="comp-shot" />
    <div class="comp-meta">
      <span class="comp-name">Smithers</span>
      <span class="comp-tag">durable TS workflow runtime</span>
    </div>
  </div>

  <div class="comp-card">
    <img src="./assets/comp-t3.png" alt="T3 Code homepage" class="comp-shot" />
    <div class="comp-meta">
      <span class="comp-name">T3 Code</span>
      <span class="comp-tag">open-source control plane</span>
    </div>
  </div>

  <div class="comp-card">
    <img src="./assets/comp-macro.png" alt="Macro homepage" class="comp-shot" />
    <div class="comp-meta">
      <span class="comp-name">Macro</span>
      <span class="comp-tag">"operating system for your startup"</span>
    </div>
  </div>

</div>

<!--
Here's the field. Conductor: you are the conductor. Multica: your next 10 hires won't be human. Cortex: code is no longer the bottleneck, everything else is. And here's what's unsettling — they all have the same features. Orchestrate agents, isolate them in worktrees, bring your own model, a skills layer, a review gate. Features don't separate us. The myth does.
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

<div class="center-slide">

<span class="eyebrow">The ask</span>

<p class="ask-q">If you had to explain Minsky<br>in <span class="highlight">one sentence</span> —<br>what would you say?</p>

<p class="ask-cta">Come find me after — I'm the guy who built something for a year and still can't explain it. I'll be around.</p>

<p class="dim mt-8 text-sm">Eugene Dobry · <span class="highlight">@pee_zombie</span></p>

</div>

<!--
So that's my ask. If you had to explain this to someone in one sentence, what would you say? What lands, what's confusing? Come find me after — I'll be around. Thanks.
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
<span class="resource-url">edobry.github.io/minsky/what-is-minsky</span>
</div>

</div>

<p class="subtle mt-10">Take the slides · come argue with me about the one-liner</p>

<p class="dim mt-3">Eugene Dobry · <span class="highlight">@pee_zombie</span></p>

</div>

<!--
Resources slide: repo and slides as QR + text, plus the contact handle. The slides URL is live once this deck merges to main and the deploy-talks Pages workflow runs. Kept separate from the "one sentence?" ask so that rhetorical closer lands clean.
-->
