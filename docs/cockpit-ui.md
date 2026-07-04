# Cockpit UI — operator guide

Operator-facing reference for Cockpit's web surfaces. The architecture reference
(widget contract, VSM placement, subsystem map) lives in
[`docs/architecture/cockpit.md`](architecture/cockpit.md); this guide documents
what each surface is for and how to read it.

## Plant Board (`/plant`)

A single whole-system view: all of Minsky on one board, laid out on the VSM
five-organ skeleton in a process-engineering (P&ID) visual language. Reached via
the **Plant Board** tile on the cockpit home grid, or directly at `/plant`.

Its purpose is comprehension and observability-in-the-felt-sense: see the system's
structure, watch it breathe, and build an intuitive model of its rhythms over time
(the design rationale is task mt#2375).

### The organs

- **S1 · Operations** — the process line: TASKS → READY → SESSIONS → AGENTS → PR →
  REVIEW → DONE, with the CHANGES_REQUESTED recirculation arc.
- **S2 · Coordination** — interlock valves (◇) on the S1 pipe (the hook/guard fleet).
  The fleet's derived count is a badge on the DONE valve — see
  [Slow-clock topology + weld history](#slow-clock-topology--weld-history-mt2602) below.
- **S3 · Management + 3★** — instrument gauges, each drawn with its real alarm setpoint.
- **S4 · Future** — backlog feed tank + deploy loop.
- **S5 · Identity** — rules/decision-defaults canopy and the operator node.
- **Attention seam** — the pink channel coupling the system to the operator
  (ask ↑ / decision ↓).
- **Learning loop** — failure → retrospective → memory → rule → welded interlock.

### Idle-honesty gestures

The board only moves when something is genuinely happening. Three motions exist,
all CSS-driven and all gated by `prefers-reduced-motion` (a reduced-motion user
sees a fully static board):

- **3★ scan sweep** — slow audit sweep across the S1 line (`vsm-scan`, a CSS
  `stroke-dashoffset` animation — deliberately **not** SVG SMIL, so reduced-motion
  disables it).
- **Tank breath** — slow level oscillation on the tanks (`vsm-breath`).
- **Ask pulse** — the seam circle pulses while an ask is pending (`vsm-ask-pulse`).

No motion is ever decorative: a calm system reads calm. (The honest-motion law is
specified in mt#2375.)

### What's real in v1

This is the v1 slice (mt#2376). Exactly **one** level is wired to live data: the
**READY tank** count, fetched from `/api/tasks`. Every other level/gauge is a
clearly-marked placeholder (`—`).

- **v2** (mt#2377) wires the fast-clock dot-motion from the `system_events` log
  (extends mt#2092) so entities visibly move on real transitions.
- **v3** (mt#2378) adds the time-scrubber and the phone vital-signs form factor.

### Slow-clock topology + weld history (mt#2602)

The board's SLOW timescale ("plant grows valves") is real: the S2 valve
inventory and the Learning Loop's interlock count are derived from the live
guard-hook registry (`.claude/hooks/` / `.minsky/hooks/`), not a hardcoded
constant.

- **S2 valve count badge** — the plant keeps its 4 fixed positional valves
  (one per hook would be unreadable at the real hook count, currently
  ~48); the DONE valve instead shows a small **`N interlocks`** badge with
  the derived total. Before the first slow-clock sweep completes, the badge
  is honestly absent rather than showing a fabricated zero.
- **Weld history** (`/plant/weld-history`, reached via the Learning Loop
  node's "weld history →" link) — a table of every derived interlock with:
  its **install date** (from `git log`, oldest add-commit per hook file),
  a **commit link** to GitHub, and — where derivable — the **originating
  `retrospective.fired` event** (mt#2537) that produced it. Retrospective
  correlation is two-tier: an exact match on the task ref parsed from the
  install commit's subject (`type(mt#N): ...`), falling back to the nearest
  preceding retrospective within a 14-day window. Neither match renders
  "unknown" — never a guessed link.
- **Cadence** — derivation (a bounded `git log` read + a DB query) runs
  server-side at cockpit boot and on an hourly-class sweep; the widget never
  spawns git or queries the DB per request. A new hook merged to main
  appears on the board within one such refresh.

### Tokens

The seven VSM organ colors are cockpit-local OKLCH tokens (`--vsm-s1` … `--vsm-learn`)
defined in `src/cockpit/web/index.css` and documented in
[`docs/brand-system.md`](brand-system.md) §2. They follow the brand system's
semantic-token discipline — no raw hex on the surface.

## Operator endpoints

### `GET /api/health`

The cockpit daemon exposes a lightweight health endpoint at
`GET http://localhost:3737/api/health`. Useful for scripts, uptime monitors, and
the tray app's health poll:

```json
{
  "status": "ok",
  "db": "ok"
}
```

The `db` field tracks the persistence-layer state (gh#1761):

| Value           | Meaning                                                                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"ok"`          | DB connection is healthy; all persistence-backed widgets and endpoints work.                                                                                                                                                                                                                          |
| `"degraded"`    | At least one DB init attempt failed (circuit breaker tripped, connection timeout, etc.). The daemon stays up and serves the UI; widgets that need DB fall back gracefully. A background retry loop is running — see `docs/persistence-configuration.md §Cockpit daemon: circuit-breaker degradation`. |
| `"unreachable"` | No connection attempt has been made yet (initial state at boot, or after a singleton reset).                                                                                                                                                                                                          |

When `db` is `"degraded"` the daemon **does not restart** — it continues serving the
UI and re-attempts the DB connection every 30 s in the background. The tray app's
health indicator reflects the `db` field in addition to overall HTTP reachability.

## Cross-references

- mt#2375 — Plant Board design (the living plant; four timescales; honest-motion law)
- mt#2376 — v1 slice (this surface) · mt#2377 — v2 motion · mt#2378 — v3 scrubber/phone
- mt#2602 — slow-clock topology auto-derivation + weld history
- [`docs/architecture/cockpit.md`](architecture/cockpit.md) — cockpit architecture reference
- [`docs/brand-system.md`](brand-system.md) — tokens, motion budget, `prefers-reduced-motion`
