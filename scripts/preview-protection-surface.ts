#!/usr/bin/env bun
/**
 * A DESIGN PREVIEW of the operator rendering (mt#4287) — real bundle, real
 * catalog, SYNTHETIC aggregates, and zero database access.
 *
 * ## Why this exists, and what it is not
 *
 * This is NOT verification. `scripts/verify-protection-surface.ts` is, and it
 * scans a live render over live data. This script answers the different
 * question the principal owns: *does the surface read well* — layout, copy,
 * ordering, density (`humility.mdc §Subjective quality is not yours to
 * certify`). That judgment needs something to LOOK at, and it does not need the
 * numbers to be real.
 *
 * It exists because on 2026-08-19 the real ones were unreachable: the
 * interceptor-aggregates rollup is a full sequential scan over a 644 MB
 * `guard_events` table re-issued every 60s with no backoff, and it had left the
 * running cockpit's snapshot permanently `pending` (mt#4294). Starting a second
 * cockpit to work around that is what caused the incident mt#4294 records, so
 * this script deliberately touches no database at all — it serves the built
 * bundle and answers the two widget endpoints from disk.
 *
 * ## What is real here and what is not
 *
 * REAL: the built bundle (`src/cockpit/web/dist`), the router, every derivation
 * in `protection-summary.ts`, and the entire catalog — all 135 entries, their
 * true failure-class assignments, and the authored class copy, read from
 * `src/generated/interceptor-catalog.json`.
 *
 * SYNTHETIC: the fire-log figures (stops, flags, durations) and the canary
 * states. They are generated deterministically from each guard name, so the
 * render is stable across runs and diffable — but every NUMBER on the page is
 * invented. **Do not cite a figure from this preview as a measurement**, and say
 * "preview" whenever you show the screenshot.
 *
 * Usage:
 *   bun scripts/preview-protection-surface.ts            # serve, print URL
 *   MINSKY_PROTECTION_PREVIEW_PORT=4310 bun scripts/preview-protection-surface.ts
 *   MINSKY_PROTECTION_PREVIEW_DEGRADED=1 bun ...                    # force a broken check
 *
 * Prerequisite: `bun run cockpit:build` (this serves `dist`, not a dev server).
 */
const PORT = Number(process.env["MINSKY_PROTECTION_PREVIEW_PORT"] ?? 4310);
const DEGRADED = process.env["MINSKY_PROTECTION_PREVIEW_DEGRADED"] === "1";
const DIST = "src/cockpit/web/dist";
const CATALOG = "src/generated/interceptor-catalog.json";

const catalogFile = Bun.file(CATALOG);
if (!(await catalogFile.exists())) {
  console.error(`SKIP: ${CATALOG} not found — nothing to preview.`);
  process.exit(0);
}
const indexHtml = Bun.file(`${DIST}/index.html`);
if (!(await indexHtml.exists())) {
  console.error(`SKIP: ${DIST}/index.html not found — run \`bun run cockpit:build\` first.`);
  process.exit(0);
}

const catalog = (await catalogFile.json()) as {
  entries: Array<{ guardName: string; failureClasses: string[] }>;
  failureClasses: Record<string, { failure: string; question: string }>;
};

/** Deterministic per-name pseudo-randomness, so a rerun renders identically. */
function seedOf(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * A snapshot shaped exactly like the real one.
 *
 * The distribution is deliberately lopsided rather than uniform — a handful of
 * very busy names and a long quiet tail — because that is what the real corpus
 * looks like, and a uniform one would make the cost ordering look like it does
 * nothing.
 */
function buildSnapshot() {
  const names = catalog.entries.map((e) => e.guardName);
  const rows = names.map((guardName, i) => {
    const s = seedOf(guardName);
    const busy = s % 7 === 0;
    const fires = busy ? (s % 900) + 60 : s % 25;
    const deny = Math.floor(fires * ((s % 17) / 100));
    const warn = Math.floor(fires * ((s % 29) / 100));
    const allow = Math.max(0, fires - deny - warn);
    const measured = Math.floor(fires * 0.8);
    const avgMs = busy ? (s % 400) + 20 : (s % 40) + 2;

    // One deliberately broken check when asked, so the degraded path is
    // previewable — it is the state a reviewer most needs to see and the one
    // real data almost never shows on demand.
    const broken = DEGRADED && i === Math.floor(names.length / 3);

    return {
      guardName,
      fireLog: {
        window: {
          days: 7,
          fires,
          byDecision: { allow, warn, deny, other: 0 },
          overrides: { total: 0, byEnvVar: {} },
          duration:
            measured > 0
              ? {
                  avgMs,
                  p95Ms: avgMs * 2,
                  maxMs: avgMs * 5,
                  totalMs: avgMs * measured,
                  measuredFires: measured,
                }
              : null,
        },
        lifetime: {
          totalFires: fires * 12,
          firstFireAt: "2026-06-01T00:00:00.000Z",
          lastFireAt: fires > 0 ? "2026-08-18T00:00:00.000Z" : null,
        },
      },
      canary: broken
        ? { state: "broken", brokenSinceAt: "2026-08-17T09:00:00.000Z" }
        : { state: "passing", lastVerifiedAt: "2026-08-19T01:00:00.000Z" },
      health: null,
      calibration: null,
      registry: null,
    };
  });

  return {
    computedAt: new Date().toISOString(),
    windowDays: 7,
    population: rows.length,
    rows,
    declaredOnlyRows: [],
    calibrationReviewDue: [],
    sources: {},
    sourceFailures: [],
    refreshDurationMs: 0,
  };
}

const aggregates = { status: "ready" as const, snapshot: buildSnapshot() };

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const json = (payload: unknown) =>
      Response.json({ state: "ok", payload }, { headers: { "cache-control": "no-store" } });

    // Mirrors what a LOCAL (non-public-deployment) cockpit answers here —
    // `src/cockpit/server.ts:498`. Not an auth bypass: the local daemon is
    // ungated by design (mt#4023, so it cannot lock itself out), and this
    // preview is as local as it gets. Without it the shell renders its passkey
    // gate and the page under preview never mounts.
    if (pathname === "/api/auth/status") {
      return Response.json({ gated: false, authenticated: true, enrollmentOpen: false });
    }

    if (pathname === "/api/widget/interceptors/data") return json(catalog);
    if (pathname === "/api/widget/interceptor-aggregates/data") return json(aggregates);
    // Any other widget the shell asks for degrades honestly rather than 404ing
    // into an error boundary that would obscure the page being previewed.
    if (pathname.startsWith("/api/")) {
      return Response.json({ state: "degraded", reason: "not served by the preview" });
    }

    const asset = Bun.file(`${DIST}${pathname}`);
    if (pathname !== "/" && (await asset.exists())) {
      const ext = pathname.slice(pathname.lastIndexOf("."));
      return new Response(asset, {
        headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
      });
    }
    // SPA fallback — every route renders the shell.
    return new Response(Bun.file(`${DIST}/index.html`), {
      headers: { "content-type": "text/html" },
    });
  },
});

console.log(`PREVIEW (synthetic figures, real catalog + real bundle, no DB)`);
console.log(`  operator surface:  http://127.0.0.1:${server.port}/protection`);
console.log(`  maintainer surface: http://127.0.0.1:${server.port}/interceptors`);
console.log(`  catalog entries:   ${catalog.entries.length}`);
console.log(
  `  degraded check:    ${DEGRADED ? "yes (one broken)" : "no — set MINSKY_PROTECTION_PREVIEW_DEGRADED=1"}`
);
console.log(`\nEvery NUMBER on these pages is invented. Ctrl-C to stop.`);
