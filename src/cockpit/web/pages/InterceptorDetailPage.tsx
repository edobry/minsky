/**
 * InterceptorDetailPage — the `/interceptors/:name` route (mt#4010 slice 1).
 *
 * One interceptor, answering the questions slice 1 has data for: what it
 * catches, which failure classes it belongs to, where its behavior is
 * implemented, and what metadata it is missing. Every figure is traceable to
 * the source module named in `provenance` (SC4).
 *
 * The remaining detail-view questions — whether it currently works, what it
 * costs, what it has caught — are slice 2, and are named as unanswered rather
 * than rendered as empty fields (mt#4010 §Slicing decision).
 *
 * An unknown name renders an explicit not-found state rather than a blank
 * page: the catalog's whole discipline is that a name with no data is a
 * finding, and a detail route reached from a stale link is the same case.
 *
 * @see mt#4010 — this task
 */
import { Link, useParams } from "react-router-dom";
import {
  useInterceptors,
  COVERAGE_GAP_LABELS,
  STRATUM_LABELS,
  type InterceptorEntry,
} from "../hooks/useInterceptors";

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

export function InterceptorDetailPage() {
  const { name } = useParams<{ name: string }>();
  const { data, isLoading, isError } = useInterceptors();

  const entry = data?.entries.find((e) => e.guardName === name);

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

          <p
            className="mt-6 border-t border-border/40 pt-3 text-[10px] font-mono text-muted-foreground/70"
            data-testid="interceptor-detail-scope-note"
          >
            Not answered here yet: whether this interceptor currently works, what it costs, and what
            it has caught. Those are absent rather than blank — a placeholder would read as a value.
          </p>
        </>
      )}
    </div>
  );
}
