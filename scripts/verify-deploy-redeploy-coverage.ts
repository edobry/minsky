#!/usr/bin/env bun
/**
 * mt#3933 — verify the Deploy MCP workflow redeploys EVERY service that rides
 * the shared `ghcr.io/edobry/minsky:latest` tag.
 *
 * Why this exists: minsky-ops and minsky-mcp are configured for the same image
 * tag in the same Railway project, but only minsky-mcp was ever redeployed.
 * minsky-ops served one image from 2026-07-31 to 2026-08-10 — SUCCESS on
 * Railway and 200 on /health the whole time — so nothing short of a digest
 * comparison could see it. The workflow now redeploys both and fails closed if
 * a third service joins the tag without being added.
 *
 * This script does NOT re-implement that logic — re-implementing it would test
 * the copy, not the deploy path. It EXTRACTS the actual bash from the workflow
 * and runs it against a stub `railway` binary, so what is asserted is the code
 * that really ships. Hermetic: no Railway credentials, no network, no npm.
 *
 * Run: bun scripts/verify-deploy-redeploy-coverage.ts
 * Exit: 0 = all checks pass, 1 = a check failed.
 */

import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const WORKFLOW = ".github/workflows/deploy-minsky-mcp.yml";

/** The line the extracted slice starts at — everything before it is npm install + token selection. */
const SLICE_START = "# Railway identifiers from services/<svc>/deploy.config.ts, kept";

/** Services expected to be redeployed, with the ids their deploy.config.ts declares. */
const MINSKY_MCP = { name: "minsky-mcp", serviceId: "a7c5195f-55de-472a-87e4-34e921a15171" };
const MINSKY_OPS = { name: "minsky-ops", serviceId: "f6e3f285-8075-4845-934b-8e9bed15ab12" };
const EXPECTED = [MINSKY_MCP, MINSKY_OPS];

const repoRoot = process.cwd();
if (!existsSync(join(repoRoot, WORKFLOW))) {
  console.error(`FAIL: ${WORKFLOW} not found — run this from the repo root.`);
  process.exit(1);
}

/**
 * Pull the `run:` body of the "Trigger Railway redeploy" step out of the
 * workflow, from SLICE_START to the end of the block scalar, and dedent it.
 */
function extractRedeployScript(): string {
  const lines = readFileSync(join(repoRoot, WORKFLOW), "utf8").split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === SLICE_START);
  if (startIdx === -1) {
    throw new Error(
      `Could not find the slice anchor in ${WORKFLOW}:\n  ${SLICE_START}\n` +
        "The workflow was edited without updating this script's anchor."
    );
  }
  const anchorLine = lines[startIdx] ?? "";
  const indent = anchorLine.length - anchorLine.trimStart().length;
  const body: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // A blank line stays in the block; a non-blank line at lower indentation
    // ends the YAML block scalar (the next step's `- name:`).
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

interface RunResult {
  exitCode: number;
  output: string;
  railwayCalls: string[];
}

/** Run the extracted bash with a stub `railway` on PATH. */
async function runWorkflowBash(script: string): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "mt3933-"));
  const callLog = join(dir, "railway-calls.log");

  // The stub records its argv and succeeds, so the run exercises the real
  // control flow (which services, which ids, which token scope) without
  // touching Railway.
  const stubDir = join(dir, "bin");
  await Bun.$`mkdir -p ${stubDir}`.quiet();
  const stub = join(stubDir, "railway");
  writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(callLog)}\nexit 0\n`);
  chmodSync(stub, 0o755);

  const scriptPath = join(dir, "redeploy.sh");
  writeFileSync(scriptPath, `set -euo pipefail\n${script}\n`);

  const proc = Bun.spawnSync(["bash", scriptPath], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      // Supplied by the part of the step this slice deliberately skips.
      DEPLOY_TOKEN: "stub-token-not-a-real-credential",
      DEPLOY_TOKEN_SOURCE: "TEST_TOKEN",
    },
  });

  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
  return {
    exitCode: proc.exitCode ?? -1,
    output: `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`,
    railwayCalls: calls,
  };
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
    failures.push(label);
  }
}

const script = extractRedeployScript();

// ---------------------------------------------------------------------------
console.log("\n[1] Happy path — the workflow's own bash, unmodified");
// ---------------------------------------------------------------------------
const happy = await runWorkflowBash(script);
check("exits 0", happy.exitCode === 0, `exit=${happy.exitCode}\n${happy.output}`);
check("coverage guard passes", happy.output.includes("Shared-tag coverage verified"), happy.output);
for (const svc of EXPECTED) {
  check(
    `asserts ids against services/${svc.name}/deploy.config.ts`,
    happy.output.includes(`Railway ids verified against services/${svc.name}/deploy.config.ts.`)
  );
  check(
    `redeploys ${svc.name} from source`,
    happy.railwayCalls.some(
      (c) => c.includes("redeploy") && c.includes("--from-source") && c.includes(svc.serviceId)
    ),
    `railway calls:\n        ${happy.railwayCalls.join("\n        ")}`
  );
}

// ---------------------------------------------------------------------------
console.log("\n[2] Negative control — drop minsky-ops from the redeploy list");
// ---------------------------------------------------------------------------
// This is the exact pre-fix state: minsky-ops configured for the shared tag,
// and nothing redeploying it. The guard must refuse to deploy.
const withoutOps = script.replace(/\n\s*minsky-ops f6e3f285-[0-9a-f-]+"/, '"');
check(
  "the negative control actually modified the script",
  withoutOps !== script,
  "the REDEPLOY_SERVICES line shape changed — update this replacement"
);
const dropped = await runWorkflowBash(withoutOps);
check("exits non-zero", dropped.exitCode !== 0, `exit=${dropped.exitCode}`);
check(
  "names minsky-ops as uncovered",
  dropped.output.includes("not in this job's redeploy list") &&
    dropped.output.includes("minsky-ops"),
  dropped.output
);
check(
  "does not redeploy anything",
  dropped.railwayCalls.length === 0,
  `railway calls: ${dropped.railwayCalls.join(" | ")}`
);

// ---------------------------------------------------------------------------
console.log("\n[3] Negative control — a stale serviceId in the workflow");
// ---------------------------------------------------------------------------
const staleId = script.replace(MINSKY_OPS.serviceId, "00000000-0000-0000-0000-000000000000");
check("the negative control actually modified the script", staleId !== script);
const stale = await runWorkflowBash(staleId);
check("exits non-zero", stale.exitCode !== 0, `exit=${stale.exitCode}`);
check(
  "reports the id mismatch against the config",
  stale.output.includes("does not match services/minsky-ops/deploy.config.ts"),
  stale.output
);

// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
