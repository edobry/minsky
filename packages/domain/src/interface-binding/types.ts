/**
 * Interface-binding domain types (mt#1628 — iTerm-tab binding v0).
 *
 * v0 slice of the broader `InterfaceBinding` concept mt#1506 is designing.
 * Deliberately hardcodes the surface-kind union to the two values v0 needs —
 * `"iterm-tab"` and `"unbound"` — rather than the full polymorphic enum
 * (`vscode-window`, `claude-desktop`, `autonomous-loop`, `ci-runner`, ...)
 * mt#1506's ADR will define. Generalizing this union is explicitly out of
 * scope for this task; see mt#1628's spec "Out of scope" list.
 */

/** Surface kinds this v0 slice can classify a session into. */
export type SessionSurfaceKind = "iterm-tab" | "unbound";

/**
 * A session's classified operator-interface binding.
 *
 * `surfaceId` is present only for a bound surface (currently: an iTerm2
 * `TERM_SESSION_ID`, e.g. `w0t0p0:5B3F...`) and absent for `unbound`.
 * `lastObservedAt` is always present — it is the timestamp of the
 * correlation pass that produced this classification (or, on the read path
 * when no pass has ever run for a session, a value derived from the
 * session's own activity timestamp — see `resolveInterfaceBinding` in
 * `./read.ts`).
 */
export interface InterfaceBinding {
  kind: SessionSurfaceKind;
  surfaceId?: string;
  lastObservedAt: string; // ISO-8601
}

/** All surface kinds this v0 slice recognizes — for validation/docs use. */
export const SESSION_SURFACE_KINDS: readonly SessionSurfaceKind[] = ["iterm-tab", "unbound"];
