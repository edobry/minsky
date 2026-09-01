/**
 * Create-time preparation for a kind:"work-package" task (ADR-046, mt#2911).
 *
 * Extracted from the create command so the whole decision — per-origin section
 * validation, then the cited-ref resolution sweep — is testable against
 * injected resolvers instead of patching module imports the command reaches
 * itself (`testing-standards §Testable Design`). The command wires production
 * resolvers (refs.ts `buildProductionResolvers`) and acts on the outcome.
 *
 * Refusal ordering is deliberate: structural failures are reported first and
 * alone (a briefing with no ## Members has nothing to sweep), and the ref
 * sweep runs only on a structurally valid briefing.
 */

import type { RefResolvers } from "../refs";
import { resolveRefs } from "../refs";
import type {
  BriefingValidationFailure,
  ParsedBriefing,
} from "@minsky/domain/tasks/work-package-briefing";
import {
  parseWorkPackageBriefing,
  validateWorkPackageBriefing,
} from "@minsky/domain/tasks/work-package-briefing";

export interface UnresolvedRef {
  ref: string;
  outcome: string;
  error?: string;
}

export type WorkPackagePrepOutcome =
  | {
      ok: false;
      reason: "invalid-briefing";
      failures: BriefingValidationFailure[];
      message: string;
    }
  | {
      ok: false;
      reason: "unresolved-refs";
      unresolved: UnresolvedRef[];
      message: string;
    }
  | {
      ok: true;
      parsed: ParsedBriefing;
      /** Status per resolved ref (member staleness baseline, F7). */
      refStatuses: Map<string, string | null>;
    };

export async function prepareWorkPackageCreate(
  spec: string,
  resolvers: RefResolvers
): Promise<WorkPackagePrepOutcome> {
  const parsed = parseWorkPackageBriefing(spec);

  const failures = validateWorkPackageBriefing(parsed);
  if (failures.length > 0) {
    return {
      ok: false,
      reason: "invalid-briefing",
      failures,
      message: `Work-package briefing is invalid:\n${failures
        .map((f) => `  - ${f.detail}`)
        .join("\n")}`,
    };
  }

  if (parsed.citedRefs.length > 0) {
    const results = await resolveRefs(parsed.citedRefs, resolvers);
    const unresolved: UnresolvedRef[] = results
      .filter((r) => !r.found)
      .map((r) => ({ ref: r.ref, outcome: r.outcome, error: r.error }));
    if (unresolved.length > 0) {
      return {
        ok: false,
        reason: "unresolved-refs",
        unresolved,
        message:
          `Work-package briefing cites refs that do not resolve — every cited entity must ` +
          `exist at write time (mem#676 R5):\n${unresolved
            .map((u) => `  - ${u.ref} (${u.outcome}${u.error ? `: ${u.error}` : ""})`)
            .join("\n")}`,
      };
    }
    const refStatuses = new Map<string, string | null>(
      results.map((r) => [r.ref, r.status ?? null])
    );
    return { ok: true, parsed, refStatuses };
  }

  return { ok: true, parsed, refStatuses: new Map() };
}
