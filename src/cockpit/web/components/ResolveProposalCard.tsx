/**
 * The confirm step for an agent-proposed ask resolution (mt#3368, parent mt#3363).
 *
 * Renders a proposal the thread agent made (see `../lib/resolve-proposal.ts`) as
 * the PRE-FILLED form of the resolve action, showing the operator the exact
 * payload that will be committed before anything is.
 *
 * ## What the confirm step guards, and what it does not
 *
 * It guards THIS surface: a prose exchange in a thread cannot become a committed
 * typed payload without the operator seeing it and clicking. That is a real
 * guarantee about the panel.
 *
 * It is NOT containment of the agent. A thread agent spawns with the full Minsky
 * MCP surface and holds `asks_respond` directly, so it does not need this button
 * to resolve an ask and this button cannot stop it. That risk was surfaced to
 * the principal and accepted; the decision and its full option set live in
 * mt#3435. Do not describe this control as containment.
 *
 * @see mt#3368 — this component
 * @see mt#3435 — the accepted risk this does NOT mitigate
 * @see mt#3233 — the auto-resolve incident that motivated a confirm step at all
 */
import { Card, CardContent } from "./ui/card";
import { PendingButton } from "./PendingButton";
import { ErrorState } from "./ErrorState";
import { stripOptionLetterPrefix } from "@minsky/shared/ask-option-label";
import { composeResolvePayload, type AskItem } from "../widgets/AskDetail";
import type { ResolveProposal } from "../lib/resolve-proposal";

/** Names this surface in the resolve payload's attention accounting. */
export const RESOLVE_PROPOSAL_SURFACE = "thread";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The option a proposed letter actually refers to on this ask, or `null` when
 * the letter names no option.
 *
 * Range-checking BEFORE composing is load-bearing: `composeResolvePayload` falls
 * back to `""` for an out-of-range index, which is precisely the silent
 * empty-selection shape mt#3181 fixed one layer down (an ask closed as answered
 * with no record of WHICH option was picked). Handing it an unvalidated
 * model-authored letter would reintroduce that at a new callsite.
 *
 * Mirrors `AskDetail`'s own option-count derivation: an explicit `options` array
 * when present, otherwise the implicit two-option (A/B) shape that
 * `authorization.approve` and `quality.review` asks carry.
 */
export function resolveProposalOption(
  ask: Pick<AskItem, "options" | "kind">,
  optionLetter: string
): { index: number; label: string } | null {
  const index = optionLetter.charCodeAt(0) - "A".charCodeAt(0);
  if (index < 0 || index >= LETTERS.length) return null;

  if (ask.options && ask.options.length > 0) {
    const option = ask.options[index];
    if (!option) return null;
    return { index, label: stripOptionLetterPrefix(option.label) };
  }

  const implicitTwoOption = ask.kind === "authorization.approve" || ask.kind === "quality.review";
  if (!implicitTwoOption || index > 1) return null;
  return { index, label: index === 0 ? "Approve" : "Deny" };
}

export interface ResolveProposalCardProps {
  ask: AskItem;
  proposal: ResolveProposal;
  /** Commit the proposal. Must route into the SAME resolve path the detail
   * panel's own option buttons use — one resolve path, not two. */
  onConfirm: (optionLetter: string) => void;
  /** True while a resolve/defer/escalate is already in flight. */
  disabled: boolean;
  /**
   * True while THIS card's own confirm is the request in flight (mt#4503).
   *
   * Distinct from `disabled`, which is also true when the detail panel's option
   * buttons are the ones saving. Only the control the operator actually clicked
   * should claim to be working.
   */
  confirming?: boolean;
  /** The confirm's failure, when it failed (mt#4503). */
  error?: unknown;
}

export function ResolveProposalCard({
  ask,
  proposal,
  onConfirm,
  disabled,
  confirming = false,
  error,
}: ResolveProposalCardProps) {
  const option = resolveProposalOption(ask, proposal.optionLetter);

  // The agent named an option this ask does not have — a malformed-proposal
  // signal the operator should SEE rather than one the panel should quietly
  // drop. No confirm button is offered, so there is no path from here to a
  // committed payload.
  if (!option) {
    return (
      <Card className="border-border mt-3">
        <CardContent className="p-3">
          <p className="text-sm text-muted-foreground">
            The agent proposed option {proposal.optionLetter}, which does not exist on this ask.
            Nothing was committed — answer using the controls above.
          </p>
        </CardContent>
      </Card>
    );
  }

  const payload = composeResolvePayload(ask, proposal.optionLetter, RESOLVE_PROPOSAL_SURFACE);

  return (
    <Card className="border-border mt-3">
      <CardContent className="p-3 space-y-2">
        <p className="text-sm text-foreground">
          The agent proposes answering{" "}
          <span className="font-medium">
            {proposal.optionLetter}) {option.label}
          </span>
          .
        </p>

        {proposal.rationale ? (
          <p className="text-sm text-muted-foreground">{proposal.rationale}</p>
        ) : null}

        <div>
          <p className="text-xs text-muted-foreground mb-1">This is what will be recorded:</p>
          {/* The EXACT payload, not a summary of it. The operator is confirming
              a typed write; showing a friendlier paraphrase would mean they
              confirmed something other than what is sent. */}
          <pre
            className="text-xs bg-card border border-border rounded p-2 overflow-x-auto"
            aria-label="Proposed resolve payload"
          >
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <PendingButton
            variant="outline"
            size="sm"
            pending={confirming}
            disabled={disabled}
            onClick={() => onConfirm(proposal.optionLetter)}
          >
            Confirm and answer
          </PendingButton>
          {/* The reassurance is only true while nothing has been sent. Once the
              confirm is in flight the honest line is what is happening. */}
          <span className="text-xs text-muted-foreground" role={confirming ? "status" : undefined}>
            {confirming ? "Saving your response…" : "Nothing is committed until you confirm."}
          </span>
        </div>

        {!confirming && error != null && (
          <ErrorState prefix="Your response was not saved" error={error} className="text-xs" />
        )}
      </CardContent>
    </Card>
  );
}
