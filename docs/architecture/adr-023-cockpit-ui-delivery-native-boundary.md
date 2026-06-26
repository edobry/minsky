# ADR-023: Cockpit UI delivery and the native-integration boundary

## Status

Accepted (principal sign-off 2026-06-26 — keep the daemon-side PTY + WebSocket transport; the
Rung 3 cloud-cockpit direction is confirmed live, which is the portability reason for that
choice). Originally Proposed pending principal sign-off on the cockpit product surface, adjacent
to the principal-reserved lifecycle decisions in the mt#2230 harness-host program.

## Context

The `cockpit-tray` app (Tauri v2, macOS menu-bar shell; part of the mt#2230 harness-host
program) hosts the cockpit UI in a window that loads `WebviewUrl::External("http://localhost:3737")`
— the live, daemon-served SPA (`cockpit-tray/src-tauri/src/main.rs`, `COCKPIT_URL`) — rather than
bundling the SPA into the `.app`. The same SPA is reachable in an ordinary browser at that URL.

Tauri's security model trusts exactly one origin by default: the bundled app origin
(`tauri://localhost`). Only a trusted origin receives the IPC bridge — the `invoke()` channel and
plugin JS bindings (`onOpenUrl`, notification, dialog, fs, …). An external-origin webview (our
`http://localhost:3737`) is untrusted: no IPC, no plugin JS bindings, unless trust is explicitly
extended to it via a `remote` capability (`remote.urls`). Note that `app.withGlobalTauri: true` in
`tauri.conf.json` injects the `window.__TAURI__` object but does **not** grant the IPC bridge to an
external origin — the trust boundary is unchanged. Consistent with this, the codebase drives that
webview only through Rust-side `window.eval(...)`, and the SPA (`src/cockpit/web/`) contains zero
`@tauri-apps/*` imports.

This boundary surfaced concretely in mt#2528 (the `minsky://` deep-link handler): the natural Tauri
pattern — an `onOpenUrl` JS listener in the SPA — cannot fire, because the SPA is an untrusted
external origin. The forcing question is broader than deep-links: should the cockpit SPA become a
trusted Tauri frontend so it can originate native calls, and if so, how?

Options weighed:

1. **Status quo — external-URL, untrusted SPA, daemon-as-seam.** SPA↔native data flows through the
   daemon (HTTP + the existing `/api/events` SSE stream); native→SPA actions (navigate/focus) go
   through Rust→webview `eval`. One transport; cloud-portable by construction.
2. **Bundle + transport shim** (the community-canonical "dual-mode" pattern). Bundle the SPA into
   the `.app` (trusted frontend, full IPC) and maintain a `backend.ts` abstraction
   (`isTauri ? invoke() : fetch()`) so the same SPA also runs in a browser.
3. **Grant the SPA origin Tauri IPC.** Keep the external URL but add a `remote` capability for the
   daemon origin, making the daemon-served SPA a trusted origin. (Scoping the capability to
   `127.0.0.1:3737` would be illusory: the daemon binds all interfaces, so the same SPA is served to
   LAN clients at the host's address — see the security-calibration driver below and mt#2538. A
   bundled-SPA-over-localhost variant via `tauri-plugin-localhost` was also considered and dropped:
   Tauri's own docs flag it as carrying "considerable security risks," and being bundled it gives no
   browser parity — option 2's parity loss without its secure default.)

Decision drivers:

- **Browser/cloud parity is strategically load-bearing, not a dev convenience.** The harness-host
  program (mt#2230) builds toward Rung 3 (mt#2238): a cloud cockpit that drives the local agent
  over a relay, where "the UI location is irrelevant; the credential and binary stay local; the
  daemon is the seam." The cockpit must run as a pure web app reachable remotely.
- **The roadmap's native features do not require the SPA to originate native calls.** They are
  inherently Rust-side OS integration where the data flow is native→SPA: URL-scheme registration
  (mt#2528), native notifications (mt#2306), dock/menu, auto-update (mt#2201), window focus/raise
  (mt#2285). The recurring SPA-touching need is native code navigating/focusing the SPA —
  Rust→webview, not SPA→native. (The one apparent counterexample — driving a `claude` session over
  a PTY, mt#2237 — is examined under Consequences; given the Rung-3 commitment it too lands
  daemon-side, not as SPA→native IPC.)
- **Security calibration on option 3.** The daemon currently binds **all interfaces**
  (`app.listen(port)` with no host in `src/commands/cockpit/start-command.ts` → Express defaults to
  `0.0.0.0`) with no auth, CORS, or CSP (tracked separately as mt#2538). Granting the SPA origin
  native IPC (option 3) would expose the native API surface to that network-reachable,
  unauthenticated origin — materially worse than a bundled frontend, whose trusted content is
  local-only. CVE-2024-35222 (cross-origin iframe IPC-bypass) is patched in our Tauri (2.11.2), but
  the network-reachability concern stands on its own.

## Decision

We will keep the cockpit SPA as a **Tauri-untrusted, daemon-served external-URL client** (option 1).
Native↔SPA integration uses two seams: **the daemon** for all data and command flow (HTTP + SSE),
and **Rust→webview `eval`** for native→SPA actions (navigation, focus). We will **not** bundle the
SPA into the `.app` (option 2) and will **not** grant the SPA Tauri IPC via a `remote` capability
(option 3). OS-integration features that can only be native are implemented Rust-side and driven by
OS or daemon events; none requires the SPA to be trusted.

For the recurring native→SPA case (e.g., deep-link navigation, mt#2528): the Rust handler performs
the native action (show + focus the window) and forwards the target to the SPA by `eval`-ing a small
SPA-exposed global — `window.eval("window.__minskyDeepLink(" + JSON.stringify(uri) + ")")`. The
payload **must** be JSON-encoded, never raw string-interpolated: a crafted `minsky://` URL is
otherwise a script-injection vector. The global reuses the in-SPA codec and router; the codec stays
single-sourced in TypeScript and Rust does not parse or fork it.

Option 3 is rejected on two independent grounds. First, it is **unnecessary** — the SPA does not
need to originate native calls (see drivers). Second, were that to change, it would be **dominated**
by option 2: any direct Tauri-IPC use in the SPA breaks when the same SPA runs in a browser or the
Rung-3 cloud cockpit, forcing a `backend.ts` shim anyway — but without bundling's secure default,
and over a network-reachable origin.

## Consequences

Easier:

- The cockpit SPA stays uniform across every delivery surface (tray webview, local browser, Rung-3
  cloud cockpit): one codebase, one transport, no `isTauri` branching. Rung 3 requires this
  uniformity.
- In-tray hot reload is preserved (web change → daemon rebuild/restart → window refresh; no `.app`
  rebuild).
- Secure-by-default native posture without a `remote` capability: the webview holds no native
  powers, so an XSS or supply-chain issue in the SPA cannot reach native APIs (it remains a
  data-exposure issue — see the harder list).
- New native→SPA needs reuse a single established seam (Rust `eval` of an SPA global).

Harder / committed:

- The SPA cannot use Tauri plugin JS bindings directly. Any native capability the SPA appears to
  "want" must be re-expressed as a daemon endpoint or a Rust-driven action. Deliberate constraint.
- Native→SPA bridging is `eval`: payloads must be JSON-encoded (above), and cold-start navigation
  timing must be handled — the webview fires its load event before the SPA router is mounted, so the
  Rust side queues the target and the SPA global consumes the queued value on mount, rather than
  relying on the webview load event alone.
- **Implication for mt#2237 (Rung 2 PTY) — this ADR now decides the transport family; mt#2237 owns
  the implementation.** Driving a session means hosting a PTY around the genuine `claude` binary and
  streaming it to a terminal view. mt#2237's earlier scope named `portable-pty` (a Rust crate) +
  xterm.js, which leans toward a Tauri-native terminal (Rust PTY ↔ SPA over Tauri IPC) — which would
  require trusting the frontend (contradicting this ADR) and would have to be rebuilt at Rung 3,
  where the cloud UI and the PTY are on different machines and the transport must be a network
  protocol. The standard browser-terminal architecture (server-side PTY + WebSocket: VS Code Server,
  code-server, ttyd) already matches the daemon-as-seam model. With the 2026-06-26 principal sign-off
  (Status above) confirming Rung 3 as a live direction, **this ADR decides the transport family:
  daemon-side PTY streamed over WebSocket, not a Tauri-native PTY over IPC.** mt#2237 still owns the
  implementation specifics — the PTY library, the WebSocket protocol/framing, auth, and the
  `stream-json` delta layer — and must still run its `/plan-task` gate (l) (community-practice check
  against ttyd / code-server / VS Code Server); the daemon-side-over-WebSocket family is no longer
  open.
- The daemon is currently network-reachable and unauthenticated (mt#2538). This ADR's "daemon as the
  integration seam" framing raises the stakes on that gap; mt#2538 owns the bind/auth fix, and the
  deep-link `eval` seam additionally argues for a CSP on the SPA's HTML responses (also mt#2538).
- **Revisit trigger.** If a future feature genuinely requires the SPA to _originate_ native calls
  that are not cloud-portable (native drag-out, a native file-save dialog from SPA UI), revisit —
  concretely, when ≥2 such needs accumulate. Separately, if the Rung-3 cloud-cockpit direction is
  abandoned, the portability argument that forces daemon-side PTY falls away; in that case
  reconsider mt#2237's PTY hosting on its own merits (the Tauri-native path becomes viable again).
  Abandoning Rung 3 does not, by itself, make option 2 preferable for the rest of the SPA.

## Cross-references

- Related ADRs: ADR-014 (cockpit-daemon lifecycle ownership) — sibling cockpit-tray decision.
  ADR-014 governs _daemon lifecycle_; this ADR governs _UI delivery and trust_. Orthogonal; both
  apply.
- Related tasks: mt#2528 (deep-link handler — surfaced this decision), mt#2517 (deeplinks umbrella),
  mt#2230 (harness-host program — strategic frame; its lifecycle-ADR slot is a distinct decision),
  mt#2238 (Rung 3 cloud cockpit — the parity requirement), mt#2237 (Rung 2 PTY — the
  constrained-but-separate decision), mt#2306 (native notifications), mt#2201 (signing /
  auto-update), mt#2285 (raise terminal — native focus), mt#2538 (daemon bind/auth/CSP gap surfaced
  by this ADR's review).
- Tauri references: [Capabilities](https://v2.tauri.app/security/capabilities/) (the `remote` trust
  mechanism), [Configuration](https://v2.tauri.app/reference/config/) (`frontendDist` / external
  URL), [localhost plugin](https://v2.tauri.app/plugin/localhost/),
  [CVE-2024-35222 / GHSA-57fm-592m-34r7](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7)
  (iframe origin-check bypass; patched in our 2.11.2).
