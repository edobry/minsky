#!/usr/bin/env bun
/**
 * Configure the ONE categorical Human Review score the gold set is labeled
 * with (mt#2746).
 *
 * A script rather than a click-path because the task's point is a REPEATABLE
 * labeling loop: a future corpus refresh needs the same scorer in a possibly
 * fresh project, and Braintrust's Starter tier allows exactly one human-review
 * score per project, so getting it wrong twice is not free.
 *
 * ## Why the option values look arbitrary
 *
 * Braintrust requires each categorical option to carry "a unique percentage
 * value between 0% and 100% (stored as 0 to 1)" — there is no string-valued
 * categorical score. The numbers below are therefore IDENTIFIERS, not
 * magnitudes: they exist only so the stored value maps 1:1 back to an option
 * NAME at scoring time.
 *
 * Nothing downstream may treat them as a scale. `cohensKappa` compares
 * categories by string equality precisely so that the distance between
 * `cant_tell` and `valid_blocking` never enters the statistic — treating these
 * as ordinal would silently make kappa ordinal-over-nominal and inflate it.
 *
 * `config.destination` is set to `expected` so the reviewer's choice lands in
 * the record's `expected` field. The vendor doc verbatim-documents that switch
 * for FREE-FORM scores; whether a CATEGORICAL score honors it is not stated in
 * the docs or the OpenAPI spec (`destination` is an undescribed nullable
 * string). So this script READS BACK what Braintrust stored and prints it —
 * do not assume the field took effect because the POST returned 200.
 *
 * Dry-run by default. Pass `--execute` to create.
 *
 * @see mt#2746
 */

import { readBraintrustConfig } from "@minsky/domain/observability/braintrust";

const SCORE_NAME = "reviewer-finding-label";

/** Page size for the existing-score listing. No pagination — see the caller. */
const SCORE_PAGE_LIMIT = 100;

/**
 * The 4 options. Values are identifiers (see docblock) — distinct, ordered
 * only so the assignment is stable across re-runs.
 */
export const SCORE_CATEGORIES = [
  { name: "false_positive", value: 0 },
  { name: "cant_tell", value: 0.33 },
  { name: "valid_nonblocking", value: 0.67 },
  { name: "valid_blocking", value: 1 },
] as const;

/**
 * Normalize a configured Braintrust endpoint into a base for URL building.
 *
 * Exists so the endpoint is taken from config rather than hardcoded: `apiUrl`
 * / `BRAINTRUST_API_URL` is what a self-hosted or region-pinned install sets,
 * and a hardcoded host would silently create the scorer somewhere else.
 */
export function normalizeApiBase(configuredUrl: string): string {
  return configuredUrl.replace(/\/+$/, "");
}

/**
 * List URL for a project's human-review scores, SCOPED to one project.
 *
 * Unscoped, the list spans every project the API key can see — so a same-named
 * score in an unrelated project reads as "already exists" here and this script
 * skips creation, leaving the intended project with no scorer at all.
 */
export function buildProjectScoreListUrl(apiBase: string, projectId: string): string {
  return `${apiBase}/v1/project_score?limit=${SCORE_PAGE_LIMIT}&project_id=${encodeURIComponent(projectId)}`;
}

/** One row of the project-score listing, as much of it as this script reads. */
export interface ListedScore {
  name: string;
  id: string;
  project_id?: string;
}

/**
 * Keep only the scores belonging to `projectId`, as a second line of defense
 * behind the `project_id` query param.
 *
 * The param is documented, but an ignored query param is silently accepted —
 * the response looks identical whether or not it applied, so there would be
 * nothing to notice if the scoping were inert.
 *
 * A row with NO `project_id` is kept, not dropped. Its scope is unknown, and
 * treating unknown as "not ours" would hide a genuinely existing scorer and
 * push this script into creating a duplicate against Braintrust's
 * one-human-review-score-per-project ceiling. Between a spurious "already
 * exists" (which stops and tells the operator) and a spurious create (which
 * burns the project's only slot), stopping is the safer error.
 */
export function filterScoresToProject(scores: ListedScore[], projectId: string): ListedScore[] {
  return scores.filter((s) => s.project_id === undefined || s.project_id === projectId);
}

export function buildScorePayload(projectId: string): Record<string, unknown> {
  return {
    project_id: projectId,
    name: SCORE_NAME,
    description:
      "mt#2746 reviewer-benchmark gold set. Label each finding blind: was it a real issue, " +
      "and if so was it blocking? Values are identifiers, not a scale.",
    score_type: "categorical",
    categories: SCORE_CATEGORIES.map((c) => ({ name: c.name, value: c.value })),
    config: { multi_select: false, destination: "expected" },
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  console.log("=== Braintrust human-review scorer (mt#2746) ===");

  const cfg = await readBraintrustConfig();
  if (!cfg) throw new Error("Braintrust config unresolved — refusing.");

  // Use the CONFIGURED endpoint, not a hardcoded host: `apiUrl` /
  // `BRAINTRUST_API_URL` exists so a self-hosted or region-pinned install can
  // point elsewhere, and hardcoding would silently create the scorer in the
  // wrong place for anyone who set it. `readBraintrustConfig` surfaces it as
  // `appUrl` (which is derived from `apiUrl` — see the docblock in
  // push-braintrust-gold-set.ts on why that name is misleading).
  const apiBase = normalizeApiBase(cfg.appUrl);
  console.log(`API: ${apiBase}`);

  const headers = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  };

  const projectRes = await fetch(
    `${apiBase}/v1/project?project_name=${encodeURIComponent(cfg.projectName)}`,
    { headers, signal: AbortSignal.timeout(30000) }
  );
  if (!projectRes.ok) {
    throw new Error(`GET /v1/project failed: ${projectRes.status} ${await projectRes.text()}`);
  }
  const project = ((await projectRes.json()) as { objects?: { id: string }[] }).objects?.[0];
  if (!project) throw new Error(`no Braintrust project named ${cfg.projectName}`);
  console.log(`Project: ${cfg.projectName} (${project.id})`);

  // Starter allows ONE human-review score per project — check before creating.
  //
  // Scoped by `project_id`: unscoped, the list spans every project the key can
  // see, so a same-named score in an unrelated project would make this report
  // "already exists" and skip creation, leaving THIS project without a scorer.
  // The listing is deliberately not also filtered by name — seeing every score
  // in the project is what makes the one-per-project ceiling visible.
  const existingRes = await fetch(buildProjectScoreListUrl(apiBase, project.id), {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  // Fail closed on a failed lookup. Parsing an error body yields no `objects`,
  // which falls through to `[]` — indistinguishable from "this project has no
  // scores yet", so a 401 or a 500 would read as permission to create one. The
  // cost of that mistake is not a retry: Starter allows a single human-review
  // score per project, so a spurious create burns the only slot.
  if (!existingRes.ok) {
    throw new Error(
      `GET /v1/project_score failed: ${existingRes.status} ${await existingRes.text()}`
    );
  }
  const returned = ((await existingRes.json()) as { objects?: ListedScore[] }).objects ?? [];
  const existing = filterScoresToProject(returned, project.id);
  if (existing.length !== returned.length) {
    console.warn(
      `NOTE: the API returned ${returned.length} score(s) but only ${existing.length} belong to ` +
        `this project — the project_id filter did not apply server-side.`
    );
  }

  // limit=100 with no pagination. Starter allows one human-review score per
  // project, so a full page here means something unexpected, not a normal
  // large project — say so rather than silently reading a truncated list.
  if (returned.length >= SCORE_PAGE_LIMIT) {
    console.warn(
      `NOTE: hit the ${SCORE_PAGE_LIMIT}-row page limit; this listing may be truncated and an ` +
        `existing "${SCORE_NAME}" could be beyond it.`
    );
  }

  console.log(`Existing project scores: ${existing.length}`);
  for (const s of existing) console.log(`  - ${s.name} (${s.id})`);
  if (existing.some((s) => s.name === SCORE_NAME)) {
    console.log(`\n"${SCORE_NAME}" already exists — nothing to do.`);
    return;
  }

  const payload = buildScorePayload(project.id);
  console.log("\nPayload:");
  console.log(JSON.stringify(payload, null, 2));

  if (!execute) {
    console.log("\nDRY RUN — nothing created. Re-run with --execute.");
    return;
  }

  const res = await fetch(`${apiBase}/v1/project_score`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text();
  console.log(`\nPOST /v1/project_score -> ${res.status} ${res.statusText}`);
  if (!res.ok) throw new Error(`create failed: ${body}`);

  // Read back rather than trusting the 200: `destination` is an undescribed
  // nullable string, so an unsupported value could be accepted and dropped.
  const created = JSON.parse(body) as Record<string, unknown>;
  console.log("Stored record:");
  console.log(JSON.stringify(created, null, 2));

  const storedConfig = created.config as Record<string, unknown> | undefined;
  if (storedConfig?.destination !== "expected") {
    console.warn(
      `\nWARNING: requested config.destination="expected" but Braintrust stored ` +
        `${JSON.stringify(storedConfig?.destination)}. The reviewer's choice will land as a ` +
        `SCORE (0-1) rather than in \`expected\`. That is still usable — the option values are ` +
        `distinct, so score-human-labels.ts can map the number back to its option NAME — but ` +
        `the export reader must be pointed at the score, not \`expected\`.`
    );
  }
}

// Guarded, like every sibling script here. Unguarded, `main()` runs on IMPORT —
// so the test file that imports `buildScorePayload` also fired a live Braintrust
// API call, and on a machine without a key that throws and `process.exit(1)`
// takes the whole test runner down with it, mid-suite and with no failing
// assertion to point at. A configured local key hides this completely: main()
// simply succeeds, the suite continues, and the only symptom is a network call
// nobody asked for.
if (import.meta.main) {
  main().catch((error) => {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
