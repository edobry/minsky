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
 * Pure data + pure functions, no imports — safe to import from the domain and
 * adapter layers, the cockpit Express route, AND the Vite-bundled cockpit web
 * UI (the launch picker), which resolves it as a runtime import from
 * `@minsky/domain`. It lives in the domain package because `packages/domain`
 * consumes it and must not import from a UI tree (mt#3043); the sibling
 * precedent for a module shared across both surfaces is
 * `src/cockpit/web/lib/entity-codec.ts`.
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

/**
 * Reverse lookup (mt#3070): map a FULL model id — the shape persisted in
 * `agent_transcripts.model` / `subagent_invocations.actual_model` (e.g.
 * `"claude-sonnet-5"`) — to its registry short label (`"Sonnet"`).
 *
 * Returns `undefined` for an id with no matching `canonicalId` (an older
 * dated model id, a provider id outside this registry, or a future tier not
 * yet added here) — callers render the raw id in that case rather than
 * guessing at a label.
 */
export function dispatchModelLabelForCanonicalId(canonicalId: string): string | undefined {
  return DISPATCH_MODELS.find((m) => m.canonicalId === canonicalId)?.label;
}

/**
 * The harness-generated retry sentinel Claude Code records in place of a real
 * model (mt#3260). Never a tier, and never rendered as one.
 *
 * **This is the one declaration of the literal (mt#4237).** It was hand-copied
 * into three modules until then, with nothing checking they agreed — and the
 * drift would have been silent in both directions: a module still holding the
 * old spelling does not throw, it just stops recognizing retry turns, so
 * {@link modelTierLabel} would hand a harness retry a tier and the cockpit
 * would render it as though a model spoke.
 *
 * It lives HERE rather than in `packages/shared` — where cross-boundary facts
 * normally go — because this module's "no imports" property (see the file
 * docblock) is load-bearing, and consuming the constant from anywhere else
 * would force an import and break it. Everything else imports from here:
 * `../subagent/transcript-metrics.ts`, `../transcripts/agent-transcript-ingest-service.ts`,
 * and the cockpit web tree, which may because `@minsky/domain/ai/dispatch-models`
 * is on `eslint.config.js`'s cockpit import allowlist.
 */
export const SYNTHETIC_MODEL_SENTINEL = "<synthetic>";

/**
 * TIER label for an arbitrary recorded model id — `"claude-opus-5"` → `"Opus"`.
 *
 * Distinct from {@link dispatchModelLabelForCanonicalId}, which matches
 * `canonicalId` EXACTLY and is right for "which registry row is this", and
 * wrong for "what should a reader see". The registry pins one dated id per
 * tier, so its exact match answers `undefined` for every id that is not the
 * currently-pinned build — including, as of 2026-08-17, every model in the
 * local transcript corpus: all 15,304 sampled assistant blocks record
 * `claude-opus-5` while the registry's opus row pins `claude-opus-4-8`.
 *
 * A display path that resolves through exact match therefore renders a raw
 * dated id, and goes stale again at the next model bump — which is why this
 * reads the TIER out of the id instead of enumerating builds. The registry is
 * still consulted first, so an id it pins keeps its curated label.
 *
 * Returns `undefined` for an unrecognized id, a missing one, and for the
 * synthetic-retry sentinel. Callers render NOTHING in that case — never a
 * guessed default, per the honest-degradation requirement in mt#3845 SC1
 * (ask#7348, principal-selected 2026-08-08).
 */
export function modelTierLabel(model: string | null | undefined): string | undefined {
  if (typeof model !== "string") return undefined;
  const id = model.trim();
  if (id.length === 0 || id === SYNTHETIC_MODEL_SENTINEL) return undefined;

  const pinned = dispatchModelLabelForCanonicalId(id);
  if (pinned !== undefined) return pinned;

  // Tier extraction. Anchored at a segment boundary rather than a bare
  // substring so a future id that merely CONTAINS a tier word (a fine-tune
  // slug, a vendor prefix like `us.anthropic.claude-…`) still resolves on its
  // real tier segment and nothing else can smuggle one in.
  const match = /(?:^|[./-])claude[./-](opus|sonnet|haiku|fable)(?:$|[./-])/i.exec(id);
  const tier = match?.[1]?.toLowerCase();
  if (tier === undefined) return undefined;

  return DISPATCH_MODELS.find((m) => m.id === tier)?.label;
}
