/**
 * InterceptorDetailPage — the `/interceptors/:name` route (mt#4010 slice 1).
 *
 * One interceptor, answering the questions slice 1 has data for: what it
 * catches, which failure classes it belongs to, where its behavior is
 * implemented, and what metadata it is missing. Every figure is traceable to
 * the source module named in `provenance` (SC4).
 *
 * Slice 2 (mt#4057) added the three questions slice 1 named as unanswered —
 * whether it currently works, what it costs, and what it has caught — from the
 * per-guard aggregates path (`?guard=`), which is live rather than snapshot-
 * bound for the window figures.
 *
 * EVERY FIGURE NAMES ITS SOURCE (mt#3754 SC6). The traceability line under the
 * activity section is not decoration: these numbers come from four different
 * stores, and a reader who cannot tell the canary from the health tracker
 * cannot tell "no errors" from "verified working" — which is exactly the
 * conflation a fail-open guard produces.
 *
 * An unknown name renders an explicit not-found state rather than a blank
 * page: the catalog's whole discipline is that a name with no data is a
 * finding, and a detail route reached from a stale link is the same case.
 *
 * @see mt#4010 — slice 1
 * @see mt#4057 — slice 2 (health, cost, activity)
 */
import { Link, useParams } from "react-router-dom";
import {
  useInterceptors,
  COVERAGE_GAP_LABELS,
  MECHANISM_LABELS,
  ROLE_LABELS,
  STRATUM_LABELS,
  formatIntervention,
  type InterceptorEntry,
} from "../hooks/useInterceptors";
import { FamilyChips } from "../components/InterceptorFacets";
import {
  formatMs,
  useInterceptorDetail,
  type InterceptorDetailPayload,
} from "../hooks/useInterceptorAggregates";
import {
  InterceptorCostFigure,
  InterceptorHealthPending,
  InterceptorStateChip,
} from "../components/InterceptorHealth";
import {
  deriveInterceptorCost,
  deriveInterceptorState,
} from "@minsky/domain/guard-events/interceptor-state";
// The install-provenance half, absorbed from `/plant/interlock-history` (mt#4229).
// Same hook the plant board's valve-inventory badge reads — one query, two consumers.
import { useSlowTopology, type WeldEntryPayload } from "../hooks/useSlowTopology";
import { relativeTime } from "../lib/format";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border/40 py-2">
      <dt className="text-[9px] font-mono uppercase tracking-[0.08em] text-muted-foreground/70">
        {label}
      </dt>
      <dd className="m-0 mt-1 text-[12px]">{children}</dd>
    </div>
  );
}

/**
 * Health, cost, and what it caught — the three questions slice 1 could not
 * answer (mt#4057).
 *
 * A guard-health `liveness` of "recovered" or "dormant" is NOT rendered as a
 * health verdict beside the canary, and is labelled as error-streak state
 * instead: it is derived from failure streaks, so a fail-open interceptor that
 * crashes on every invocation writes `allow` each time and looks clean here.
 * The canary is the only thing that answers "does it work".
 */
function ActivitySection({ detail }: { detail: InterceptorDetailPayload | undefined }) {
  if (!detail) {
    return (
      <Field label="Health, cost, activity">
        <InterceptorHealthPending testId="interceptor-detail-health-pending" />
      </Field>
    );
  }

  const { row } = detail;
  if (!row) {
    return (
      <Field label="Health, cost, activity">
        <span className="text-warn-amber" data-testid="interceptor-detail-no-aggregate">
          This name is unknown to the fire log and is not in the declared set the aggregates cover,
          so there is nothing to report — not zero fires, but no record either way.
        </span>
      </Field>
    );
  }

  const state = deriveInterceptorState(row);
  const cost = deriveInterceptorCost(row);
  // Not destructured as `window` — that shadows the DOM global in a browser
  // module, which is a real footgun rather than a style preference.
  const { window: windowSection, lifetime } = row.fireLog;
  const overrideEntries = Object.entries(windowSection.overrides.byEnvVar);

  return (
    <>
      <Field label="Does it currently work?">
        <InterceptorStateChip state={state} />
        {detail.unknownToFireLog && (
          <p className="m-0 mt-1 text-[10px] text-muted-foreground/70">
            Declared but never recorded by the fire log — the zero counts below are measured, not
            missing.
          </p>
        )}
      </Field>

      <Field label={`What it caught (last ${detail.windowDays} days)`}>
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
          <span data-testid="interceptor-detail-window-fires">{windowSection.fires} fires</span>
          <span className="text-muted-foreground">
            {windowSection.byDecision.deny} deny · {windowSection.byDecision.warn} warn · {windowSection.byDecision.allow}{" "}
            allow
            {windowSection.byDecision.other > 0 && ` · ${windowSection.byDecision.other} other`}
          </span>
          <span className="text-muted-foreground">
            {lifetime.totalFires} all-time
            {lifetime.lastFireAt && ` · last ${lifetime.lastFireAt.slice(0, 10)}`}
          </span>
        </div>
        {overrideEntries.length > 0 && (
          <p
            className="m-0 mt-1 font-mono text-[10px] text-warn-amber"
            data-testid="interceptor-detail-overrides"
          >
            {windowSection.overrides.total} overridden:{" "}
            {overrideEntries.map(([envVar, n]) => `${envVar} (${n})`).join(", ")}
          </p>
        )}
      </Field>

      <Field label="What it costs">
        <InterceptorCostFigure cost={cost} />
        {cost && (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
            {cost.avgMs !== null && <span>avg {formatMs(cost.avgMs)}</span>}
            {cost.p95Ms !== null && <span>p95 {formatMs(cost.p95Ms)}</span>}
            {cost.maxMs !== null && <span>max {formatMs(cost.maxMs)}</span>}
          </div>
        )}
      </Field>

      {row.calibration && row.calibration.length > 0 && (
        <Field label="Calibration">
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            {row.calibration.map((log) => (
              <li key={log.logName} className="font-mono text-[11px]">
                {log.logName} — {log.totalFires} fires, {log.injectedFiresSinceLastReview} injected
                since last review
                {log.reviewDue && (
                  <span className="ml-1 text-warn-amber">
                    · review due ({log.reviewDueReason ?? "reason not recorded"})
                  </span>
                )}
                {log.lastReviewedAt && (
                  <span className="ml-1 text-muted-foreground/70">
                    · reviewed {log.lastReviewedAt.slice(0, 10)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Field>
      )}

      {row.health && (
        <Field label="Error streaks (not a health verdict)">
          <p
            className="m-0 font-mono text-[11px] text-muted-foreground"
            data-testid="interceptor-detail-health-streaks"
          >
            {String(row.health.liveness ?? "unknown")} · {row.health.failureCount24h ?? 0} failures
            in 24h · {row.health.failureCount7d ?? 0} in 7d · streak{" "}
            {row.health.consecutiveStreak ?? 0}
          </p>
          <p className="m-0 mt-1 text-[10px] text-muted-foreground/70">
            Derived from failure streaks, so it cannot establish that this works: a fail-open
            interceptor writes a clean decision on every crash. The canary above is what answers
            that.
          </p>
        </Field>
      )}

      <Field label="Where these figures come from">
        <ul
          className="list-none p-0 m-0 flex flex-col gap-0.5 font-mono text-[10px] text-muted-foreground/70"
          data-testid="interceptor-detail-sources"
        >
          <li>fires, decisions, cost — guard_events (stream = &apos;fire-log&apos;), live</li>
          <li>the state chip — guard_canary_runs, live</li>
          <li>calibration — the calibration sweep + review watermarks, snapshot</li>
          <li>error streaks — the guard-health tracker, snapshot</li>
          {detail.snapshotComputedAt && (
            <li>snapshot computed {detail.snapshotComputedAt.replace("T", " ").slice(0, 16)}Z</li>
          )}
        </ul>
      </Field>
    </>
  );
}

function ProvenanceField({ entry }: { entry: InterceptorEntry }) {
  if (entry.provenance.length === 0) {
    return (
      <Field label="Provenance">
        <span className="text-warn-amber" data-testid="interceptor-no-provenance">
          None — this name has no description and therefore no source pointer.
        </span>
      </Field>
    );
  }
  return (
    <Field label="Provenance">
      <ul className="list-none p-0 m-0 flex flex-col gap-0.5">
        {entry.provenance.map((p) => (
          <li key={p} className="font-mono text-[11px]">
            {p}
          </li>
        ))}
      </ul>
      {entry.provenanceStatus === "declaration-only" && (
        <p className="mt-1 text-[11px] text-warn-amber" data-testid="interceptor-declaration-only">
          Declaration-only — no source module implements this. The pointer above is where the name
          is declared, not where behavior lives.
        </p>
      )}
    </Field>
  );
}

/*
 * The three provenance cells, moved here verbatim from `WeldHistoryPage` when
 * mt#4229 absorbed that route. Their "unknown" rendering is load-bearing and
 * predates this move (mt#2602 SC4): an interlock with no derivable install date
 * or retrospective says so, rather than showing a guessed date or an invented
 * failure story.
 */

function InstallCell({ entry }: { entry: WeldEntryPayload }) {
  if (!entry.installDate) {
    return <span className="text-muted-foreground/60">unknown</span>;
  }
  const date = new Date(entry.installDate);
  const dateLabel = Number.isNaN(date.getTime()) ? entry.installDate : date.toLocaleDateString();
  return (
    <span title={entry.installDate}>
      {dateLabel} <span className="text-muted-foreground/70">({relativeTime(entry.installDate)})</span>
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

/**
 * Install provenance — absorbed from `/plant/interlock-history` (mt#4229).
 *
 * Answers "when did this land, from which commit, and out of what retrospective"
 * — the one question the catalog could not answer and the interlock-history page
 * existed for. Joined on `sourceFile`, the generator-derived hook-file basename,
 * because the catalog is keyed by `guardName` and this data is keyed by FILE;
 * the two differ wherever a guard's file is named for what it does rather than
 * what it is called (`bare-prohibition` implements as
 * `warn-bare-prohibition-dispatch.ts`).
 *
 * Three distinct absences, rendered as three distinct things rather than one
 * blank — the absence-vs-declaration discipline the rest of this page follows:
 *
 *   - `sourceFile === null` — no hook file BY CONSTRUCTION (a pre-commit step, a
 *     retired or fixture name). There is nothing to join to, and that is the
 *     correct answer, not a gap.
 *   - joined, field null — the file exists, git had no answer for that field.
 *   - `sourceFile` set, no matching row — a real gap: the catalog names a file
 *     the topology walk did not see. Measured 0 of 100 at absorption; it renders
 *     loudly rather than silently because a non-zero here means the two sources
 *     have drifted.
 */
function InstallProvenanceField({ entry }: { entry: InterceptorEntry }) {
  const { data, isLoading, isError } = useSlowTopology();

  if (entry.sourceFile === null) {
    return (
      <Field label="Install provenance">
        <span className="text-muted-foreground/60" data-testid="interceptor-install-not-a-file">
          Not a hook file — this entry is a pre-commit step or a declared name, so it has no install
          commit to trace.
        </span>
      </Field>
    );
  }

  if (isLoading) {
    return (
      <Field label="Install provenance">
        <span className="text-muted-foreground/60">loading…</span>
      </Field>
    );
  }

  // Three states that are NOT drift, separated before the drift branch can claim
  // them (PR #3087 R1). Each would otherwise arrive as "no matching row" and get
  // reported as the two sources having diverged — a loud, wrong alarm about the
  // corpus raised by a transport failure or a cold cache.
  if (isError || !data) {
    return (
      <Field label="Install provenance">
        <span className="text-warn-amber" data-testid="interceptor-install-unavailable">
          Unavailable — the slow-topology widget did not answer. This says nothing about{" "}
          <span className="font-mono">{entry.sourceFile}.ts</span>; retry before reading anything
          into it.
        </span>
      </Field>
    );
  }
  if (data.status === "pending") {
    return (
      <Field label="Install provenance">
        <span className="text-muted-foreground/60" data-testid="interceptor-install-pending">
          Pending — the slow-clock sweep has not completed since this cockpit started. Install
          provenance appears once it does.
        </span>
      </Field>
    );
  }

  const row = data.entries.find((e) => e.name === entry.sourceFile);
  if (!row) {
    return (
      <Field label="Install provenance">
        <span className="text-warn-amber" data-testid="interceptor-install-unresolved">
          Unresolved — the catalog names <span className="font-mono">{entry.sourceFile}.ts</span>,
          but the hook-file walk did not find it. The two sources have drifted.
        </span>
      </Field>
    );
  }

  return (
    <Field label="Install provenance">
      <ul
        className="list-none p-0 m-0 flex flex-col gap-1"
        data-testid="interceptor-install-provenance"
      >
        <li>
          <span className="text-muted-foreground/70">installed </span>
          <InstallCell entry={row} />
        </li>
        <li>
          <span className="text-muted-foreground/70">commit </span>
          <CommitCell entry={row} />
        </li>
        <li className="flex flex-col gap-0.5">
          <span className="text-muted-foreground/70">from retrospective</span>
          <RetrospectiveCell entry={row} />
        </li>
        <li className="font-mono text-[10px] text-muted-foreground/70">
          {row.sourceDir}/{row.name}.ts
        </li>
      </ul>
    </Field>
  );
}

/**
 * The interceptor detail body, without page chrome (mt#4069).
 *
 * Split out of `InterceptorDetailPage` so a peek renders the SAME body the page
 * renders rather than a compact restatement of it. Self-fetching — it takes a
 * `guardName` and calls `useInterceptors()` itself, matching `TaskDetail`'s
 * shape rather than the payload-taking shape, because the catalog is one cached
 * query the whole surface already shares.
 *
 * The page keeps the breadcrumb and the width constraint; everything a reader
 * came for lives here.
 */
export function InterceptorDetail({ name }: { name: string }) {
  const { data, isLoading, isError } = useInterceptors();
  // Fetched for the name in the URL, not gated on the catalog resolving it: a
  // name the catalog does not declare can still have fire-log activity, and
  // that divergence is a finding worth seeing rather than hiding.
  const { data: detail } = useInterceptorDetail(name);

  const entry = data?.entries.find((e) => e.guardName === name);

  return (
    <>
      {isLoading && (
        <p className="text-sm text-muted-foreground" data-testid="interceptor-detail-loading">
          Loading…
        </p>
      )}

      {isError && (
        <p className="text-sm text-warn-amber" data-testid="interceptor-detail-error">
          Failed to load the interceptor catalog.
        </p>
      )}

      {data && !entry && (
        <p className="text-sm text-warn-amber" data-testid="interceptor-detail-not-found">
          No interceptor named <span className="font-mono">{name}</span> is declared. It may have
          been renamed, or the catalog may predate it.
        </p>
      )}

      {data && entry && (
        <>
          <header className="mb-4">
            <h1 className="text-sm font-mono font-semibold tracking-[0.04em] m-0">
              {entry.guardName}
            </h1>
            {entry.undescribed ? (
              <p className="text-[11px] text-warn-amber mt-1" data-testid="interceptor-detail-undescribed">
                Declared but undescribed — no authored account of what this catches.
              </p>
            ) : (
              <p className="text-[12px] text-muted-foreground mt-1">{entry.description}</p>
            )}
          </header>

          <dl className="m-0">
            {/* Health first: "does this still work" is why an operator opens a
                detail page, and it was the question slice 1 had to decline. */}
            <ActivitySection detail={detail} />

            <Field label="Stratum">
              {entry.stratum ? (
                <span className="font-mono text-[11px]">{STRATUM_LABELS[entry.stratum]}</span>
              ) : (
                <span className="text-warn-amber">no declared stratum</span>
              )}
              {!entry.registered && (
                <span className="ml-2 text-[10px] font-mono text-muted-foreground/70">
                  not in the dispatcher registry
                </span>
              )}
            </Field>

            <Field label="Interception point">
              {entry.point ? (
                <>
                  <span className="font-mono text-[11px]">{entry.point}</span>
                  <span className="ml-2 text-[10px] font-mono text-muted-foreground/70">
                    {entry.pointSource === "authored"
                      ? "authored — no declaring source establishes it"
                      : `derived from ${entry.pointSource}`}
                  </span>
                </>
              ) : (
                <span className="text-warn-amber" data-testid="interceptor-detail-point-gap">
                  Undeclared — no registry event, settings registration, or stratum establishes
                  where this sits.
                </span>
              )}
            </Field>

            <Field label="Interventions">
              {entry.interventions.length === 0 ? (
                <span
                  className="text-warn-amber"
                  data-testid="interceptor-detail-interventions-gap"
                >
                  Unauthored — the capability set for this name was never written down.
                </span>
              ) : (
                <ul className="list-none p-0 m-0 flex flex-wrap gap-1.5">
                  {entry.interventions.map((i) => (
                    <li
                      key={formatIntervention(i)}
                      className="rounded bg-muted px-1 py-px font-mono text-[11px]"
                    >
                      {formatIntervention(i)}
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            <Field label="Families">
              <FamilyChips entry={entry} />
              <p className="m-0 mt-1 text-[10px] text-muted-foreground/70">
                Computed from the intervention set, not stored. Membership is not exclusive.
              </p>
            </Field>

            <Field label="Decision mechanism">
              {entry.mechanism ? (
                <span className="text-[11px] text-muted-foreground">
                  {MECHANISM_LABELS[entry.mechanism]}
                </span>
              ) : (
                <span className="text-warn-amber" data-testid="interceptor-detail-mechanism-gap">
                  Unauthored — how this decides was never written down.
                </span>
              )}
            </Field>

            <Field label="Role">
              {entry.role ? (
                <span className="text-[11px] text-muted-foreground">{ROLE_LABELS[entry.role]}</span>
              ) : (
                <span className="text-warn-amber" data-testid="interceptor-detail-role-gap">
                  Unauthored.
                </span>
              )}
            </Field>

            <Field label="Failure classes">
              {entry.failureClasses.length === 0 ? (
                <span className="text-warn-amber">none declared</span>
              ) : (
                <ul className="list-none p-0 m-0 flex flex-col gap-1.5">
                  {entry.failureClasses.map((c) => (
                    <li key={c}>
                      <span className="font-mono text-[11px]">{c}</span>
                      {data.failureClasses[c] && (
                        <p className="m-0 text-[11px] text-muted-foreground">
                          {data.failureClasses[c].failure}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            <ProvenanceField entry={entry} />
            <InstallProvenanceField entry={entry} />

            <Field label="Missing metadata">
              {entry.coverageGaps.length === 0 ? (
                <span className="text-[11px] text-muted-foreground">
                  None — tuning owner, attention cost and canary are all declared.
                </span>
              ) : (
                <ul className="list-none p-0 m-0 flex flex-col gap-0.5">
                  {entry.coverageGaps.map((g) => (
                    <li key={g} className="text-[11px] text-muted-foreground">
                      {COVERAGE_GAP_LABELS[g]}
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            <Field label="Subject">
              <span className="text-[11px] text-muted-foreground">
                {entry.subject === "system"
                  ? "system — classifies other interceptors rather than the trajectory"
                  : "trajectory — acts on the agent's own work"}
              </span>
            </Field>

            {entry.filenameNote && (
              <Field label="Filename note">
                <span className="text-[11px] text-muted-foreground">{entry.filenameNote}</span>
              </Field>
            )}

            {entry.note && (
              <Field label="Note">
                <span className="text-[11px] text-muted-foreground">{entry.note}</span>
              </Field>
            )}
          </dl>

          {/* mt#4010's scope note lived here and is GONE (mt#4057 SC5): it
              named exactly the three questions the sections above now answer,
              and a softened version would keep denying an answer that exists. */}
        </>
      )}
    </>
  );
}

export function InterceptorDetailPage() {
  const { name } = useParams<{ name: string }>();

  return (
    <div className="p-4 w-full max-w-3xl mx-auto" data-testid="interceptor-detail-page">
      <nav
        className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3"
        aria-label="Breadcrumb"
      >
        <Link to="/interceptors" className="hover:text-foreground transition-colors">
          Interceptors
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground font-mono">{name}</span>
      </nav>

      <InterceptorDetail name={name ?? ""} />
    </div>
  );
}
