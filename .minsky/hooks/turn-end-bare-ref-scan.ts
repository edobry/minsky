#!/usr/bin/env bun
// Stop-event guard: scan the turn's FINAL assistant message for entity refs
// the reader cannot click, and for deeplinks that are malformed by
// construction (mt#3286).
//
// Why turn-END specifically, rather than every message: the operator acts at
// the end of a turn. R3 of the linked-reference-actionability family (mem#623)
// is precisely a message where the entity WAS linked earlier in the turn and
// bare in the closing message — fully compliant with the old
// one-link-per-entity ceiling, and unusable to the person it was written for.
// The closing message is the surface under contract.
//
// Advisory-only, always. This is a Rung-1 deterministic matcher (ADR-024) and
// a blocking Stop hook would turn any false positive into a hijacked turn.
// Calibration-first per the same ADR: the JSONL log is the enforcement
// evidence, and injection stays off until the FP rate is measured.
//
// Scan input: the Stop payload's `last_assistant_message`, falling back to the
// transcript's final turn — hooks.md documents that the transcript is not
// guaranteed to carry the final message at Stop time.
//
// @see .minsky/hooks/bare-entity-ref-scan.ts — the pure scanner this shells
// @see .minsky/hooks/turn-end-retro-scan.ts — sibling Stop leg, same shape
// @see mem#623 — the R1-R6 recurrence family this detector exists to close
// @see mt#3459 — the display-surface linkifier decision; until that ships the
//      authoring burden is real and unenforced, which is what this measures

import type { ClaudeHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { extractAssistantText, extractFinalTurn } from "./transcript";
import { scanMessage, type ScanFinding } from "./bare-entity-ref-scan";

export const OVERRIDE_ENV_VAR = "MINSKY_ACK_BARE_ENTITY_REF";

/**
 * Ceiling for this guard's advisory text, mirrored from its registry
 * `attentionCost.denialMessageSizeChars`. `guard-feedback-shape.test.ts`
 * (mt#3479) asserts the RENDERED text against the registry declaration, so
 * drift between this constant and the registry fails there mechanically
 * rather than silently.
 *
 * The render below is bounded in CODE and not merely measured in a test
 * (mt#3824's lesson): the finding list is unbounded — a long closing report
 * can name many entities — so an unbounded render would grow past any
 * declared figure without anyone re-measuring.
 */
const ADVISORY_BUDGET_CHARS = 700;

export interface StopHookInput extends ClaudeHookInput {
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

/**
 * Render the advisory, greedily fitting findings within the byte budget and
 * summarizing the remainder as one "…and K more" line so a truncated list is
 * never mistaken for a complete one.
 */
export function formatBareRefAdvisory(findings: ScanFinding[]): string {
  const header =
    "[turn-end-bare-ref-scan] The closing message carries entity refs the reader cannot click (mt#3286).";
  const action =
    "Link them before ending the turn: [mt#N](minsky://task/mt%23N), [PR #N](minsky://changeset/N). " +
    "The obligation is per MESSAGE — the closing message is where the operator acts.";

  const line = (f: ScanFinding): string => `  - ${f.ref}: ${f.reason}`;

  const render = (listed: string[], omitted: number): string => {
    const lines = [header, "", ...listed];
    if (omitted > 0) lines.push(`  …and ${omitted} more`);
    lines.push("", action);
    return lines.join("\n");
  };

  const listed: string[] = [];
  let considered = 0;
  for (const f of findings) {
    considered += 1;
    const candidate = [...listed, line(f)];
    if (render(candidate, findings.length - considered).length > ADVISORY_BUDGET_CHARS) break;
    listed.push(line(f));
  }
  return render(listed, findings.length - listed.length);
}

/** Guard-dispatcher entry point (GuardModule contract). */
export async function run(
  input: StopHookInput,
  ctx: DispatchContext
): Promise<GuardOutcome | null> {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";
  if (isOverride) {
    return {
      auditLines: [
        `[turn-end-bare-ref-scan] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  // This guard's contract is the CLOSING message specifically, so prefer the
  // directly-supplied final message; fall back to the transcript tail only
  // when the payload did not carry it.
  const { turnLines } = extractFinalTurn(ctx.transcriptLines);
  const lastMessage = input.last_assistant_message ?? "";
  const text = lastMessage || extractAssistantText(turnLines);
  if (!text) return null;

  const { flagged, logged } = scanMessage(text);
  if (flagged.length === 0 && logged.length === 0) return null;

  const calibration = {
    source: "live" as const,
    channel: "stop" as const,
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    stop_hook_active: input.stop_hook_active === true,
    // `matches: {family, phrase}[]` is the shared shape the sweep's fallback
    // branch already parses (the `untaken-action` precedent), so this log needs
    // no dedicated parser case and its diversity axis is distinct refs for
    // free. family = the defect class, phrase = the offending ref.
    matches: flagged.map((f) => ({ family: f.kind, phrase: f.ref })),
    // The log-only population is recorded SEPARATELY rather than folded into
    // `matches`: the carve-out's whole purpose is to let a future review
    // compare flagged-vs-logged, which is impossible once they are merged.
    logged_only: logged.map((f) => ({ family: f.kind, phrase: f.ref })),
    flagged_count: flagged.length,
    logged_only_count: logged.length,
  };

  // Calibration-first (ADR-024): a record is written on every fire, but the
  // advisory is emitted only for the enforced classes. A message carrying only
  // log-only findings produces a record and no text.
  if (flagged.length === 0) return { calibration };

  return { calibration, additionalContext: formatBareRefAdvisory(flagged) };
}
