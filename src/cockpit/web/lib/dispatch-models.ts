/**
 * Dispatchable-model registry (mt#3040) — the canonical source of truth for
 * "which models a principal can launch a driven session on" from the cockpit.
 *
 * Deliberately DISTINCT from `packages/domain/src/ai/model-catalog.ts`, which
 * answers a different question (provider API model ids like `gpt-4o` for the
 * AI-completion/provider service). This registry names the harness dispatch
 * TIERS the genuine `claude` binary accepts via `--model <alias>`. The two
 * catalogs share no ids; a new registry is the right structural choice, not a
 * repurposing of the provider catalog (mt#3040 spec §Implementation notes —
 * introduce, not extend).
 *
 * Pure data + pure functions, no imports — safe to import from BOTH the
 * Vite-bundled web UI (the launch picker) and the Express route (validation),
 * mirroring `entity-codec.ts`'s both-sides-shared placement in this directory.
 */

export interface DispatchModel {
  /** Stable id — the `<select>` value and the wire value in the launch request. */
  id: string;
  /** Human-readable label shown in the picker. */
  label: string;
  /**
   * The value passed to `claude --model <arg>`. The short tier alias (not the
   * dated full id) so a launch always resolves to the latest build of the tier
   * — matches the harness Agent-spawn `model` vocabulary and is robust to
   * version bumps.
   */
  modelArg: string;
  /**
   * The current canonical full model id for this tier, for documentation and
   * telemetry cross-reference (the post-hoc `modelUsage` / `actualModel`
   * surface reports full ids). NOT passed to `--model`; `modelArg` is.
   */
  canonicalId: string;
}

/**
 * The launchable tiers, in escalation order. `fable` is the strongest; a
 * principal picks it for a task whose difficulty warrants it (the originating
 * mt#3040 use case: "this one needs Fable").
 */
export const DISPATCH_MODELS: readonly DispatchModel[] = [
  { id: "sonnet", label: "Sonnet", modelArg: "sonnet", canonicalId: "claude-sonnet-5" },
  { id: "opus", label: "Opus", modelArg: "opus", canonicalId: "claude-opus-4-8" },
  { id: "haiku", label: "Haiku", modelArg: "haiku", canonicalId: "claude-haiku-4-5-20251001" },
  { id: "fable", label: "Fable", modelArg: "fable", canonicalId: "claude-fable-5" },
] as const;

/**
 * The default launch model when the principal expresses no preference. Sonnet
 * matches the pre-mt#3040 subagent-routing default (the model the CLI would
 * otherwise resolve to) — the override slice changes what the principal CAN
 * pick, not the default they get when they don't (mt#3040 §Decision).
 */
export const DEFAULT_DISPATCH_MODEL_ID = "sonnet";

/** Type guard: is `v` a recognized dispatch-model id? */
export function isDispatchModelId(v: unknown): v is string {
  return typeof v === "string" && DISPATCH_MODELS.some((m) => m.id === v);
}

/**
 * Resolve a dispatch-model id to its `claude --model` argument. Returns
 * `undefined` for an unrecognized id — callers reject rather than silently
 * falling back to a default the principal didn't pick.
 */
export function resolveDispatchModelArg(id: string): string | undefined {
  return DISPATCH_MODELS.find((m) => m.id === id)?.modelArg;
}
