#!/usr/bin/env bun
/**
 * Guard posture coverage CLI — mt#3981 (thin-hooks RFC rev. 2, phase 1, SC4/AT4).
 *
 * Enumerates, for every guard declared across `GUARD_REGISTRY` and `STANDALONE_GUARD_CANARIES`
 * (`scripts/lib/failure-policy-declarations.ts`'s union accessor): interception point (event +
 * matcher, or "standalone"), verdict shape(s), failure posture (both axes) per effect, and
 * timeout (registry entries only — standalone guards' timeouts live in `.claude/settings.json`,
 * outside this accessor's scope). This is the mt#3754 catalog's intended INPUT — the "derived
 * summary" SC4 requires — and doubles as the SC2/AT2 not-covered listing against the fire log's
 * observed guard population.
 *
 * Read-only, like its calibration-log sibling `check-coverage-receipts.ts`. Writes no state.
 *
 * Usage:
 *   bun scripts/check-guard-posture-coverage.ts             # table, all declared guards
 *   bun scripts/check-guard-posture-coverage.ts --json       # structured report
 *
 * Exit code: always 0 — this is a REPORT, not a gate. `notCovered` names in the JSON output are
 * a finding to review at the next calibration/catalog pass, not a failure to block on (per the
 * RFC rev. 2 rescope: SC2 is descoped to "registered population + explicit not-covered
 * listing," not full-corpus coverage).
 *
 * @see scripts/lib/failure-policy-declarations.ts — the union accessor this wraps
 * @see scripts/check-coverage-receipts.ts — the calibration-log sibling this mirrors
 * @see mt#3754 — the catalog umbrella this feeds
 */

const { getDeclaredGuardPostures, getPostureCoverage } = await import(
  "./lib/failure-policy-declarations"
);

function formatEffect(effect: {
  effect: string;
  verdictShape: string;
  failurePolicy: { failurePolicy: string; degradedPolicy: string };
  rationale?: string;
}): string {
  const base = `${effect.effect} (${effect.verdictShape}): unreachable=${effect.failurePolicy.failurePolicy}, degraded=${effect.failurePolicy.degradedPolicy}`;
  return effect.rationale ? `${base} — ${effect.rationale}` : base;
}

function main(): void {
  const json = process.argv.includes("--json");
  const declared = getDeclaredGuardPostures();
  const { covered, notCovered } = getPostureCoverage();

  if (json) {
    const results = covered.map((name) => {
      const posture = declared.get(name);
      if (!posture) throw new Error(`unreachable: ${name} listed as covered but not declared`);
      return {
        guardName: posture.guardName,
        source: posture.source,
        interceptionPoint:
          posture.source === "registry"
            ? { event: posture.event, matcher: posture.matcher ?? null }
            : "standalone",
        timeoutMs: posture.timeoutMs ?? null,
        effects: posture.effects,
      };
    });
    process.stdout.write(`${JSON.stringify({ results, notCovered }, null, 2)}\n`);
    return;
  }

  for (const name of covered) {
    const posture = declared.get(name);
    if (!posture) continue;
    const interception =
      posture.source === "registry"
        ? `${posture.event}${posture.matcher ? ` :: ${posture.matcher}` : ""}`
        : "standalone";
    const timeout = posture.timeoutMs !== undefined ? `${posture.timeoutMs}ms` : "n/a (standalone)";
    console.log(`${name} [${posture.source}] — ${interception} — timeout=${timeout}`);
    for (const effect of posture.effects) {
      console.log(`  - ${formatEffect(effect)}`);
    }
  }
  console.log("");
  console.log(`Declared: ${covered.length}`);
  if (notCovered.length > 0) {
    console.log(
      `Not covered (observed in the fire log, no declaration on either surface — SC2/AT2, review at the next catalog pass): ${notCovered.join(", ")}`
    );
  } else {
    console.log("Not covered: none (fire log empty or every observed guard is declared).");
  }
}

main();
