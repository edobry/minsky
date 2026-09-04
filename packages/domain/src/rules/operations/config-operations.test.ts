/**
 * mt#4866 SC1 — `rules enable|disable` must reject an id that names nothing.
 *
 * Pre-fix behaviour, reproduced live 2026-09-04 at `d667c9634`:
 *
 *     disableRule(ws, "no-such-rule-xyz")
 *       -> {"enabled":[],"disabled":["no-such-rule-xyz"]}
 *
 * and `.minsky/config.yaml` gained:
 *
 *     rules:
 *       presets: []
 *       enabled: []
 *       disabled:
 *         - no-such-rule-xyz
 *
 * `enableRule`/`disableRule` pushed and filtered string arrays with no lookup
 * against any rule source. Combined with the resolver defect fixed in the same
 * task (SC6), that config then resolved to ZERO active rules — so the first
 * `rules disable` a user ran on a fresh project silently deselected everything.
 */
/* eslint-disable custom/no-real-fs-in-tests -- `readRulesSelectionConfig` /
 * `writeRulesSelectionConfig` hardcode `import fs from "fs/promises"` and
 * `RuleService` takes a workspace PATH and reads it directly; neither has an
 * injectable fs seam on this path. Giving them a real scratch workspace is
 * therefore the honest fixture and needs no module patching at all — strictly
 * better than a spyOn per `testing-standards.mdc §Testable Design`. Same
 * rationale and shape as the sibling `crud-operations.test.ts`: mkdtemp() under
 * the OS tmpdir plus afterEach cleanup, which avoids the shared-state and
 * parallel-run races the rule guards against. Extracting an fs seam would change
 * exported signatures with live consumers, which RFC Phase 0 does not scope. */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { enableRule, disableRule, readRulesSelectionConfig } from "./config-operations";
import { ValidationError } from "../../errors/index";

const REAL_RULE_ID = "a-real-local-rule";
const SCAFFOLDED_TEMPLATE_ID = "minsky-workflow";
// The seventh template, omitted from init's scaffold list per SC4 but still a
// selectable id because validation reads DEFAULT_TEMPLATES, not that list.
const SEVENTH_TEMPLATE_ID = "minsky-session-management";
const UNKNOWN_ID = "no-such-rule-xyz";

let scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  scratchDirs = [];
});

/**
 * A workspace carrying one real `.minsky/rules/*.mdc` source and a config file
 * with no `rules:` block — the shape a freshly-initialized project has.
 */
async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mt4866-config-ops-"));
  scratchDirs.push(dir);

  await mkdir(join(dir, ".minsky", "rules"), { recursive: true });
  await writeFile(
    join(dir, ".minsky", "rules", `${REAL_RULE_ID}.mdc`),
    [
      "---",
      `name: ${REAL_RULE_ID}`,
      "description: A rule that exists on disk.",
      "---",
      "",
      "Body.",
    ].join("\n"),
    "utf8"
  );
  await writeFile(join(dir, ".minsky", "config.yaml"), "tasks:\n  backend: minsky\n", "utf8");
  return dir;
}

async function readConfigYaml(dir: string): Promise<string> {
  return String(await readFile(join(dir, ".minsky", "config.yaml"), "utf8"));
}

describe("rules selection id validation (mt#4866 SC1)", () => {
  it("disableRule rejects an unknown id and names it", async () => {
    const dir = await makeWorkspace();
    await expect(disableRule(dir, UNKNOWN_ID)).rejects.toThrow(ValidationError);
    await expect(disableRule(dir, UNKNOWN_ID)).rejects.toThrow(UNKNOWN_ID);
  });

  it("enableRule rejects an unknown id and names it", async () => {
    const dir = await makeWorkspace();
    await expect(enableRule(dir, UNKNOWN_ID)).rejects.toThrow(ValidationError);
    await expect(enableRule(dir, UNKNOWN_ID)).rejects.toThrow(UNKNOWN_ID);
  });

  // The half that actually cost something before the fix: the id was PERSISTED.
  it("the config file is not written when the id is rejected", async () => {
    const dir = await makeWorkspace();
    const before = await readConfigYaml(dir);

    await expect(disableRule(dir, UNKNOWN_ID)).rejects.toThrow(ValidationError);

    expect(await readConfigYaml(dir)).toBe(before);
    expect(await readConfigYaml(dir)).not.toContain(UNKNOWN_ID);
    // No `rules:` block was created either — rejection must not initialize one.
    expect(await readConfigYaml(dir)).not.toContain("rules:");
  });

  it("accepts a rule that exists on disk, and persists it", async () => {
    const dir = await makeWorkspace();
    const result = await disableRule(dir, REAL_RULE_ID);

    expect(result.disabled).toContain(REAL_RULE_ID);
    expect(await readConfigYaml(dir)).toContain(REAL_RULE_ID);
    expect((await readRulesSelectionConfig(dir)).disabled).toContain(REAL_RULE_ID);
  });

  // A user may decline a rule `init` is about to scaffold, or one they deleted by
  // hand. Neither appears in listRules, so validating against on-disk sources
  // alone would reject both as typos.
  it("accepts a scaffoldable template id that is not on disk", async () => {
    const dir = await makeWorkspace();
    const result = await disableRule(dir, SCAFFOLDED_TEMPLATE_ID);
    expect(result.disabled).toContain(SCAFFOLDED_TEMPLATE_ID);
  });

  it("accepts the seventh template id, which init does not scaffold (SC4)", async () => {
    const dir = await makeWorkspace();
    const result = await enableRule(dir, SEVENTH_TEMPLATE_ID);
    expect(result.enabled).toContain(SEVENTH_TEMPLATE_ID);
  });

  // A workspace with no `.minsky/rules/` at all is the pre-init case, not a
  // failure: template ids still validate, unknown ids still reject.
  it("validates against template ids when no rules directory exists yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt4866-config-ops-bare-"));
    scratchDirs.push(dir);

    await expect(disableRule(dir, UNKNOWN_ID)).rejects.toThrow(ValidationError);
    const result = await disableRule(dir, SCAFFOLDED_TEMPLATE_ID);
    expect(result.disabled).toContain(SCAFFOLDED_TEMPLATE_ID);
  });
});
