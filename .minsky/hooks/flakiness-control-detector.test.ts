/**
 * Adapter tests for the flakiness-control detector (mt#3658).
 *
 * The MATCHER's behaviour is pinned in
 * `packages/domain/src/detectors/flakiness-attribution.test.ts` — these cover
 * only what the adapter owns: the tool-payload read, the calibration-first
 * posture (a record, never an injection or a deny), the override, and the
 * advisory's shape.
 */
import { describe, expect, test, afterEach } from "bun:test";
import {
  run,
  buildAdvisory,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
} from "./flakiness-control-detector";
import type { ToolHookInput } from "./types";
import type { DispatchContext } from "./registry";
import { detectFlakinessAttribution } from "@minsky/domain/detectors/flakiness-attribution";

const CTX = {} as DispatchContext;

function createInput(spec: string): ToolHookInput {
  return {
    session_id: "test-session",
    tool_name: "mcp__minsky__tasks_create",
    tool_input: { title: "t", spec },
  } as unknown as ToolHookInput;
}

afterEach(() => {
  delete process.env[OVERRIDE_ENV_VAR];
});

describe("flakiness-control-detector — adapter", () => {
  test("AT1: a flakiness spec with no control returns a calibration record and does NOT deny", () => {
    const outcome = run(createInput("The suite fails intermittently under load."), CTX);

    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.deny).toBeUndefined();
    const calibration = outcome?.calibration as Record<string, unknown>;
    expect(calibration.hasIsolationControl).toBe(false);
    expect(Array.isArray(calibration.claims)).toBe(true);
  });

  test("stays silent when the spec records a control", () => {
    const spec = "Fails intermittently.\n\n`bun test src/a.test.ts` → 17 pass / 0 fail";
    expect(run(createInput(spec), CTX)).toBeNull();
  });

  test("stays silent on a spec with no flakiness vocabulary", () => {
    expect(run(createInput("## Summary\n\nAdd a flag."), CTX)).toBeNull();
  });

  test("stays silent when the payload carries no spec", () => {
    const input = { session_id: "s", tool_name: "mcp__minsky__tasks_create", tool_input: {} };
    expect(run(input as unknown as ToolHookInput, CTX)).toBeNull();
  });

  test("log-only means a WARN AND a record — not silence (SC2/AT1)", () => {
    // Both halves pinned, because the easy mistake is to read "calibration
    // first" as record-only: the spec asks for the warning, and a guard that
    // records without telling the agent leaves it to learn nothing until
    // someone reviews the log.
    expect(INJECTION_ENABLED).toBe(true);
    const outcome = run(createInput("It is flaky."), CTX);

    expect(outcome?.additionalContext).toContain("[flakiness-control]");
    expect(outcome?.calibration).toBeDefined();
    // And still not a deny — that is the half "calibration-first" does buy.
    expect(outcome?.deny).toBeUndefined();
  });

  test("the override short-circuits to an audit line on stderr, never stdout", () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    const outcome = run(createInput("It is flaky."), CTX);

    expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    expect(outcome?.calibration).toBeUndefined();
  });
});

describe("flakiness-control-detector — advisory shape", () => {
  test("quotes the phrases that tripped it, per guard-feedback-authoring", () => {
    const result = detectFlakinessAttribution("The suite is flaky under load.");
    const advisory = buildAdvisory(result);

    expect(advisory).toContain("[flakiness-control]");
    expect(advisory).toContain("flaky");
    expect(advisory).toContain("UNVERIFIED");
  });

  test("a denial gets the denial directive, not the attribution one", () => {
    // A directive that does not fit the fire invites reading a TRUE positive as
    // a false one — the handoff obligation guard-feedback-authoring names.
    const denial = buildAdvisory(detectFlakinessAttribution("It is not load-dependent."));
    const attribution = buildAdvisory(detectFlakinessAttribution("The suite is flaky."));

    // The denial directive names the evidence a denial actually takes — two
    // conditions, recorded under the literal label (mt#4166). Naming the label
    // is the load-bearing part: it is now the ONLY thing that silences a denial,
    // so an advisory that omitted it would leave the reader no way to comply.
    expect(denial).toContain("Load control:");
    expect(denial).toContain("TWO load conditions");
    expect(attribution).not.toContain("Load control:");
    expect(attribution).toContain("Run the file alone");
  });

  test("the claim list is capped, with the overflow named rather than dropped", () => {
    // The ceiling itself is enforced by `guard-feedback-shape.test.ts` against
    // the registry's `worstCaseCanary`; this pins the cap that makes that
    // ceiling a PROVED bound rather than a sample of an unbounded list.
    const many = detectFlakinessAttribution(
      "It is not load-dependent; the suite is flaky, intermittent, load-sensitive, " +
        "fails under parallelism, passes in isolation, and is timing-dependent."
    );
    expect(many.claims.length).toBeGreaterThan(3);

    const advisory = buildAdvisory(many);
    expect(advisory).toContain("... and ");
    expect(advisory.split("\n").filter((l) => l.startsWith("  - ")).length).toBe(3);
  });
});
