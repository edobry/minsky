/**
 * Facet controls and axis chips for the `/interceptors` catalog (mt#4056).
 *
 * Extracted from `InterceptorsPage` rather than inlined: the page was already
 * near its max-lines ceiling, and the facet predicate is the piece worth
 * testing on its own — filtering is where the guard/detector/injector family
 * words become FILTERS over axis 2 rather than stored kinds, so
 * {@link matchesFacets} is the thing that has to stay honest.
 *
 * @see mt#4056 — slice 1b
 * @see docs/architecture/interceptors.md — the ontology these axes come from
 */
import {
  FAMILY_LABELS,
  FAMILY_ORDER,
  ALL_INTERCEPTION_POINTS,
  INTERVENTION_TYPE_ORDER,
  MECHANISM_LABELS,
  MECHANISM_ORDER,
  ROLE_LABELS,
  ROLE_ORDER,
  formatIntervention,
  type InterceptionPoint,
  type InterceptorEntry,
  type InterceptorFamily,
} from "../hooks/useInterceptors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

/** Sentinel for "no constraint on this facet". */
export const ANY = "__any__";

export interface InterceptorFacets {
  point: string;
  family: string;
  mechanism: string;
  intervention: string;
  role: string;
}

export const NO_FACETS: InterceptorFacets = {
  point: ANY,
  family: ANY,
  mechanism: ANY,
  intervention: ANY,
  role: ANY,
};

/**
 * Does this entry satisfy every active facet?
 *
 * Family membership goes through `families`, which the generator COMPUTES from
 * the intervention set — never a stored kind. An entry can satisfy two family
 * facets (ontology amendment (a)), which is why this is `includes` rather than
 * an equality test, and why the per-family counts do not sum to the population.
 */
export function matchesFacets(entry: InterceptorEntry, facets: InterceptorFacets): boolean {
  if (facets.point !== ANY && entry.point !== facets.point) return false;
  if (facets.family !== ANY && !entry.families.includes(facets.family as InterceptorFamily)) {
    return false;
  }
  if (facets.mechanism !== ANY && entry.mechanism !== facets.mechanism) return false;
  if (facets.role !== ANY && entry.role !== facets.role) return false;
  if (
    facets.intervention !== ANY &&
    !entry.interventions.some((i) => i.type === facets.intervention)
  ) {
    return false;
  }
  return true;
}

function Facet({
  label,
  value,
  onChange,
  allLabel,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  allLabel: string;
  options: Array<{ value: string; label: string }>;
  testId: string;
}) {
  return (
    // The `Select` primitive, never a native `<select>` — a native one keeps
    // `appearance: auto` and paints a macOS aqua pop-up under the tray's
    // WKWebView in a dark-mode-first UI (mt#3347).
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} data-testid={testId} className="h-7 w-auto font-mono">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The interception-point facet's options (mt#4603).
 *
 * Built from `ALL_INTERCEPTION_POINTS`, NOT `INTERCEPTION_POINT_ORDER`:
 * `matchesFacets` above compares against `entry.point`, whose domain is the
 * full fifteen-member union, so the options must be that same domain. The
 * spine's deliberate nine-member subset was used here until mt#4603, which left
 * six points unselectable — including `SessionStart` and `PostCompact`, the two
 * with live catalog members (`session-start`,
 * `record-conversation-run-state`). Those entries were listed but unreachable
 * by any choice a reader could make.
 *
 * EXPORTED so a test can pin the option domain against the predicate's domain.
 * Inlined into the JSX, this expression had no seam: a test could assert the
 * constant and the predicate and still not notice the component reading the
 * wrong list — which is exactly how the defect survived a completeness census
 * covering six other surfaces.
 *
 * The label is the raw point name, deliberately unprettified: these are the
 * harness's own event names, and a reader matching one against
 * `.claude/settings.json` needs the exact string.
 */
export const POINT_FACET_OPTIONS: { value: InterceptionPoint; label: string }[] =
  ALL_INTERCEPTION_POINTS.map((p) => ({ value: p, label: p }));

export function InterceptorFacetBar({
  facets,
  onChange,
}: {
  facets: InterceptorFacets;
  onChange: (next: InterceptorFacets) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="interceptor-facets">
      <Facet
        label="Filter by interception point"
        testId="interceptors-point-filter"
        value={facets.point}
        onChange={(point) => onChange({ ...facets, point })}
        allLabel="Any interception point"
        options={POINT_FACET_OPTIONS}
      />
      <Facet
        label="Filter by family"
        testId="interceptors-family-filter"
        value={facets.family}
        onChange={(family) => onChange({ ...facets, family })}
        allLabel="Any family"
        options={FAMILY_ORDER.map((f) => ({ value: f, label: FAMILY_LABELS[f] }))}
      />
      <Facet
        label="Filter by intervention type"
        testId="interceptors-intervention-filter"
        value={facets.intervention}
        onChange={(intervention) => onChange({ ...facets, intervention })}
        allLabel="Any intervention"
        options={INTERVENTION_TYPE_ORDER.map((t) => ({ value: t, label: t }))}
      />
      <Facet
        label="Filter by decision mechanism"
        testId="interceptors-mechanism-filter"
        value={facets.mechanism}
        onChange={(mechanism) => onChange({ ...facets, mechanism })}
        allLabel="Any mechanism"
        options={MECHANISM_ORDER.map((m) => ({ value: m, label: MECHANISM_LABELS[m] }))}
      />
      <Facet
        label="Filter by role"
        testId="interceptors-role-filter"
        value={facets.role}
        onChange={(role) => onChange({ ...facets, role })}
        allLabel="Any role"
        options={ROLE_ORDER.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
      />
    </div>
  );
}

/**
 * The two zero-family states, rendered as DIFFERENT markers (mt#4056 SC3).
 *
 * This is the component the whole slice turns on. `out-of-model` is a finding
 * about the ontology — the entity declares a capability outside the three
 * family words, and minting a fourth is a principal-reserved naming decision —
 * so it renders in the neutral register, as a fact. `unclassified` is missing
 * data and renders as a gap, in amber. A blank cell for either would say
 * "belongs to no family" in one case and "we never wrote it down" in the
 * other, which is the absence-vs-declaration conflation this catalog exists to
 * prevent.
 */
export function FamilyChips({ entry }: { entry: InterceptorEntry }) {
  if (entry.familyState === "unclassified") {
    return (
      <span
        className="text-warn-amber"
        data-testid="interceptor-family-unclassified"
        title={
          entry.deliberatelyUnauthored
            ? "No coordinates authored, by decision — a fire-log fixture or a name with no source module."
            : "No coordinates authored for this name."
        }
      >
        {entry.deliberatelyUnauthored ? "unclassified (by decision)" : "unclassified"}
      </span>
    );
  }

  if (entry.familyState === "out-of-model") {
    return (
      <span
        className="text-muted-foreground"
        data-testid="interceptor-family-out-of-model"
        title="Declares a capability outside the three family words. Not a coverage gap — the corpus reporting that guard/detector/injector do not partition it."
      >
        outside the family model
      </span>
    );
  }

  return (
    <span className="flex flex-wrap gap-1" data-testid="interceptor-family-classified">
      {entry.families.map((f) => (
        <span key={f} className="rounded bg-muted px-1 py-px text-foreground" title={FAMILY_LABELS[f]}>
          {f}
        </span>
      ))}
    </span>
  );
}

/** The three axes for one row, with an explicit marker wherever one is a gap. */
export function AxisChips({ entry }: { entry: InterceptorEntry }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="interceptor-axes">
      {entry.point ? (
        <span className="text-foreground" title={`Interception point (from ${entry.pointSource})`}>
          {entry.point}
        </span>
      ) : (
        <span className="text-warn-amber" data-testid="interceptor-point-gap" title="No declaring source establishes where this sits.">
          point undeclared
        </span>
      )}

      <span aria-hidden="true" className="text-muted-foreground/40">
        ·
      </span>

      {entry.interventions.length > 0 ? (
        <span className="text-muted-foreground">
          {entry.interventions.map(formatIntervention).join(" ")}
        </span>
      ) : (
        <span className="text-warn-amber" data-testid="interceptor-interventions-gap">
          interventions unauthored
        </span>
      )}

      <span aria-hidden="true" className="text-muted-foreground/40">
        ·
      </span>

      {entry.mechanism ? (
        <span className="text-muted-foreground" title={MECHANISM_LABELS[entry.mechanism]}>
          {entry.mechanism}
        </span>
      ) : (
        <span className="text-warn-amber" data-testid="interceptor-mechanism-gap">
          mechanism unauthored
        </span>
      )}

      <span aria-hidden="true" className="text-muted-foreground/40">
        ·
      </span>

      {entry.role ? (
        <span className="text-muted-foreground" title={ROLE_LABELS[entry.role]}>
          {entry.role}
        </span>
      ) : (
        <span className="text-warn-amber" data-testid="interceptor-role-gap">
          role unauthored
        </span>
      )}

      <span aria-hidden="true" className="text-muted-foreground/40">
        ·
      </span>

      <FamilyChips entry={entry} />
    </span>
  );
}
