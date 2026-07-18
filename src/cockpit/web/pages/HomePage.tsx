/**
 * HomePage — the triage radiator (mt#2881).
 *
 * The default landing answers, at a glance: "does anything need me, what,
 * how urgent — and is the substrate healthy." Three bands, in attention
 * order (/product-thinking: needs-me over newest, anomaly over inventory,
 * glance over query):
 *
 *   1. Needs you — every pending ask, ranked by display tier then age,
 *      one click from its decision (widgets/TriageBand.tsx).
 *   2. Fleet — one compact line of run-liveness counts, linking to /agents.
 *   3. Substrate — ONE calm line when every subsystem is healthy; an
 *      anomalous subsystem expands to its full existing status card, above
 *      the calm line for the rest. Healthy steady-state facts (uptime,
 *      version, widgets-loaded, credentials-all-configured) are receipts —
 *      they live on /settings, not here (mt#2880 audit: the old home gave
 *      "Credentials 6/6 configured" the same card weight as a genuinely
 *      degraded embeddings pipeline).
 *
 * Composition is FIXED (curated), not registry-driven: the widget registry
 * still owns data capability, but the home layout is a designed surface, not
 * a card dump (frontend owns layout per docs/architecture/cockpit.md
 * §Widgets). New registry widgets no longer auto-append here.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { TriageBand } from "../widgets/TriageBand";
import { EmbeddingsHealth } from "../widgets/EmbeddingsHealth";
import { McpServerStatus } from "../widgets/McpServerStatus";
import { ReviewerBotStatus } from "../widgets/ReviewerBotStatus";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";

// ---------------------------------------------------------------------------
// Fleet strip — liveness counts over the unified run list.
// ---------------------------------------------------------------------------

interface FleetCounts {
  working: number;
  idle: number;
  stale: number;
  total: number;
}

/**
 * Recency window for the STALE count: a session that went stale within the
 * last 24h is a glance-worthy signal ("something died recently"); the
 * long-dead tail is inventory for /agents, not radiator content. 24h is the
 * project's burst-detection window (decision-defaults §Thresholds). Live
 * audit grounding: 217 never-cleaned stale records would otherwise render a
 * permanent "217 stale" alarm — the exact alarm-fatigue failure the radiator
 * exists to avoid. No fake calm, but also no fake alarm.
 */
export const STALE_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Count workspace-session liveness states from the agents widget payload.
 * Working (healthy) and idle count unconditionally; stale counts only within
 * {@link STALE_RECENCY_WINDOW_MS}. Terminal/absent states (`exited`,
 * `orphaned`, null) are skipped — a finished session is not an alarm.
 */
export function countFleet(
  data: WidgetData | undefined,
  now: number = Date.now()
): FleetCounts | null {
  if (!data || data.state !== "ok") return null;
  const payload = data.payload as {
    agents?: { liveness: string | null; lastActivityAt?: string | null }[];
  };
  if (!Array.isArray(payload?.agents)) return null;
  const counts: FleetCounts = { working: 0, idle: 0, stale: 0, total: 0 };
  for (const a of payload.agents) {
    if (a.liveness === "healthy") {
      counts.working += 1;
      counts.total += 1;
    } else if (a.liveness === "idle") {
      counts.idle += 1;
      counts.total += 1;
    } else if (a.liveness === "stale") {
      const last = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : NaN;
      if (Number.isFinite(last) && now - last <= STALE_RECENCY_WINDOW_MS) {
        counts.stale += 1;
        counts.total += 1;
      }
    }
  }
  return counts;
}

/** One instrument-style count segment: big tabular-nums digit + small unit label. */
function FleetGauge({ dotClass, count, unit }: { dotClass: string; count: number; unit: string }) {
  return (
    <span className="flex items-baseline gap-1.5 px-3 first:pl-0">
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
      <span className="font-mono text-h3 font-semibold tabular-nums text-foreground">
        {count}
      </span>{" "}
      <span className="text-xs text-muted-foreground">{unit}</span>
    </span>
  );
}

function FleetStrip() {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["agents"],
    queryFn: () => fetchWidgetData("agents"),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const counts = countFleet(query.data);
  if (!counts) return null;

  // Honest-empty state (system-speaks voice, warm-mono) rather than a row of
  // zeros — the fleet legitimately being idle is a fact worth stating
  // plainly, not a degraded/loading shell.
  if (counts.total === 0) {
    return (
      <Link
        to="/agents"
        className="flex items-center justify-between rounded border border-border bg-card/50 px-3 py-2.5 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
        aria-label="Fleet status — open agents"
      >
        <span className="font-warm-mono italic text-sm text-muted-foreground">
          fleet idle — nothing dispatched
        </span>
        <span className="text-muted-foreground">→</span>
      </Link>
    );
  }

  return (
    <Link
      to="/agents"
      className="flex items-center rounded border border-border bg-card/50 px-3 py-2 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors divide-x divide-border/50"
      aria-label="Fleet status — open agents"
    >
      <FleetGauge
        dotClass={`bg-liveness-healthy${counts.working > 0 ? " animate-status-dot" : ""}`}
        count={counts.working}
        unit="working"
      />
      <FleetGauge dotClass="bg-liveness-idle" count={counts.idle} unit="idle" />
      <FleetGauge dotClass="bg-liveness-stale" count={counts.stale} unit="stale" />
      <span className="ml-auto pl-3 text-muted-foreground">→</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Substrate band — anomaly-only expansion over the health widgets.
// ---------------------------------------------------------------------------

type SubstrateId = "mcp-server-status" | "reviewer-bot-status" | "embeddings-health";

interface SubsystemHealth {
  id: SubstrateId;
  label: string;
  anomalous: boolean;
}

/**
 * Per-subsystem anomaly predicates. Each mirrors the top-level status
 * derivation its widget component renders (kept intentionally small — the
 * full detail renders via the widget card itself when anomalous):
 *
 * - A widget-level `degraded` state is always anomalous.
 * - MCP: any anomaly flag set, or health probe not ok (mirrors
 *   McpServerStatus's `overallStatus`).
 * - Reviewer: any per-cycle DB query failure (the mt#2758 convention —
 *   failed-query zeros must never render as healthy).
 * - Embeddings: provider status not "healthy".
 */
export function isSubsystemAnomalous(id: SubstrateId, data: WidgetData | undefined): boolean {
  if (!data) return false; // loading — not yet an anomaly
  if (data.state === "degraded") return true;
  const payload = data.payload as Record<string, unknown>;
  // A malformed/absent payload on an "ok" response is treated like loading,
  // not like an alarm (PR #2021 R1): the widget-level degraded state and the
  // field-guarded per-subsystem checks below carry the real signal; alarming
  // on shape alone would false-positive during version skew.
  if (payload == null || typeof payload !== "object") return false;

  switch (id) {
    case "mcp-server-status": {
      const anomalies = payload["anomalies"] as Record<string, boolean> | undefined;
      const health = payload["health"] as { ok?: boolean } | undefined;
      if (anomalies && Object.values(anomalies).some(Boolean)) return true;
      return health?.ok === false;
    }
    case "reviewer-bot-status": {
      const db = payload["db"] as { queryFailureCount?: number } | undefined;
      return (db?.queryFailureCount ?? 0) > 0;
    }
    case "embeddings-health": {
      const status = payload["status"];
      return typeof status === "string" && status !== "healthy";
    }
    default:
      return false;
  }
}

const SUBSTRATE_WIDGETS: {
  id: SubstrateId;
  label: string;
  Card: React.ComponentType<{ title?: string }>;
}[] = [
  { id: "mcp-server-status", label: "MCP", Card: McpServerStatus },
  { id: "reviewer-bot-status", label: "reviewer", Card: ReviewerBotStatus },
  { id: "embeddings-health", label: "embeddings", Card: EmbeddingsHealth },
];

function useSubstrateHealth(): SubsystemHealth[] {
  // Same query keys the widgets themselves use — one cache, whether the data
  // renders as a calm-line mention or as the expanded card.
  const mcp = useQuery<WidgetData, Error>({
    queryKey: ["widget", "mcp-server-status"],
    queryFn: () => fetchWidgetData("mcp-server-status"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const reviewer = useQuery<WidgetData, Error>({
    queryKey: ["widget", "reviewer-bot-status"],
    queryFn: () => fetchWidgetData("reviewer-bot-status"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const embeddings = useQuery<WidgetData, Error>({
    queryKey: ["widget", "embeddings-health"],
    queryFn: () => fetchWidgetData("embeddings-health"),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  const dataById: Record<SubstrateId, WidgetData | undefined> = {
    "mcp-server-status": mcp.data,
    "reviewer-bot-status": reviewer.data,
    "embeddings-health": embeddings.data,
  };

  return SUBSTRATE_WIDGETS.map(({ id, label }) => ({
    id,
    label,
    anomalous: isSubsystemAnomalous(id, dataById[id]),
  }));
}

function SubstrateBand() {
  const subsystems = useSubstrateHealth();
  const anomalous = subsystems.filter((s) => s.anomalous);
  const healthy = subsystems.filter((s) => !s.anomalous);

  return (
    <div className="flex flex-col gap-3">
      {/* Anomalies expand to their full existing status cards — the one off
          thing must be louder than every healthy thing combined. */}
      {anomalous.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {anomalous.map(({ id }) => {
            const entry = SUBSTRATE_WIDGETS.find((w) => w.id === id);
            if (!entry) return null;
            const { Card } = entry;
            return (
              <ErrorBoundary key={id} id={id}>
                <Card />
              </ErrorBoundary>
            );
          })}
        </div>
      )}

      {/* The calm line: healthy subsystems earn one line, not cards. System-
          speaks voice (warm-mono italic, brand-system.md §1) — this is
          Minsky reporting on its own substrate, not operator-facing UI copy. */}
      {healthy.length > 0 && (
        <p
          className="font-warm-mono italic text-xs text-muted-foreground"
          data-testid="substrate-calm-line"
        >
          {anomalous.length === 0 ? "Substrate healthy" : "Otherwise healthy"} ·{" "}
          {healthy.map((s) => s.label).join(" · ")}
          <Link
            to="/settings"
            className="ml-2 not-italic hover:text-foreground transition-colors"
            aria-label="System details on settings"
          >
            details →
          </Link>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Mono-caps structural label shared by every band on the radiator. */
function BandEyebrow({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 text-eyebrow font-mono uppercase text-muted-foreground">{children}</h2>
  );
}

export function HomePage() {
  return (
    <div className="p-4 flex flex-col gap-4 max-w-5xl mx-auto w-full">
      <section aria-label="Needs you">
        <BandEyebrow>Needs you</BandEyebrow>
        <ErrorBoundary id="triage-band">
          <TriageBand />
        </ErrorBoundary>
      </section>

      <section aria-label="Fleet">
        <BandEyebrow>Fleet</BandEyebrow>
        <ErrorBoundary id="fleet-strip">
          <FleetStrip />
        </ErrorBoundary>
      </section>

      <section aria-label="Substrate health">
        <BandEyebrow>Substrate</BandEyebrow>
        <ErrorBoundary id="substrate-band">
          <SubstrateBand />
        </ErrorBoundary>
      </section>
    </div>
  );
}
