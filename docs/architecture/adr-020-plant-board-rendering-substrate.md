# ADR-020: Plant Board Rendering Substrate — Node-Link Canvas under High-Performance HMI

## Status

Accepted (2026-06-12 — substrate convergence, mt#2423). The operator compared all
three routes live and picked the node-link board. The SVG schematic and CSS
panel-grid comparison routes are retired (sources in git history); `/plant` now
serves the node-link board, and the old paths redirect. The operator's
acceptance carries one caveat: the node-link board must regain the SVG board's
instrument-style metric representations (S2 valves, vessel tanks, memory
reservoir, seam line, scan sweep, legend) — tracked as mt#2466.

## Context

The cockpit whole-system view (mt#2375) is a live schematic of all of Minsky rendered on
the VSM five-organ skeleton: five organs, a lifecycle spine, an attention seam, a learning
loop. The view must fill an arbitrary-aspect viewport responsively, maintain spatial
stability as a "memory palace" operators internalize, carry relational legibility
(flow between organs), and serve as the substrate for v2 honest-motion dots-through-pipes.

**Two prior approaches hit complementary ceilings:**

### Alternative 1: Single SVG schematic (`/plant`, mt#2376/2380/2383/2387)

The SVG schematic renders the full plant in one fixed-aspect SVG `viewBox` (initially 1280×840).

Strengths: native continuous-flow substrate; relational legibility is intrinsic to SVG paths;
living-plant aesthetic; SVG dots-on-edges for v2 motion requires no extra layer.

Ceiling: a fixed-aspect `viewBox` with `preserveAspectRatio` cannot fill an
arbitrary-aspect container without distorting the layout or introducing letterbox voids.
At tall-narrow viewport configurations the schematic letterboxes into large dead regions.
After four implementation attempts (mt#2376, mt#2380, mt#2383, mt#2387) this was confirmed
as a structural ceiling, not an implementation gap: the geometry is overconstrained.

### Alternative 2: CSS panel grid (`/plant-grid`, mt#2388)

The CSS grid layout renders each organ as a rich HTML panel; the grid engine fills the
container responsively at any aspect ratio.

Strengths: responsive fill; data density per panel; organ add/remove without repositioning;
reuses existing cockpit widget components inside panels.

Ceiling: discrete tiles lose the continuous-flow substrate — v2 dots-on-edges would require
a separate cross-panel SVG overlay layer, and visual reflow breaks spatial stability
(organs shift positions at breakpoints). The result reads as a tile dashboard, not a
connected system. The schematic aesthetic — the thing that makes the plant feel like an
organism — does not survive the transition.

### Research synthesis (memory `82c7a58e-3917-4cf3-8b7c-9a488c28e846`)

Research on 2026-06-09 examined three bodies of prior art:

**ISA-101 / High-Performance HMI** (process-control industry practice, decades of field use):
ISA-101 explicitly abandoned literal P&ID schematics as "congested and confusing, without
sufficient emphasis on the information operators actually need." The recommended substitute
is a node-link diagram with embedded live data, a calm baseline (grayscale at rest),
color reserved for alarm states, and a four-level drill-down hierarchy
(overview → subsystem → equipment → diagnostics). ISA-101 reports 48% improvement in
abnormal-situation detection against the calm baseline.

**Tufte**: Layering and separation (relational layer distinct from data layer), small
multiples (consistent mini-charts per entity in context), micro/macro readings (overview
and detail in one surface), sparklines as data-ink-ratio-maximizing trend indicators.

**Shneiderman's information-seeking mantra**: "Overview first, zoom and filter, details on
demand." Semantic zoom gives macro legibility at the overview level and density on
zoom-in — the interaction-layer answer to the density-vs-legibility tension.

### The convergence: node-link canvas

A node-link canvas with rich HTML nodes and SVG edges threads both needles:

- **Nodes = React components** — each organ is a dense HTML panel. Data density, widget
  reuse, and responsive layout inside each panel are all available (the grid's win).
- **Edges = SVG paths** — the inter-organ pipes/flow are native SVG geometry. Relational
  legibility is intrinsic; animated edges (`animated` prop) give v2 dots-on-edges without
  an overlay layer (the schematic's win).
- **Built-in pan/zoom + auto-layout** — the canvas fills and reflows at any aspect ratio
  while preserving the spatial layout (the schematic's spatial stability via fixed node
  positions; the grid's responsive fill via pan/zoom).

`@xyflow/react` (https://github.com/xyflow/xyflow) is purpose-built for this pattern.
Gate-(k) verification (license, maintenance, install, canonical URL):

- **License:** MIT.
- **Maintenance:** Active — 37 k GitHub stars; latest release v12.11.0 (2025).
- **Install:** `bun add @xyflow/react` → `@xyflow/react@12.11.0`.
- **Canonical URL:** https://reactflow.dev/ / https://github.com/xyflow/xyflow.

## Decision

We will render the plant board as a **node-link canvas** using `@xyflow/react` — organs as
custom rich HTML nodes, inter-organ relationships as animatable SVG edges — on a pan/zoom
canvas with a fixed initial node layout. The route `/plant-flow` implements this substrate
in parallel with `/plant` (SVG schematic) and `/plant-grid` (CSS panel grid) for side-by-side
operator comparison. A later ADR will retire the two comparison routes once the operator
chooses a winner.

### The HMI-bones / lush-skin stance (load-bearing design principle)

This decision adopts ISA-101's **information architecture** but **not** ISA-101's aesthetic:

**Adopt from HMI:**

- Node-link topology (organs as named stations, edges as directed flow paths).
- Embedded live data in context — counts, gauges, sparklines inside each node, not
  in a separate panel.
- Overview → drill-down hierarchy per Shneiderman: macro schematic at the canvas level,
  per-organ detail on zoom-in or click-through.
- Anomaly-pop discipline: deviations break the visual harmony, making them immediately
  salient.

**Reject from HMI:**

- Grayscale baseline. The cyberbrain/Section-9 aesthetic of the Minsky brand (per the
  `minsky-brand` skill and `docs/brand-system.md`) is dense, lush, and ornate — not sterile.
  The operator derives aesthetic pleasure and a sense of system identity from the richness
  of the view.

**Synthesis — "coherent rich field at rest, deviation breaks the harmony":**
HMI's "grayscale at rest, color on alarm" is reinterpreted as: the resting state is a
rich, coherent, harmonious field using the full VSM organ palette
(`--vsm-s1` teal, `--vsm-s2` amber, `--vsm-s3` cyan, `--vsm-s4` purple,
`--vsm-seam` pink, `--vsm-learn` emerald). Anomalies pop **against lushness** rather than
against gray — a deviation that would be "the one colored thing against gray" in HMI is here
"the element that breaks the harmony of the field." This preserves the ISA-101
situational-awareness benefit (anomaly salience) while keeping the brand aesthetic intact.

The lush-but-legible discipline must be enforced **per node**: each organ panel must be
coherent and readable, not cluttered. Data-ink ratio (Tufte) applies at the node level.

## Consequences

### Easier

- **Responsive fill** without letterboxing: the pan/zoom canvas fills any aspect ratio;
  the fixed node layout provides spatial stability (the memory-palace property).
- **Native flow substrate**: `@xyflow/react` edges are SVG paths; animated edges
  (`animated: true`) give v2 honest-motion dots-on-edges at zero extra architecture cost.
- **Drill-down**: react-flow's `onNodeClick` and `onNodeDoubleClick` are the
  interaction surface for Shneiderman's overview→detail navigation.
- **Component reuse**: existing cockpit widget logic (gauges, sparklines, tank levels,
  the `useReadyCount` hook) composes into node panels without adaptation.
- **Auto-layout optional**: dagre or elk can replace the fixed layout for future topology
  derivation (slow-clock auto-topology, mt#2375 v3).

### Harder / newly committed

- **A graph-layout dependency to own**: `@xyflow/react` is a new runtime dependency.
  Its API surface (especially `ReactFlowProvider`, node typing, edge typing) must be
  understood by any future cockpit engineer.
- **Lush-but-legible discipline**: the per-node density decision (how much data to show
  at rest vs on zoom) is design work that must be enforced each time a new organ is added.
  The panel-grid's approach (every organ gets equal panel space) is simpler to maintain.
- **`prefers-reduced-motion`**: animated edges must be disabled under the reduced-motion
  media query; this is a per-edge concern, not automatic.
- **The two comparison routes remain alive** until the operator chooses; three parallel
  implementations add maintenance surface.

### Routes

- `/plant` — **the node-link canvas board (this ADR)** — canonical since the
  mt#2423 convergence.
- `/plant-grid`, `/plant-flow` — retired comparison routes; both redirect to
  `/plant`. Pre-retirement sources recoverable from git history.

## Cross-references

- **ADR-019** — Transcript pipeline staging (sibling; illustrates the Michael-Nygard format).
- **mt#2375** — Cockpit whole-system view (parent task; v1/v2/v3 phased plan).
- **mt#2376 / mt#2380 / mt#2383 / mt#2387** — SVG-schematic implementation line.
- **mt#2388** — CSS panel-grid implementation.
- **mt#2389** — This ADR and the `/plant-flow` prototype (implementation task).
- **mt#2423** — Substrate convergence (this ADR's acceptance; route retirement).
- **mt#2466** — Instrument-parity port (the acceptance caveat's tracking task).
- **Memory `82c7a58e-3917-4cf3-8b7c-9a488c28e846`** — Thread-the-needle research
  (Tufte, ISA-101 HMI, Shneiderman, react-flow).
- **`docs/brand-system.md`** — Token palette (VSM organ colors, typography, motion budget).
- **`minsky-brand` skill** — Brand register (cyberbrain/Section-9 aesthetic frame).
- **`@xyflow/react`** — https://github.com/xyflow/xyflow (MIT, v12.11.0, 37k stars).
