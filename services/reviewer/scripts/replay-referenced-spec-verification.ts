#!/usr/bin/env bun
/**
 * Replay harness for the mt#3919 referenced-task-spec mechanism.
 *
 * mt#3919's two Acceptance Tests are:
 *
 *   1. Replay PR #2761's criteria set (six criteria, one of which names
 *      mt#3874's spec) against the reviewer and confirm the mt#3874
 *      criterion is no longer reported BLOCKING-unmet.
 *   2. Negative control: construct a criteria set with a task-spec criterion
 *      that is genuinely NOT satisfied (target spec unmodified) and confirm
 *      the reviewer still reports it.
 *
 * A full live replay would call the real OpenAI model (the pattern
 * `replay-doc-impact.ts` and `replay-severity.ts` use) and requires
 * OPENAI_API_KEY + GITHUB_TOKEN — both absent in the implementer session
 * that authored this change (probed and confirmed absent; per the
 * established "subagent ships the artifact, main agent runs the live
 * verification" pattern from mt#1399 / mt#1403).
 *
 * This script instead deterministically replays the MECHANISM this task
 * actually changes: whether the reviewer's context-assembly layer
 * (`resolveReferencedTaskSpecs` + `buildReferencedTaskSpecsSection`) now
 * delivers the referenced spec's REAL content to the prompt, and whether
 * that content differs meaningfully between a satisfied criterion and a
 * genuinely-unsatisfied one. The LLM's own judgment given that content is a
 * separate concern this script cannot exercise offline — but the defect
 * this task fixes was that the reviewer had NO channel to that content at
 * all, and this script proves the channel now exists and is content-aware
 * (not a suppression that reports the same thing regardless of what the
 * referenced spec actually says).
 *
 * Fixtures below are the REAL mt#3915 (PR #2761) and mt#3874 spec text,
 * fetched via `tasks_spec_get` on 2026-08-11 — not synthesized.
 *
 * Usage:
 *   bun services/reviewer/scripts/replay-referenced-spec-verification.ts
 */

import type { TaskServiceInterface } from "@minsky/domain/tasks";
import { resolveReferencedTaskSpecs } from "../src/task-spec-fetch";
import { buildReferencedTaskSpecsSection } from "../src/prompt";

/**
 * `Task` itself is not re-exported from `@minsky/domain/tasks`'s barrel
 * (only `TaskServiceInterface` is) — derive the exact same nominal type from
 * the interface's own method signature instead of adding a second import
 * path for one fixture field.
 */
type SpecFetchResult = Awaited<ReturnType<TaskServiceInterface["getTaskSpecContent"]>>;

// ---------------------------------------------------------------------------
// Fixture: PR #2761's actual six success criteria (mt#3915's spec, verbatim)
// ---------------------------------------------------------------------------

const PR_2761_CRITERIA = `## Success Criteria

- [ ] \`package.json\` \`name\` is \`@edobry/minsky\`.
- [ ] \`package.json\` carries \`publishConfig: { "access": "public" }\` — scoped packages default to
      restricted, and this makes BOTH the manual publish and \`publish-npm.yml\`'s bare \`npm publish\`
      work without anyone remembering \`--access=public\`.
- [ ] \`GET https://registry.npmjs.org/@edobry%2Fminsky\` returns 200 after the first publish.
- [ ] ADR-033 carries an amendment recording that the unscoped name was REFUSED (with the 403
      verbatim), that the decided channel is now \`bun add -g @edobry/minsky\`, and that the CLI
      command is unchanged. The ADR must not be left asserting an install command that cannot work.
- [ ] Every doc/readme instance of \`bun add -g minsky\` is updated — enumerate with a repo-wide grep,
      do not assume the ADR is the only site.
- [ ] mt#3874's success criteria and acceptance tests are updated to the scoped name (they name
      \`registry.npmjs.org/minsky\` and the package's Settings page, both of which change).`;

// ---------------------------------------------------------------------------
// Fixture: mt#3874's spec, AFTER the 2026-08-10 amendment (real, current state)
// ---------------------------------------------------------------------------

const MT_3874_AMENDED_SPEC = `## Success Criteria

- [ ] \`GET https://registry.npmjs.org/minsky\` returns 200 with \`dist-tags.latest\` set and the
      expected maintainer — i.e. the package exists and we own the name.
- [ ] The npm package's Settings → Trusted Publisher lists GitHub org/user \`edobry\`, repository
      \`minsky\`, workflow filename \`publish-npm.yml\`, with the publish action allowed.

## AMENDED 2026-08-10: the package is \`@edobry/minsky\`, not \`minsky\`

The unscoped name is **unavailable** — npm refuses to create it.

### Corrections to this spec's own criteria

- **\`GET https://registry.npmjs.org/minsky\` returns 200** → the URL is now
  \`https://registry.npmjs.org/@edobry%2Fminsky\` (the \`/\` must be percent-encoded). The
  unscoped URL will keep returning 404 and that is the expected steady state, not a failure.
- **Trusted-publisher registration target** → the settings page is the SCOPED package's, at
  \`https://www.npmjs.com/package/@edobry/minsky/access\`.`;

// ---------------------------------------------------------------------------
// Fixture: mt#3874's spec, BEFORE the amendment (reconstructed by trimming at
// the amendment marker — this is the genuinely-unsatisfied negative control:
// the criteria still name the unscoped package and URL).
// ---------------------------------------------------------------------------

const AMENDMENT_MARKER = "## AMENDED 2026-08-10";
const amendmentSplitIndex = MT_3874_AMENDED_SPEC.indexOf(AMENDMENT_MARKER);
if (amendmentSplitIndex === -1) {
  throw new Error(`fixture error: "${AMENDMENT_MARKER}" not found in MT_3874_AMENDED_SPEC`);
}
const MT_3874_PRE_AMENDMENT_SPEC = MT_3874_AMENDED_SPEC.slice(0, amendmentSplitIndex).trim();

/**
 * A TaskServiceInterface stub implementing every required method — the
 * unused ones throw, so this satisfies the interface directly without an
 * `as unknown as` cast (custom/no-excessive-as-unknown flags that outside
 * test files, where `allowInTests` doesn't apply).
 */
function makeTaskService(specByTaskId: Record<string, string>): TaskServiceInterface {
  const notImplemented = (method: string) => async () => {
    throw new Error(`replay fixture: ${method} is not implemented`);
  };
  return {
    listTasks: notImplemented("listTasks"),
    getTask: notImplemented("getTask"),
    getTaskStatus: notImplemented("getTaskStatus"),
    setTaskStatus: notImplemented("setTaskStatus"),
    createTaskFromTitleAndSpec: notImplemented("createTaskFromTitleAndSpec"),
    deleteTask: notImplemented("deleteTask"),
    getTasks: notImplemented("getTasks"),
    getWorkspacePath: () => "/fake/workspace",
    getTaskSpecContent: async (taskId: string) => {
      const content = specByTaskId[taskId];
      if (content === undefined) throw new Error(`task ${taskId} not found`);
      const task: SpecFetchResult["task"] = {
        id: taskId,
        title: `Replay fixture for ${taskId}`,
        status: "DONE",
      };
      return { task, specPath: `/fake/${taskId}.md`, content };
    },
  };
}

async function runCase(
  label: string,
  taskService: TaskServiceInterface
): Promise<{ label: string; sectionContainsScopedForm: boolean; fetchStatus: string }> {
  const referencedSpecs = await resolveReferencedTaskSpecs({
    taskSpec: PR_2761_CRITERIA,
    boundTaskId: "mt#3915",
    taskService,
  });

  const section = buildReferencedTaskSpecsSection(referencedSpecs);
  const mt3874 = referencedSpecs.find((s) => s.taskId === "mt#3874");

  console.log(`\n=== ${label} ===`);
  console.log(`Referenced task ids extracted: ${referencedSpecs.map((s) => s.taskId).join(", ")}`);
  console.log(`mt#3874 fetchResult.status: ${mt3874?.fetchResult.status}`);
  console.log(`mt#3874 content fetched: ${mt3874?.content !== null}`);

  const sectionContainsScopedForm = (section ?? "").includes(
    "https://www.npmjs.com/package/@edobry/minsky/access"
  );
  console.log(
    `"## Referenced Task Specs" section shows the SCOPED settings-page URL: ${sectionContainsScopedForm}`
  );
  console.log("--- rendered section ---");
  console.log(section ?? "(none)");

  return {
    label,
    sectionContainsScopedForm,
    fetchStatus: mt3874?.fetchResult.status ?? "missing",
  };
}

async function main() {
  console.log("mt#3919 replay: PR #2761's criteria set against the referenced-spec mechanism\n");
  console.log(
    "This does not invoke the LLM (no OPENAI_API_KEY in this session — probed, confirmed " +
      "absent). It replays the CONTEXT-ASSEMBLY layer the LLM's verdict now depends on, and " +
      "checks that the two cases below produce genuinely DIFFERENT evidence — the negative-" +
      "control requirement mt#3919's second Acceptance Test names."
  );

  // Case 1 (AT #1 — the positive replay): mt#3874's spec IS amended (its real,
  // current state). The reviewer should now be able to see the scoped-name
  // update and no longer treat the criterion as unmet purely because the
  // artifact is outside the diff.
  const positive = await runCase(
    "AT#1 — mt#3874 satisfied (real, current spec state)",
    makeTaskService({ "mt#3874": MT_3874_AMENDED_SPEC })
  );

  // Case 2 (AT #2 — the negative control): mt#3874's spec is the
  // PRE-amendment state — genuinely unmodified, still naming the unscoped
  // package. The mechanism must still surface this truthfully (not silently
  // report Met), which is what "reject a suppression" requires.
  const negative = await runCase(
    "AT#2 — negative control: mt#3874 spec NOT amended (pre-2026-08-10 state)",
    makeTaskService({ "mt#3874": MT_3874_PRE_AMENDMENT_SPEC })
  );

  console.log("\n=== Verdict ===");
  console.log(`Positive case shows scoped form: ${positive.sectionContainsScopedForm}`);
  console.log(`Negative case shows scoped form: ${negative.sectionContainsScopedForm}`);

  const bothFetched = positive.fetchStatus === "found" && negative.fetchStatus === "found";
  const casesDiffer = positive.sectionContainsScopedForm !== negative.sectionContainsScopedForm;

  if (!bothFetched) {
    console.error("FAIL: expected both cases to reach fetchResult.status === 'found'.");
    process.exit(1);
  }
  if (!casesDiffer) {
    console.error(
      "FAIL: the positive and negative cases produced the SAME evidence — this would be a " +
        "suppression, not a verification. mt#3919's second Success Criterion rejects this."
    );
    process.exit(1);
  }

  console.log(
    "PASS: the mechanism delivers REAL, DIFFERENT content for the satisfied vs. unsatisfied " +
      "case — a reviewer (human or LLM) reading the '## Referenced Task Specs' section can now " +
      "distinguish them, which PR #2761's incident (R1 and R2 both reported the same BLOCKING " +
      "finding regardless of evidence in the PR body) shows the reviewer previously could not do " +
      "at all, because the referenced spec's content was never in its context."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
