# Theory of Operation

This document bridges Minsky's theoretical foundations to its actual implementation. It answers the
question: why is the system designed this way, and where does that design show up in the code?

This is not a reproduction of the theory — it is a map. For the full theoretical treatment, see
the [Notion: Vision & theory](https://www.notion.so/33a937f03cb4815c8394d7fe62d61355) page. For
implementation details, see [`docs/architecture.md`](architecture.md).

---

## The Core Principle: Environmental Pre-delegation

The central insight behind Minsky's design is that alignment is achieved through environmental
design, not individual discipline.

The same control structures that work for human teams work for AI agents. An engineer who cannot
push unformatted code to main (because a pre-commit hook blocks it) never needs to remember to
format. An agent working in an isolated session cannot accidentally overwrite a colleague's work
(because it has its own git clone). The environment enforces the constraint; the actor — human or
AI — is free to focus on the actual work.

Three concrete examples from the codebase:

- **Pre-commit hooks** (`src/hooks/pre-commit.ts`, `.husky/`) run format, lint, typecheck, and
  test checks before every commit. Neither humans nor AI agents can commit code that fails these
  checks. Quality is enforced at the boundary, not delegated to memory or discipline.

- **Session isolation** (`src/domain/session/`) gives each work unit its own git clone, branch,
  and lifecycle. Parallel agents cannot interfere with each other's in-progress work. The
  filesystem itself is the coordination mechanism.

- **Quality gates** (CI checks, pre-merge review hooks in `.claude/settings.json`) make review and
  verification the path of least resistance. A PR cannot be merged without passing CI and posting a
  review — the workflow enforces this structurally.

This is Ashby's Law of Requisite Variety applied to software development infrastructure: each
environmental constraint attenuates one dimension of possible failure.

---

## The Five-Organ Architecture (VSM Mapping)

Stafford Beer's Viable System Model identifies five functional organs that any self-sustaining
system must possess. The table below maps each organ to Minsky's current implementation.

### System 1: The Work (Operations)

**Role**: The operational units that do the actual work — task execution, code changes, PR
creation.

**Implementation**:

- `src/domain/session/` — isolated git workspaces where implementation happens. Each session is
  a git clone tied to a task, with its own branch and lifecycle from `start` to `merge`.
- `src/domain/tasks/` — task CRUD with pluggable backends (GitHub Issues, Minsky DB). Tasks
  are the units of work that sessions execute.
- `src/adapters/shared/` — dual CLI/MCP interface. The same operations are exposed through
  `minsky` CLI and `mcp__minsky__*` tools without duplicating business logic.

**Status**: Built.

---

### System 2: The Mesh (Coordination)

**Role**: Prevents the operational units from interfering with each other. Handles
anti-oscillatory coordination — the signals that keep parallel workers in sync without requiring
central direction.

**Implementation**:

- Pre-commit hooks (`src/hooks/pre-commit.ts`, `.husky/`) enforce consistent code quality across
  all contributors — human and AI alike. Every commit passes the same 8-step validation pipeline.
- Session isolation (`src/domain/session/session-service.ts`) prevents parallel sessions from
  conflicting at the filesystem level. Each session operates in
  `~/.local/state/minsky/sessions/<UUID>/`.
- Workflow hooks (`.claude/settings.json`) encode coordination rules for AI agents working inside
  the repo — what to check before committing, what to verify before merging.

**Status**: Partial. Hooks and isolation exist. What is missing: cross-session coordination
signals (a way for concurrent agents to know what other agents are currently working on) and a
reasoning stream (structured logs of agent decision-making that other agents could consult).

---

### System 3: The Loop (Operational Feedback)

**Role**: Monitors operations and feeds back to the operational units. Closes the loop between
"what is happening" and "what should be happening." Includes an audit channel (System 3\*) for
spot-checking that reported behavior matches actual behavior.

**Implementation**:

- CI integration — GitHub Actions runs the full build and test suite on every PR. This is the
  primary feedback mechanism: operational output (a PR) is automatically verified against quality
  criteria.
- Session lifecycle (`src/domain/session/`) — the `pr_create → pr_approve → pr_merge → frozen`
  state machine enforces an ordered workflow. Sessions cannot skip steps.

**Status**: Partial. Basic workflow enforcement and CI feedback exist. What is missing: a
structured audit/probe channel — the ability to spot-check whether agent behavior matches
declared intent (System 3\* in VSM terms), and maturity or quality scoring that would let System
3 detect drift over time.

---

### System 4: The Horizon (Strategic Intelligence)

**Role**: Scans the environment for threats and opportunities. Looks outward and forward —
patterns that are emerging, constraints that are approaching, changes in the wider context that
the operational units cannot see from inside their work.

**Implementation**:

- `src/domain/context/` — workspace context detection. Generates structured descriptions of the
  current project's configuration, active rules, and session state for consumption by AI agents.
- `src/domain/rules/compile/` (`compile-service.ts`) — compiles Minsky's operational rules into
  formats consumed by different AI coding assistants (AGENTS.md, CLAUDE.md, Cursor rules). This
  is orientation infrastructure: it shapes how agents understand the environment before they act.

**Status**: Mostly missing. Context generation and rules compilation exist as orientation
infrastructure. What is absent: cross-project pattern detection (learning from patterns across
multiple codebases), ecosystem scanning (detecting relevant changes in tools, dependencies, or
practices), and any mechanism for feeding environmental intelligence back into operational
decisions.

---

### System 5: The Self (Identity and Policy)

**Role**: Defines what the system is and what it will not compromise. Holds the identity, values,
and policies that remain stable while the environment changes. Arbitrates between System 3
(operational efficiency) and System 4 (strategic adaptation) when they conflict.

**Implementation**:

- `src/domain/configuration/` — hierarchical configuration loading (defaults → project → user →
  environment). The configuration schema defines what a valid Minsky deployment looks like.
  `.minsky/config.yaml` holds project-level policy: which task backend, which repository backend,
  which rules presets are active.
- Rules system (`src/domain/rules/`) — Markdown files with YAML frontmatter that encode
  operational policy. Rules marked `alwaysApply: true` are included in every AI context.
  The rules compilation pipeline propagates policy into agent behavior across all supported
  AI assistants.

**Status**: Built.

---

## Intellectual Lineage

Four thinkers shaped Minsky's architecture. This section names the core contribution of each,
written for engineers not academics. Follow the links for the full treatment.

**Ashby — Law of Requisite Variety**: A regulator cannot suppress disturbances it cannot match
in informational complexity. The corollary for software: you cannot reliably produce quality code
if your quality controls have fewer "channels" than your possible failure modes. Environmental
design — hooks, gates, isolation — is variety attenuation. Each control reduces the space of
possible bad states the system can enter.

**Beer — Viable System Model**: Any autonomous system needs five functional organs: operations,
coordination, operational feedback, environmental intelligence, and identity/policy. Miss one and
the system either oscillates, drifts, or loses coherence over time. Minsky implements these
organs as infrastructure: the session model is System 1, the hook pipeline is System 2, CI is
System 3.

**Boyd — OODA Loop**: The observe-orient-decide-act loop is Boyd's model of how agents navigate
uncertainty. Boyd's key insight is that orientation — making sense of incoming data — is the
decisive step, not action speed. Minsky's context generation (`src/domain/context/`) and rules
compilation (`src/domain/rules/compile/`) are orientation infrastructure: they shape how AI
agents understand the environment before they decide what to do.

**Minsky (Marvin) — Society of Mind**: Intelligence emerges from the coordination of many simple
agents, not from a single complex one. Minsky (the tool) orchestrates simple, well-bounded dev
tools (git, CI, linters, AI coding assistants) into workflows that exhibit intelligent behavior.
No single component is smart; the coordination structure is.

Full treatment: [Notion: Vision & theory](https://www.notion.so/33a937f03cb4815c8394d7fe62d61355)

---

## How Theory Maps to Practice

Four examples showing how a theoretical principle produced a specific implementation decision.

### 1. "Only variety can absorb variety" — Pre-commit hooks

The pre-commit pipeline (`src/hooks/pre-commit.ts`) runs format, lint, typecheck, and test checks
before every commit. Each step attenuates one dimension of possible code quality failure. The
pipeline does not trust memory or intention — it enforces constraints at the moment of action.

The result: code that reaches `git push` has already passed 8 quality gates. Reviewers can focus
on logic and design rather than formatting or type errors. This is variety attenuation implemented
as infrastructure.

### 2. "Maximum autonomy within constraints" — Session isolation

Sessions (`src/domain/session/session-service.ts`) give each work unit its own git clone, branch,
and lifecycle directory. An agent working in a session can make any change it wants — the
environment provides maximum freedom to experiment. But the constraints still apply: pre-commit
hooks run inside the session, PRs require CI and review before merging. Freedom within structure.

The alternative — agents sharing a working directory — would produce coordination overhead that
grows quadratically with the number of parallel agents. Session isolation is the engineering
decision that falls directly out of Beer's System 2 design principle.

### 3. "Recursive structure" — Rules compilation pipeline

The rules compilation pipeline (`src/domain/rules/compile/compile-service.ts`) compiles Minsky's
own operational rules into formats consumed by AI coding assistants: AGENTS.md (Codex), CLAUDE.md
(Claude Code), and Cursor rule files.

This is a recursive control loop: Minsky encodes its own operational policy as rules, then
compiles those rules into instructions that shape the behavior of AI agents working inside
Minsky. The tool shapes the agents that use the tool. This corresponds directly to Beer's
recursive application of the VSM — each level of the hierarchy is itself a viable system.

### 4. "Orientation before action" — Context generation

Before an AI agent acts on a task, it needs to understand the environment: which rules are
active, what sessions are open, what the current project configuration is. Minsky's context
domain (`src/domain/context/`) generates this structured orientation package.

This is Boyd's OODA loop applied to agent coordination: the system invests in orientation
infrastructure so that individual decision cycles are faster and better-calibrated. The agent
doesn't reconstruct context from scratch on every interaction — Minsky provides it.

---

## What's Missing (The Frontier)

The VSM mapping above identifies two significant gaps in the current architecture.

**System 2 — The Mesh**: Cross-session coordination signals and reasoning streams. Currently,
parallel sessions are isolated from each other but cannot observe each other. A complete System 2
would allow concurrent agents to know what other agents are working on — not to block each other,
but to coordinate naturally (avoid editing the same file, recognize when work overlaps). The
reasoning stream would make agent decision-making inspectable by other agents and by human
reviewers.

**System 4 — The Horizon**: Cross-project pattern detection and ecosystem scanning. The current
context generation looks inward (this project, this session). A complete System 4 would look
outward: what patterns appear across multiple projects? What has changed in the ecosystem of tools
and dependencies that Minsky projects depend on? This capability would allow Minsky to detect
drift and opportunity before it becomes visible at the operational level.

Full gap analysis: [Notion: Architecture map](https://www.notion.so/33a937f03cb481e0ae6deb3c37af6ae9)

---

## Companion Principles

Three cross-cutting principles govern how Minsky agents behave within the architecture above. They
are not implementation features — they are posture commitments that shape every design decision.
ADR-007 (Attention-Allocation Subsystem) names and consumes all three. The full position essay
lives in Notion (`34a937f0-3cb4-814b-adba-f2e5cee38c08`).

### Attention as the scarce resource

Minsky is, at its core, an attention-allocation system. Every human-in-the-loop mechanism —
`BLOCKED` states, PR approval gates, the 2-strikes escalation rule, the Agent Inbox, mesh
notifications — is routing a decision to the cheapest resolver available. The operator is the most
expensive resource and therefore the one to conserve. HITL mechanisms are not interruptions to be
minimized; they are routing decisions to be optimized. The right question is never "should we ask
a human?" but "what is the cheapest resolver that can answer this correctly?"

### Humility as a design property

A Minsky agent knows its boundary of delegation and represents it structurally, rather than
collapsing uncertainty into confident action. Preference-bound decisions — naming, framework
choice, tradeoff resolution, scope change, architectural novelty — are not the agent's to make
alone; the system escalates them by construction rather than resolving them under its own
authority. VSM placement: System 5 is the delegate of the principal, not the principal itself.
The operational corollary in `CLAUDE.md §Design Principle: Humility` is an instance of this
principle, not a separate rule.

### Noticing as a structural property

Agents cannot reliably introspect "I should ask here" — Sonnet-class loss rewards confident
answers. Noticing — detecting that a decision belongs to a higher authority — must be built one
recursion level above the agent's own execution loop, not inside it. VSM placement: System 3*
(the audit/probe channel). This is why the System 3* detector (mt#1035) is a sibling to the Ask
subsystem rather than a feature of the agent itself: the agent cannot be trusted to notice its
own blind spots.

---

## Further Reading

- [`docs/architecture.md`](architecture.md) — implementation architecture: command registry,
  domain model, persistence, session lifecycle, rules compilation, DI, configuration, repository
  backends
- [Notion: Vision & theory](https://www.notion.so/33a937f03cb4815c8394d7fe62d61355) — full
  theoretical treatment: Ashby, Beer, Boyd, Minsky; cybernetic foundations; design philosophy
- [Notion: Architecture map](https://www.notion.so/33a937f03cb481e0ae6deb3c37af6ae9) — VSM organ
  analysis, capability inventory, gap analysis
- [Notion: Mesh RFC](https://www.notion.so/33a937f03cb4814f8603ff6faa52ec6b) — design proposal
  for System 2 (cross-session coordination signals and reasoning stream)
- `src/domain/concepts.md` — formal definitions for Repository, Session, Workspace, and URI
  handling
