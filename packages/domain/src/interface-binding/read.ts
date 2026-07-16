/**
 * Read-side defaulting for `SessionRecord.interfaceBinding` (mt#1628).
 *
 * The correlator (`./iterm-correlator.ts`) only ever WRITES a binding for a
 * session it actually classified this pass; a session that has never been
 * observed (hosted Minsky, non-darwin local Minsky, or simply "the
 * correlator hasn't run yet") has `interfaceBinding: undefined` in storage.
 * The MCP query surface's contract, though, is that `session_get` always
 * reports a concrete `surface_kind` — "hosted-Minsky sessions report
 * `surface_kind: unbound`" (spec Success Criteria) — so the read path fills
 * in an explicit `unbound` default rather than leaving the field absent.
 * This keeps storage sparse (no need to backfill every existing session row)
 * while keeping the read contract total.
 */
import type { InterfaceBinding } from "./types";

/**
 * Structural (not `Pick<SessionRecord, ...>`-derived) input shape,
 * deliberately: both `SessionRecord` (all three fields optional except
 * `createdAt`, which IS required there) and the external-facing `Session`
 * type (where `createdAt` is ALSO optional) need to satisfy this — a
 * `Pick<SessionRecord, ...>` would reject `Session` callers because
 * `Session.createdAt?: string` doesn't satisfy `SessionRecord.createdAt: string`.
 */
export interface InterfaceBindingSource {
  interfaceBinding?: InterfaceBinding;
  lastActivityAt?: string;
  createdAt?: string;
}

/**
 * Resolve the `InterfaceBinding` to report for a session record: the stored
 * value if present, otherwise a synthesized `unbound` default. Never
 * mutates or persists anything — pure read-time defaulting.
 */
export function resolveInterfaceBinding(record: InterfaceBindingSource): InterfaceBinding {
  if (record.interfaceBinding) return record.interfaceBinding;
  return {
    kind: "unbound",
    lastObservedAt: record.lastActivityAt ?? record.createdAt ?? new Date().toISOString(),
  };
}
