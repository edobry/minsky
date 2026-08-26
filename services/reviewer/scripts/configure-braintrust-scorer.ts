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

const API_BASE = "https://api.braintrust.dev";

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

  const headers = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  };

  const projectRes = await fetch(
    `${API_BASE}/v1/project?project_name=${encodeURIComponent(cfg.projectName)}`,
    { headers, signal: AbortSignal.timeout(30000) }
  );
  if (!projectRes.ok) {
    throw new Error(`GET /v1/project failed: ${projectRes.status} ${await projectRes.text()}`);
  }
  const project = ((await projectRes.json()) as { objects?: { id: string }[] }).objects?.[0];
  if (!project) throw new Error(`no Braintrust project named ${cfg.projectName}`);
  console.log(`Project: ${cfg.projectName} (${project.id})`);

  // Starter allows ONE human-review score per project — check before creating.
  const existingRes = await fetch(`${API_BASE}/v1/project_score?limit=100`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const existing = ((await existingRes.json()) as { objects?: { name: string; id: string }[] })
    .objects;
  console.log(`Existing project scores: ${existing?.length ?? 0}`);
  for (const s of existing ?? []) console.log(`  - ${s.name} (${s.id})`);
  if (existing?.some((s) => s.name === SCORE_NAME)) {
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

  const res = await fetch(`${API_BASE}/v1/project_score`, {
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

main().catch((error) => {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
