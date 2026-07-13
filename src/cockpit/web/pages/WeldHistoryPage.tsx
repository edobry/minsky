/**
 * WeldHistoryPage — the "/plant/interlock-history" route (mt#2602; renamed
 * from "/plant/weld-history" by mt#2626's guard-vocabulary alignment).
 *
 * The plant's browsable self-construction log: every derived guard-hook
 * interlock, its install date + commit link (git history), and — where
 * derivable — the `retrospective.fired` event (mt#2537) that produced it.
 * A separate page/route rather than a panel on PlantFlowPage per the task's
 * "keep PlantFlowPage small" constraint (mt#2598 owns that file's line-count
 * split).
 *
 * Honest-data discipline: an interlock with no derivable install date or
 * retrospective link renders "unknown" — never a guessed date or an invented
 * failure story (mt#2602 success criterion 4).
 *
 * Naming note (mt#2626): the component/file name, the `WeldEntryPayload`
 * type, and the `weld-history-*` test ids are kept stable — internal
 * identifiers with no user-visible surface, so renaming them would churn
 * imports/tests without benefit. Only the route and the rendered copy use
 * "interlock" (the domain noun); "weld" survives at most as a verb.
 */
import { Link } from "react-router-dom";
import { useSlowTopology, type WeldEntryPayload } from "../hooks/useSlowTopology";
import { relativeTime } from "../lib/format";

function InstallCell({ entry }: { entry: WeldEntryPayload }) {
  if (!entry.installDate) {
    return <span className="text-muted-foreground/60">unknown</span>;
  }
  const date = new Date(entry.installDate);
  const dateLabel = Number.isNaN(date.getTime()) ? entry.installDate : date.toLocaleDateString();
  return (
    <span title={entry.installDate}>
      {dateLabel}{" "}
      <span className="text-muted-foreground/70">({relativeTime(entry.installDate)})</span>
    </span>
  );
}

function CommitCell({ entry }: { entry: WeldEntryPayload }) {
  if (!entry.commitSha) return <span className="text-muted-foreground/60">unknown</span>;
  const shortSha = entry.commitSha.slice(0, 7);
  if (!entry.commitUrl) return <span className="font-mono">{shortSha}</span>;
  return (
    <a
      href={entry.commitUrl}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-primary hover:underline"
    >
      {shortSha}
    </a>
  );
}

function RetrospectiveCell({ entry }: { entry: WeldEntryPayload }) {
  const r = entry.retrospective;
  if (!r) return <span className="text-muted-foreground/60">unknown</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px]">{r.note ?? "(no note)"}</span>
      <span className="text-[9px] text-muted-foreground">
        {r.taskId ?? "—"} ·{" "}
        {r.matchType === "task-ref" ? "matched by task ref" : "matched by time proximity"}
      </span>
    </div>
  );
}

export function WeldHistoryPage() {
  const { data, isLoading, isError } = useSlowTopology();

  return (
    <div className="p-4 w-full max-w-4xl mx-auto" data-testid="weld-history-page">
      <nav
        className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3"
        aria-label="Breadcrumb"
      >
        <Link to="/plant" className="hover:text-foreground transition-colors">
          Plant
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">Interlock history</span>
      </nav>

      <header className="mb-4">
        <h1 className="text-sm font-mono font-semibold tracking-[0.04em] m-0">
          INTERLOCK HISTORY — provenance timeline
        </h1>
        <p className="text-[11px] font-mono text-muted-foreground mt-1">
          Every guard-hook interlock derived from the live registry, with its install date
          (git history) and, where derivable, the failure/retrospective that produced it.
        </p>
      </header>

      {isLoading && (
        <p className="text-sm text-muted-foreground" data-testid="weld-history-loading">
          Loading…
        </p>
      )}

      {isError && (
        <p className="text-sm text-warn-amber" data-testid="weld-history-error">
          Failed to load interlock history.
        </p>
      )}

      {data && (
        <>
          <div
            className="text-[10px] font-mono text-muted-foreground mb-2"
            data-testid="weld-history-computed-at"
          >
            {data.status === "ready" && data.computedAt
              ? `${data.interlockCount} interlocks · last derived ${relativeTime(data.computedAt)}`
              : "Derivation pending — the slow-clock sweep has not completed its first pass yet."}
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs font-mono" data-testid="weld-history-table">
              <thead>
                <tr className="border-b border-border bg-card/60 text-left text-muted-foreground">
                  <th className="px-2.5 py-1.5 font-normal">interlock</th>
                  <th className="px-2.5 py-1.5 font-normal">source</th>
                  <th className="px-2.5 py-1.5 font-normal">installed</th>
                  <th className="px-2.5 py-1.5 font-normal">commit</th>
                  <th className="px-2.5 py-1.5 font-normal">originating retrospective</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => (
                  <tr
                    key={entry.name}
                    className="border-b border-border/50 last:border-0"
                    data-testid={`weld-history-row-${entry.name}`}
                  >
                    <td className="px-2.5 py-1.5">{entry.name}</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{entry.sourceDir}</td>
                    <td className="px-2.5 py-1.5">
                      <InstallCell entry={entry} />
                    </td>
                    <td className="px-2.5 py-1.5">
                      <CommitCell entry={entry} />
                    </td>
                    <td className="px-2.5 py-1.5">
                      <RetrospectiveCell entry={entry} />
                    </td>
                  </tr>
                ))}
                {data.entries.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-2.5 py-3 text-center text-muted-foreground"
                      data-testid="weld-history-empty"
                    >
                      No interlocks derived yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
