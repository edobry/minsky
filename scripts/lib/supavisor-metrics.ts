#!/usr/bin/env bun
/**
 * Supavisor CLIENT-connection metrics reader (mt#4547).
 *
 * WHY THIS EXISTS. `pg_stat_activity` cannot answer any question about
 * Supavisor's client-connection accounting. Supabase's Performance Tuning guide
 * says so outright — "`pg_stat_activity` only exposes information on direct
 * connections to the database. Information on the number of connections to
 * Supavisor is available via the metrics endpoint." — and a live read confirms
 * it: every row for this project carries `application_name = 'Supavisor'`,
 * because those rows ARE the pooler's own BACKEND connections. Every client
 * multiplexed through Supavisor is invisible there.
 *
 * The two quantities are different limits, per Supabase's own terminology:
 *   - CLIENT connections  — how many clients may connect to the pooler at once.
 *                           Capped by the compute tier's "max pooler clients"
 *                           (600 on Medium; `POOLER_CLIENT_BUDGET` in
 *                           packages/domain/src/persistence/providers/postgres-provider.ts).
 *   - BACKEND connections — how many connections the pooler opens to Postgres.
 *                           Bounded by the pooler's own pool size. This is what
 *                           `pg_stat_activity` shows.
 *
 * `supavisor_connections_active` is the first one — the gauge the 600 budget
 * caps, and the only channel that can answer mt#4547.
 *
 * NOTE ON SECRETS: the access token is read into a variable and never printed,
 * on any path. Callers that want to report on it should print its LENGTH only
 * (`terminal-command-best-practices.mdc §Secret handling` — a `${K:0:4}`-style
 * prefix is a partial leak, not a mitigation).
 */
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";

/**
 * Minsky's Supabase project ref (dev 2). A non-secret identifier, also declared
 * in `justfile` and `scripts/supabase/restart-project.ts`.
 */
export const DEFAULT_PROJECT_REF = "yvkkrpyjhoiilmizlnac";

export const MANAGEMENT_API_BASE = "https://api.supabase.com";

/** The gauge of CLIENT connections held by the pooler, per tenant/mode/user. */
export const CLIENT_CONNECTIONS_METRIC = "supavisor_connections_active";

/** One parsed Prometheus sample line. */
export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Parse Prometheus text-exposition format into samples.
 *
 * Deliberately tolerant: `# HELP` / `# TYPE` lines and blanks are skipped, an
 * optional trailing timestamp is ignored, and a line that does not parse is
 * SKIPPED rather than throwing — a single malformed line in an 800-line scrape
 * must not lose the other 799. Values `NaN` / `+Inf` / `-Inf` parse to the
 * corresponding JS numbers, which is what a caller comparing gauges wants.
 */
export function parsePrometheusText(text: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?[ \t]+(.+)$/.exec(line);
    if (!match) continue;

    const [, name, labelBlock, rest] = match;
    if (!name || rest === undefined) continue;

    // `rest` is `<value>` or `<value> <timestamp>`; the value is the first token.
    const valueToken = rest.trim().split(/[ \t]+/)[0];
    if (valueToken === undefined) continue;
    const value = parseMetricValue(valueToken);
    if (value === undefined) continue;

    samples.push({ name, labels: parseLabels(labelBlock), value });
  }
  return samples;
}

function parseMetricValue(token: string): number | undefined {
  if (token === "NaN") return Number.NaN;
  if (token === "+Inf" || token === "Inf") return Number.POSITIVE_INFINITY;
  if (token === "-Inf") return Number.NEGATIVE_INFINITY;
  const n = Number(token);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Parse a `{k="v",k2="v2"}` label block. Handles backslash escapes inside
 * quoted values (`\"`, `\\`, `\n`) per the exposition format; an absent or
 * empty block yields `{}`.
 */
function parseLabels(block: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!block) return labels;
  const inner = block.slice(1, -1); // strip { }
  if (!inner.trim()) return labels;

  let i = 0;
  while (i < inner.length) {
    // key
    const eq = inner.indexOf("=", i);
    if (eq === -1) break;
    const key = inner.slice(i, eq).trim().replace(/^,/, "").trim();
    // value — must be a quoted string
    if (inner[eq + 1] !== '"') break;
    let j = eq + 2;
    let value = "";
    while (j < inner.length) {
      const ch = inner[j];
      if (ch === "\\") {
        const next = inner[j + 1];
        value += next === "n" ? "\n" : (next ?? "");
        j += 2;
        continue;
      }
      if (ch === '"') break;
      value += ch;
      j += 1;
    }
    if (key) labels[key] = value;
    i = j + 1; // past closing quote
    while (i < inner.length && (inner[i] === "," || inner[i] === " ")) i += 1;
  }
  return labels;
}

/**
 * Select samples by metric name and an exact-match label filter. A label the
 * filter names but the sample lacks is a NON-match (absent is not equal to
 * anything), so a filter can never widen the selection by accident.
 */
export function selectSamples(
  samples: readonly MetricSample[],
  name: string,
  labelFilter: Readonly<Record<string, string>> = {}
): MetricSample[] {
  return samples.filter((s) => {
    if (s.name !== name) return false;
    for (const [k, v] of Object.entries(labelFilter)) {
      if (s.labels[k] !== v) return false;
    }
    return true;
  });
}

/**
 * Sum the selected samples' values.
 *
 * Returns `undefined` — NOT 0 — when nothing matched. A gauge that is genuinely
 * zero and a metric that is absent (renamed upstream, wrong label, scrape
 * failed) must not render as the same number: that is the can't-fail-probe
 * shape (mem#704), and this reading is the whole evidence base for mt#4547.
 */
export function sumSamples(
  samples: readonly MetricSample[],
  name: string,
  labelFilter: Readonly<Record<string, string>> = {}
): number | undefined {
  const selected = selectSamples(samples, name, labelFilter);
  if (selected.length === 0) return undefined;
  return selected.reduce((acc, s) => acc + s.value, 0);
}

/**
 * Resolve a Supabase Management API access token, in the same priority order
 * `scripts/supabase/restart-project.ts` uses:
 *   1. SUPABASE_ACCESS_TOKEN        (Supabase CLI convention)
 *   2. MINSKY_SUPABASE_ACCESS_TOKEN (Minsky-namespaced variant)
 *   3. supabase.accessToken in ~/.config/minsky/config.yaml
 */
export async function resolveSupabaseAccessToken(): Promise<string | null> {
  const envToken = process.env["SUPABASE_ACCESS_TOKEN"];
  if (envToken?.trim()) return envToken.trim();

  const minskyEnvToken = process.env["MINSKY_SUPABASE_ACCESS_TOKEN"];
  if (minskyEnvToken?.trim()) return minskyEnvToken.trim();

  try {
    const raw = await readFile(join(homedir(), ".config", "minsky", "config.yaml"), "utf-8");
    const parsed = parseYaml(raw) as { supabase?: { accessToken?: unknown } } | null;
    const token = parsed?.supabase?.accessToken;
    if (typeof token === "string" && token.trim()) return token.trim();
  } catch {
    // Missing, unreadable, or invalid YAML — the caller reports "no token".
  }
  return null;
}

/**
 * Fetch the project's Prometheus scrape. Throws with a message that never
 * echoes the token (an auth failure's body can quote the request).
 */
export async function fetchMetricsText(
  token: string,
  projectRef: string = DEFAULT_PROJECT_REF,
  timeoutMs = 30_000
): Promise<string> {
  const url = `${MANAGEMENT_API_BASE}/v1/projects/${projectRef}/analytics/endpoints/metrics`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // 429 is the one a caller is likely to cause and can fix: the Management
    // API enforces the vendor's once-a-minute scrape guidance rather than
    // merely recommending it (observed 2026-08-27 at a 10-20s poll cadence).
    const hint =
      res.status === 429
        ? " — the endpoint is rate limited; poll no faster than once a minute"
        : "";
    throw new Error(
      `metrics endpoint returned HTTP ${res.status} ${res.statusText} for project ${projectRef}${hint}`
    );
  }
  return await res.text();
}

/** A single client-connection reading, with the wall-clock time it was taken. */
export interface ClientConnectionReading {
  atIso: string;
  /** `undefined` when the metric was absent — see `sumSamples`. */
  connections: number | undefined;
  /** Total samples in the scrape, so a caller can spot a truncated response. */
  sampleCount: number;
}

/**
 * Read `supavisor_connections_active` for one tenant/mode/user.
 *
 * `mode` is `"transaction"` (`:6543`, what production queries traverse) or
 * `"session"` (`:5432`, the LISTEN connection — mt#3497's subject). They are
 * separate label values in one scrape, so a caller never has to probe twice.
 */
export async function readClientConnections(
  token: string,
  options: {
    projectRef?: string;
    mode?: "transaction" | "session";
    user?: string;
    nowIso: string;
  }
): Promise<ClientConnectionReading> {
  const text = await fetchMetricsText(token, options.projectRef ?? DEFAULT_PROJECT_REF);
  const samples = parsePrometheusText(text);
  const filter: Record<string, string> = {};
  if (options.mode) filter["mode"] = options.mode;
  if (options.user) filter["user"] = options.user;
  return {
    atIso: options.nowIso,
    connections: sumSamples(samples, CLIENT_CONNECTIONS_METRIC, filter),
    sampleCount: samples.length,
  };
}
