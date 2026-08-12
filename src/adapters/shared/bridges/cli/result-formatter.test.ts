/**
 * Generic-fallback rendering tests (mt#3870).
 *
 * The defect this pins: a command whose result carried neither `message` nor
 * `output` had its entire payload replaced by `✅ Success`, because the
 * fallback printed the boolean and dropped everything else. mt#3478 fixed two
 * commands that way (`config doctor`, `config validate`); the audit in
 * `scripts/audit-cli-output-coverage.ts` found 33 in the same shape, 30 of them
 * with no `--json` flag to recover the payload through.
 *
 * These tests are the regrowth guard the audit cannot be: they assert the
 * fallback's invariant directly, so re-introducing a bare-success branch fails
 * here rather than shipping as another silently mute command.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  DefaultCommandResultFormatter,
  SWITCH_HANDLED_COMMAND_IDS,
  formatPayloadKeys,
} from "./result-formatter";
import { log } from "@minsky/shared/logger";
import type { SharedCommand } from "../../command-registry";

/** A command id deliberately absent from the switch, so every case falls through. */
const genericCommand = { id: "audit.fixture" } as SharedCommand;

describe("formatPayloadKeys", () => {
  test("returns the payload keys a command actually carried", () => {
    expect(formatPayloadKeys({ success: true, cwd: "/tmp/x", tasksBackend: "minsky" })).toEqual([
      "cwd: /tmp/x",
      "tasksBackend: minsky",
    ]);
  });

  test("omits status, projection, and CLI-plumbing keys", () => {
    const lines = formatPayloadKeys({
      success: true,
      printed: true,
      message: "m",
      output: "o",
      error: "e",
      errors: ["e1"],
      json: true,
      debug: false,
      kept: 1,
    });
    expect(lines).toEqual(["kept: 1"]);
  });

  test("renders a short structured value inline and a long one as an indented block", () => {
    const [inline] = formatPayloadKeys({ success: true, staged: [] });
    expect(inline).toBe("staged: []");

    const [block] = formatPayloadKeys({
      success: true,
      unstaged: ["a".repeat(40), "b".repeat(40)],
    });
    expect(block).toContain("unstaged:\n");
    expect(block).toContain(`  "${"a".repeat(40)}"`);
  });

  test("carries no line for a result that is only a status", () => {
    expect(formatPayloadKeys({ success: true })).toEqual([]);
  });
});

describe("generic fallback rendering", () => {
  const originalCli = log.cli;
  let emitted: string[];

  beforeEach(() => {
    emitted = [];
    (log as unknown as { cli: unknown }).cli = mock((message: unknown) => {
      emitted.push(String(message));
    });
  });

  afterEach(() => {
    (log as unknown as { cli: unknown }).cli = originalCli;
  });

  function render(result: unknown, options?: { commandEmittedOutput?: boolean }): string[] {
    new DefaultCommandResultFormatter().getDefaultFormatter(genericCommand, options)(result);
    return emitted;
  }

  test("prints the payload alongside the status line", () => {
    expect(render({ success: true, cwd: "/tmp/x", isMainWorkspace: false })).toEqual([
      "✅ Success",
      "cwd: /tmp/x",
      "isMainWorkspace: false",
    ]);
  });

  test("prints only the status line when the result carries no payload", () => {
    expect(render({ success: true })).toEqual(["✅ Success"]);
  });

  test("leaves the payload to the command when the command printed its own report", () => {
    expect(
      render({ success: true, total: 3, results: [1, 2, 3] }, { commandEmittedOutput: true })
    ).toEqual(["✅ Success"]);
  });

  test("stays silent for a result that DECLARES its report complete", () => {
    // mt#3961: `printed` suppresses everything, including the status line the
    // command's own report already conveyed.
    expect(render({ printed: true, success: true, cwd: "/tmp/x" })).toEqual([]);
  });

  test("declaring printed also suppresses the trailing status line with no payload", () => {
    expect(render({ printed: true, success: true })).toEqual([]);
  });

  /**
   * mt#3961's originating near-miss, kept as a regression guard.
   *
   * The task set out to suppress the status line whenever the command emitted
   * ANY output, inferring "already reported" from the line counter. This shape
   * falsified it: `authorship.recompute` prints one incidental line ("Running
   * in dry-run mode…") and returns a `RecomputeSummary` — no `success` key, so
   * it renders through the JSON-dump branch. Inferring suppression would have
   * swallowed the entire summary the operator ran the command to get.
   *
   * A command that emitted output must still have a no-status payload rendered.
   */
  test("still renders a no-status payload even when the command emitted output", () => {
    const emitted = render(
      { total: 1880, recomputed: 5, tierChanged: 2 },
      { commandEmittedOutput: true }
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('"recomputed": 5');
  });

  test("prefers an explicit message and does not also dump the payload", () => {
    expect(render({ message: "Committed abc123", branch: "main" })).toEqual(["Committed abc123"]);
  });

  test("prefers preformatted output and does not also dump the payload", () => {
    expect(render({ success: true, output: "rendered report", branch: "main" })).toEqual([
      "rendered report",
    ]);
  });

  test("prints payload keys and the error line on failure", () => {
    expect(render({ success: false, attempted: "push", error: "remote rejected" })).toEqual([
      "❌ Failed",
      "attempted: push",
      "Error: remote rejected",
    ]);
  });
});

describe("SWITCH_HANDLED_COMMAND_IDS", () => {
  /**
   * The exported list is what the audit script subtracts from the registry, so
   * a case added to the switch without a list entry would make the audit report
   * a switch-rendered command as reaching the fallback.
   */
  test("matches the case labels in formatObjectResult's switch", async () => {
    const source = await Bun.file(`${import.meta.dir}/result-formatter.ts`).text();
    const switchBody = source.slice(
      source.indexOf("switch (commandDef.id) {"),
      source.indexOf("private formatSessionListResult")
    );
    const caseLabels = [...switchBody.matchAll(/case "([^"]+)":/g)].map((match) => match[1]);

    expect(caseLabels.length).toBeGreaterThan(0);
    expect([...caseLabels].sort()).toEqual([...SWITCH_HANDLED_COMMAND_IDS].sort());
  });
});
