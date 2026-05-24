import { z } from "zod";
import type { ReviewToolCall } from "./output-tools";

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
        if (tc.args.severity === "BLOCKING") blocking++;
        else nonBlocking++;
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

  return {
    specVerification,
    docImpact,
    findings: { blocking, nonBlocking },
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
