/**
 * DrivenSessionCostPage — the "/agents/cost" route (mt#2753, Rung 2D).
 *
 * Cockpit readout for driven-session consumption: an aggregate summary
 * (total spend at API rates across all persisted turns, token totals, a
 * daily/monthly projection at the observed cadence) plus a per-session
 * breakdown table. Data source: `useDrivenSessionCost` ->
 * GET /api/widget/driven-session-cost/data -> `../../widgets/driven-session-cost.ts`
 * (one row per turn in `driven_session_cost`, rolled up here).
 *
 * Billing-premise note (2026-07-13, mt#2753 spec): the 2026-06-15 Agent SDK /
 * `claude -p` billing split was PAUSED — headless usage currently draws from
 * the operator's subscription at $0 marginal cost. The numbers on this page
 * are the API-RATE EQUIVALENT the stream's own `result` events report, for
 * consumption/rate observability and re-application readiness — NOT a live
 * dollar bill. See memory `2d6cdbaf` / the schema module's docblock.
 *
 * @see mt#2753 — this page
 * @see mt#2750 — the driven-session host this data flows from
 * @see ../../widgets/driven-session-cost.ts — aggregation logic + payload shape
 */
import { Link } from "react-router-dom";
import { useDrivenSessionCost } from "../hooks/useDrivenSessionCost";
import { relativeTime } from "../lib/format";

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toFixed(4)}`;
}

function formatTokens(value: number): string {
  return value.toLocaleString();
}

export function DrivenSessionCostPage() {
  const { data, isLoading, isError, error } = useDrivenSessionCost();

  return (
    <div className="p-4 w-full max-w-5xl mx-auto" data-testid="driven-session-cost-page">
      <nav
        className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3"
        aria-label="Breadcrumb"
      >
        <Link to="/agents" className="hover:text-foreground transition-colors">
          Agents
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">Cost &amp; usage</span>
      </nav>

      <header className="mb-4">
        <h1 className="text-h1 font-semibold text-foreground m-0">Driven-session cost &amp; usage</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Measured consumption from the driven-session event stream, at API rates. Currently drawn
          from the operator&apos;s subscription at $0 marginal cost (2026-06-15 billing split
          paused) — these numbers are consumption/rate observability, not a live bill.
        </p>
      </header>

      {isLoading && (
        <p className="text-sm text-muted-foreground" data-testid="driven-session-cost-loading">
          Loading…
        </p>
      )}

      {isError && (
        <p className="text-sm text-warn-amber" data-testid="driven-session-cost-error">
          Failed to load driven-session cost data{error instanceof Error ? `: ${error.message}` : ""}.
        </p>
      )}

      {data?.status === "no-data" && (
        <p className="text-sm text-muted-foreground" data-testid="driven-session-cost-empty">
          No driven sessions have completed a turn yet.
        </p>
      )}

      {data?.status === "ok" && (
        <>
          <div
            className="grid grid-cols-2 gap-3 mb-4 sm:grid-cols-4"
            data-testid="driven-session-cost-aggregate"
          >
            <div className="rounded-md border border-border bg-card p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Total spend (API-rate equivalent)
              </div>
              <div className="text-lg font-semibold">{formatUsd(data.totalCostUsd)}</div>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Projected daily
              </div>
              <div className="text-lg font-semibold">{formatUsd(data.projectedDailyCostUsd)}</div>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Projected monthly
              </div>
              <div className="text-lg font-semibold">{formatUsd(data.projectedMonthlyCostUsd)}</div>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Sessions / turns
              </div>
              <div className="text-lg font-semibold">
                {data.sessionCount} / {data.turnCount}
              </div>
            </div>
          </div>

          <div
            className="text-[10px] font-mono text-muted-foreground mb-2"
            data-testid="driven-session-cost-window"
          >
            Window: {relativeTime(data.windowStart)} — {relativeTime(data.windowEnd)} · tokens in{" "}
            {formatTokens(data.inputTokens)} · out {formatTokens(data.outputTokens)} · cache-create{" "}
            {formatTokens(data.cacheCreationInputTokens)} · cache-read{" "}
            {formatTokens(data.cacheReadInputTokens)}
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs" data-testid="driven-session-cost-table">
              <thead>
                <tr className="border-b border-border bg-card/60 text-left text-muted-foreground">
                  <th className="px-2.5 py-1.5 font-normal">session</th>
                  <th className="px-2.5 py-1.5 font-normal">task</th>
                  <th className="px-2.5 py-1.5 font-normal">turns</th>
                  <th className="px-2.5 py-1.5 font-normal">cost</th>
                  <th className="px-2.5 py-1.5 font-normal">tokens (in / out)</th>
                  <th className="px-2.5 py-1.5 font-normal">cache (create / read)</th>
                  <th className="px-2.5 py-1.5 font-normal">last active</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr
                    key={s.localId}
                    className="border-b border-border/50 last:border-0"
                    data-testid={`driven-session-cost-row-${s.localId}`}
                  >
                    <td className="px-2.5 py-1.5 font-mono">
                      <Link to={`/driven/${s.localId}`} className="text-primary hover:underline">
                        {s.localId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-2.5 py-1.5">
                      {s.taskId ? (
                        <Link to={`/tasks/${encodeURIComponent(s.taskId)}`} className="hover:underline">
                          {s.taskId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground/60">scratch</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">{s.turnCount}</td>
                    <td className="px-2.5 py-1.5">{formatUsd(s.totalCostUsd)}</td>
                    <td className="px-2.5 py-1.5">
                      {formatTokens(s.inputTokens)} / {formatTokens(s.outputTokens)}
                    </td>
                    <td className="px-2.5 py-1.5">
                      {formatTokens(s.cacheCreationInputTokens)} / {formatTokens(s.cacheReadInputTokens)}
                    </td>
                    <td className="px-2.5 py-1.5" title={s.lastRecordedAt}>
                      {relativeTime(s.lastRecordedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
