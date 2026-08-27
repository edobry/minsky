import { describe, test, expect } from "bun:test";
import {
  parsePrometheusText,
  selectSamples,
  sumSamples,
  deriveProjectRef,
  CLIENT_CONNECTIONS_METRIC,
} from "./supavisor-metrics";

/**
 * Fixture lines copied VERBATIM from a live scrape of
 * `GET /v1/projects/{ref}/analytics/endpoints/metrics` on 2026-08-27, trimmed
 * to the label set that matters here. Synthetic-but-realistic beats a mock:
 * the label ordering, the `nil` string values and the exponent formatting are
 * all properties of the real endpoint that a hand-written fixture tends to
 * smooth away.
 */
const LIVE_FIXTURE = `# HELP supavisor_connections_active Active client connections
# TYPE supavisor_connections_active gauge
supavisor_connections_active{supabase_project_ref="yvkkrpyjhoiilmizlnac",service_type="pooler",az="nil",db_name="postgres",mode="transaction",region="us-west-2",tenant="yvkkrpyjhoiilmizlnac",type="single",user="postgres"} 76
supavisor_connections_active{supabase_project_ref="yvkkrpyjhoiilmizlnac",service_type="pooler",az="nil",db_name="postgres",mode="session",region="us-west-2",tenant="yvkkrpyjhoiilmizlnac",type="single",user="minsky_preview"} 1
supavisor_connections_active{supabase_project_ref="yvkkrpyjhoiilmizlnac",service_type="pooler",az="nil",db_name="postgres",mode="session",region="us-west-2",tenant="yvkkrpyjhoiilmizlnac",type="single",user="postgres"} 2
supavisor_connections_active{supabase_project_ref="yvkkrpyjhoiilmizlnac",service_type="pooler",az="nil",db_name="postgres",mode="transaction",region="us-west-2",tenant="yvkkrpyjhoiilmizlnac",type="single",user="minsky_preview"} 1
# HELP supavisor_client_connection_lifetime_ms_sum Client connection lifetime
# TYPE supavisor_client_connection_lifetime_ms_sum counter
supavisor_client_connection_lifetime_ms_sum{mode="transaction",user="postgres"} 5.109753351839e+12
supavisor_client_connection_lifetime_ms_count{mode="transaction",user="postgres"} 741243
pgbouncer_free_clients{supabase_project_ref="yvkkrpyjhoiilmizlnac",service_type="db"} 49
node_scrape_collector_success 1
`;

describe("parsePrometheusText", () => {
  test("parses name, labels and value from a real scrape", () => {
    const samples = parsePrometheusText(LIVE_FIXTURE);
    const active = samples.filter((s) => s.name === CLIENT_CONNECTIONS_METRIC);
    expect(active).toHaveLength(4);

    const txPostgres = active.find(
      (s) => s.labels["mode"] === "transaction" && s.labels["user"] === "postgres"
    );
    expect(txPostgres?.value).toBe(76);
    expect(txPostgres?.labels["tenant"]).toBe("yvkkrpyjhoiilmizlnac");
    expect(txPostgres?.labels["az"]).toBe("nil");
  });

  test("skips HELP/TYPE comment lines and blank lines", () => {
    const samples = parsePrometheusText(LIVE_FIXTURE);
    expect(samples.every((s) => !s.name.startsWith("#"))).toBe(true);
    // 4 gauges + sum + count + pgbouncer + node = 8 sample lines in the fixture.
    expect(samples).toHaveLength(8);
  });

  test("parses a metric with no label block", () => {
    const samples = parsePrometheusText(LIVE_FIXTURE);
    const node = samples.find((s) => s.name === "node_scrape_collector_success");
    expect(node?.value).toBe(1);
    expect(node?.labels).toEqual({});
  });

  test("parses exponent notation without losing magnitude", () => {
    const samples = parsePrometheusText(LIVE_FIXTURE);
    const sum = samples.find((s) => s.name === "supavisor_client_connection_lifetime_ms_sum");
    expect(sum?.value).toBe(5.109753351839e12);
  });

  test("ignores an optional trailing timestamp", () => {
    const samples = parsePrometheusText(`some_metric{a="b"} 42 1698000000000`);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBe(42);
  });

  test("parses NaN and infinities rather than dropping the sample", () => {
    const samples = parsePrometheusText(
      ["a_metric NaN", "b_metric +Inf", "c_metric -Inf"].join("\n")
    );
    expect(samples).toHaveLength(3);
    const values = samples.map((s) => s.value);
    // `?? 0` keeps the assertion honest if the sample is missing: 0 is not NaN,
    // so a dropped sample fails here rather than passing on a non-null assertion.
    expect(Number.isNaN(values[0] ?? 0)).toBe(true);
    expect(values[1]).toBe(Number.POSITIVE_INFINITY);
    expect(values[2]).toBe(Number.NEGATIVE_INFINITY);
  });

  test("skips a malformed line without losing the rest of the scrape", () => {
    const samples = parsePrometheusText(
      ["good_one 1", "!!! not a metric line !!!", "good_two 2"].join("\n")
    );
    expect(samples.map((s) => s.name)).toEqual(["good_one", "good_two"]);
  });

  test("handles escaped quotes and backslashes inside a label value", () => {
    const samples = parsePrometheusText(String.raw`m{note="a \"quoted\" v",path="c:\\tmp"} 7`);
    expect(samples[0]?.labels["note"]).toBe('a "quoted" v');
    expect(samples[0]?.labels["path"]).toBe("c:\\tmp");
    expect(samples[0]?.value).toBe(7);
  });
});

describe("selectSamples", () => {
  test("filters by an exact label match", () => {
    const samples = parsePrometheusText(LIVE_FIXTURE);
    const sessionMode = selectSamples(samples, CLIENT_CONNECTIONS_METRIC, { mode: "session" });
    expect(sessionMode).toHaveLength(2);
    expect(sessionMode.map((s) => s.value).sort()).toEqual([1, 2]);
  });

  test("a label the sample lacks is a NON-match, so a filter never widens the selection", () => {
    const samples = parsePrometheusText(LIVE_FIXTURE);
    // `pgbouncer_free_clients` carries no `mode` label at all.
    expect(selectSamples(samples, "pgbouncer_free_clients", { mode: "transaction" })).toHaveLength(
      0
    );
  });
});

describe("sumSamples", () => {
  test("sums every matching series", () => {
    const samples = parsePrometheusText(LIVE_FIXTURE);
    // All four modes/users: 76 + 1 + 2 + 1.
    expect(sumSamples(samples, CLIENT_CONNECTIONS_METRIC)).toBe(80);
    expect(sumSamples(samples, CLIENT_CONNECTIONS_METRIC, { mode: "transaction" })).toBe(77);
    expect(
      sumSamples(samples, CLIENT_CONNECTIONS_METRIC, { mode: "transaction", user: "postgres" })
    ).toBe(76);
  });

  test("returns undefined — NOT 0 — when nothing matches (mem#704)", () => {
    const samples = parsePrometheusText(LIVE_FIXTURE);
    expect(sumSamples(samples, "supavisor_renamed_upstream")).toBeUndefined();
    expect(sumSamples(samples, CLIENT_CONNECTIONS_METRIC, { mode: "nonsense" })).toBeUndefined();
  });

  test("a genuinely-zero gauge is distinguishable from an absent one", () => {
    const zeroed = parsePrometheusText(`${CLIENT_CONNECTIONS_METRIC}{mode="transaction"} 0`);
    expect(sumSamples(zeroed, CLIENT_CONNECTIONS_METRIC, { mode: "transaction" })).toBe(0);
    expect(sumSamples(zeroed, CLIENT_CONNECTIONS_METRIC, { mode: "session" })).toBeUndefined();
  });
});

/** This project's real ref, so the fixtures are the shapes actually in use. */
const REF = "yvkkrpyjhoiilmizlnac";

describe("deriveProjectRef", () => {
  // The point of this function is that the gauge and the pool under test address
  // the SAME project. A wrong answer here is a silently invalid measurement, so
  // both real Supabase URL shapes are covered, and unparseable input returns
  // null rather than a plausible guess.
  const POOLER_HOST = "aws-0-us-west-2.pooler.supabase.com";

  test("extracts the ref from a transaction-pooler URL (username after the dot)", () => {
    expect(deriveProjectRef(`postgres://postgres.${REF}:pw@${POOLER_HOST}:6543/postgres`)).toBe(
      REF
    );
  });

  test("extracts the ref from a session-pooler URL on :5432", () => {
    expect(deriveProjectRef(`postgres://postgres.${REF}:pw@${POOLER_HOST}:5432/postgres`)).toBe(
      REF
    );
  });

  test("extracts the ref from a direct-connection URL (host label after db.)", () => {
    expect(deriveProjectRef(`postgres://postgres:pw@db.${REF}.supabase.co:5432/postgres`)).toBe(
      REF
    );
  });

  test("accepts the postgresql:// scheme spelling", () => {
    expect(deriveProjectRef(`postgresql://postgres.${REF}:pw@${POOLER_HOST}:6543/postgres`)).toBe(
      REF
    );
  });

  test("survives a percent-encoded password containing @ and :", () => {
    expect(
      deriveProjectRef(`postgres://postgres.${REF}:p%40ss%3Aword@${POOLER_HOST}:6543/postgres`)
    ).toBe(REF);
  });

  test("returns null for a non-Supabase Postgres rather than guessing", () => {
    expect(deriveProjectRef("postgres://postgres:pw@localhost:5432/minsky")).toBeNull();
    expect(deriveProjectRef("postgres://user:pw@db.internal.example.com:5432/app")).toBeNull();
  });

  test("returns null for an unparseable string", () => {
    expect(deriveProjectRef("not a url")).toBeNull();
    expect(deriveProjectRef("")).toBeNull();
  });

  test("does not mistake a short dotted username for a ref", () => {
    // `postgres.local` is a username with a dot but no 16+ char ref after it.
    expect(deriveProjectRef("postgres://postgres.local:pw@somehost:5432/db")).toBeNull();
  });
});
