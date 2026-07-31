import { z } from "zod";
import type { ReviewToolCall } from "./output-tools";
import { reconcileEventWithBlockingCount } from "./compose-review";
import { SYNTHESIZED_FINDING_FILE } from "./empty-findings-recovery";

export const PROVENANCE_MARKER_START = "<!-- minsky-review-provenance:";
export const PROVENANCE_MARKER_END = " -->";

export const SpecVerificationEntrySchema = z.object({
  criterion: z.string().min(1),
  status: z.enum(["Met", "Not Met", "N/A"]),
  evidence: z.string().min(1),
});

export const DocImpactEntrySchema = z.object({
  kind: z.enum(["no-update-needed", "updated-in-pr", "blocking-needs-update"]),
  evidence: z.string().min(1),
  affectedDocs: z.array(z.string()).optional(),
});

export const FindingsSummarySchema = z.object({
  blocking: z.number().int().min(0),
  nonBlocking: z.number().int().min(0),
  /**
   * Count of the `blocking` findings above that were synthesized by the
   * mt#2685 empty-findings coherence recovery pass rather than emitted by
   * the reviewer model (review R1: makes the synthesized case distinguishable
   * in provenance, not just in logs — see empty-findings-recovery.ts). `0`
   * for reviews where the pass did not fire. `.default(0)` so legacy
   * provenance blobs serialized before this field existed still parse.
   */
  synthesizedBlocking: z.number().int().min(0).default(0),
});

export const ConclusionEntrySchema = z.object({
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  summary: z.string().min(1),
});

export const AdoptionSweepEntrySchema = z.object({
  symbol: z.string().min(1),
  kind: z.enum(["function", "class", "type", "cli-command", "mcp-tool", "hook", "capability"]),
  consumersFound: z.array(z.string()).default([]),
  classification: z.enum(["Adopted", "Missing consumers"]),
  notes: z.string().optional(),
});

export const ReviewProvenanceSchema = z.object({
  specVerification: z.array(SpecVerificationEntrySchema),
  docImpact: DocImpactEntrySchema.nullable(),
  findings: FindingsSummarySchema,
  conclusion: ConclusionEntrySchema.nullable(),
  // adoptionSweep is null for legacy reviews (pre-mt#2059) that did not emit
  // submit_adoption_sweep calls. For new reviews, it is an array of entries.
  adoptionSweep: z.array(AdoptionSweepEntrySchema).nullable(),
});

export type ReviewProvenance = z.infer<typeof ReviewProvenanceSchema>;

export function extractProvenance(toolCalls: ReadonlyArray<ReviewToolCall>): ReviewProvenance {
  const specVerification: ReviewProvenance["specVerification"] = [];
  let docImpact: ReviewProvenance["docImpact"] = null;
  let blocking = 0;
  let nonBlocking = 0;
  let synthesizedBlocking = 0;
  let conclusion: ReviewProvenance["conclusion"] = null;
  const adoptionSweepEntries: NonNullable<ReviewProvenance["adoptionSweep"]> = [];

  for (const tc of toolCalls) {
    switch (tc.name) {
      case "submit_spec_verification":
        specVerification.push({
          criterion: tc.args.criterion,
          status: tc.args.status,
          evidence: tc.args.evidence,
        });
        break;
      case "submit_documentation_impact":
        docImpact = {
          kind: tc.args.kind,
          evidence: tc.args.evidence,
          affectedDocs: tc.args.affectedDocs,
        };
        break;
      case "submit_finding":
        if (tc.args.severity === "BLOCKING") {
          blocking++;
          // mt#2685 review R1: the empty-findings recovery pass (Step 0 in
          // applyRecoveryAndCompose) tags its synthesized finding with the
          // SYNTHESIZED_FINDING_FILE sentinel. Detecting it here — rather
          // than threading a separate "was this synthesized" flag through
          // extractProvenance's signature — keeps this function's contract
          // unchanged (still a pure function of toolCalls alone) while still
          // making the synthesized case distinguishable in the provenance
          // consumers actually read.
          if (tc.args.file === SYNTHESIZED_FINDING_FILE) synthesizedBlocking++;
        } else {
          nonBlocking++;
        }
        break;
      case "conclude_review":
        conclusion = {
          event: tc.args.event,
          summary: tc.args.summary,
        };
        break;
      case "submit_adoption_sweep":
        adoptionSweepEntries.push({
          symbol: tc.args.symbol,
          kind: tc.args.kind,
          consumersFound: tc.args.consumersFound,
          classification: tc.args.classification,
          notes: tc.args.notes,
        });
        break;
    }
  }

  // Chunk-review / label reconciliation (mt#2655): reconcile the recorded
  // conclusion event against the finding severities using the SAME
  // deterministic rule composeReviewBody applies to the posted review body.
  // Both functions are fed the identical toolCalls array by the caller, so
  // reconciling here independently (rather than trusting the raw
  // conclude_review event) keeps the embedded provenance blob from
  // disagreeing with the review body's terminal event and findings labels
  // (#1821 R1: body said "1 blocking + 4 non-blocking", provenance said
  // "0/0" — an event/label/provenance disagreement of exactly this shape).
  if (conclusion !== null) {
    const { event } = reconcileEventWithBlockingCount(conclusion.event, blocking);
    conclusion = { ...conclusion, event };
  }

  return {
    specVerification,
    docImpact,
    findings: { blocking, nonBlocking, synthesizedBlocking },
    conclusion,
    // Emit null (legacy-compatible) when no adoption-sweep calls were made;
    // emit the array when at least one call was made.
    adoptionSweep: adoptionSweepEntries.length > 0 ? adoptionSweepEntries : null,
  };
}

export function serializeProvenance(provenance: ReviewProvenance): string {
  return `${PROVENANCE_MARKER_START}${JSON.stringify(provenance)}${PROVENANCE_MARKER_END}`;
}

export function parseProvenance(body: string): ReviewProvenance | null {
  const startIdx = body.indexOf(PROVENANCE_MARKER_START);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + PROVENANCE_MARKER_START.length;
  const endIdx = body.indexOf(PROVENANCE_MARKER_END, jsonStart);
  if (endIdx === -1) return null;

  const jsonStr = body.slice(jsonStart, endIdx);
  try {
    const parsed = JSON.parse(jsonStr);
    return ReviewProvenanceSchema.parse(parsed);
  } catch {
    return null;
  }
}
