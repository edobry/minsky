/**
 * useInterceptors — the interceptor catalog (mt#4010 slice 1).
 *
 * Data source: GET /api/widget/interceptors/data — see
 * `src/cockpit/widgets/interceptors.ts` for the payload shape and
 * `scripts/build-interceptor-catalog.ts` for the generator behind it.
 *
 * The underlying artifact only changes when the repo does (a commit
 * regenerates it; a cockpit restart picks it up), so this is cached
 * aggressively and never polled — unlike the live widgets, there is no clock
 * on the other side of this fetch.
 *
 * Query key: ["interceptors", "catalog"]
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";

export type InterceptorStratum = "registry" | "standalone" | "precommit" | "retired" | "fixture";

export type InterceptorCoverageGap = "tuningOwnership" | "attentionCost" | "canary";

export interface InterceptorEntry {
  guardName: string;
  description: string | null;
  failureClasses: string[];
  provenance: string[];
  stratum: InterceptorStratum | null;
  subject: "trajectory" | "system";
  filenameNote?: string;
  note?: string;
  provenanceStatus: "implementation" | "declaration-only" | "none";
  coverageGaps: InterceptorCoverageGap[];
  registered: boolean;
  undescribed: boolean;
}

export interface FailureClassDefinition {
  failure: string;
  question: string;
}

export interface InterceptorsPayload {
  population: number;
  divergence: {
    declaredButNotDescribed: string[];
    describedButNotDeclared: string[];
  };
  failureClasses: Record<string, FailureClassDefinition>;
  entries: InterceptorEntry[];
}

async function fetchInterceptors(): Promise<InterceptorsPayload> {
  const data = await fetchWidgetData("interceptors");
  if (data.state !== "ok") {
    throw new Error(`interceptors widget: ${data.reason}`);
  }
  return data.payload as InterceptorsPayload;
}

export function useInterceptors() {
  return useQuery({
    queryKey: ["interceptors", "catalog"],
    queryFn: fetchInterceptors,
    staleTime: 10 * 60_000,
  });
}

/**
 * Human-facing labels for the strata.
 *
 * `precommit` and `standalone` are the two whose bare identifiers read as
 * jargon to anyone who has not worked on the hook tree; the rest are expanded
 * for consistency rather than necessity.
 */
export const STRATUM_LABELS: Record<InterceptorStratum, string> = {
  registry: "Dispatcher registry",
  standalone: "Standalone hook",
  precommit: "Pre-commit step",
  retired: "Retired",
  fixture: "Test fixture",
};

/**
 * Display order for the strata — the live enforcement points first, then the
 * two classes that exist only because the fire log is append-only history.
 */
export const STRATUM_ORDER: InterceptorStratum[] = [
  "registry",
  "standalone",
  "precommit",
  "retired",
  "fixture",
];

export const COVERAGE_GAP_LABELS: Record<InterceptorCoverageGap, string> = {
  tuningOwnership: "no tuning owner",
  attentionCost: "no attention-cost annotation",
  canary: "no canary",
};
