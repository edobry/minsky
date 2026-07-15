/**
 * Regression tests for the tasks.similar `quiet` param (mt#2795).
 *
 * mt#2779 removed a ghost read of the then-undeclared `quiet` key; this task
 * DECLARES the param (parity with tasks.search) and honors it in the
 * degraded-search warning gate. These tests pin the gate's three states:
 * warn by default, suppressed under quiet, suppressed under json.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { TasksSimilarCommand } from "./similarity-commands";
import { tasksSimilarParams } from "./task-parameters";
import { log } from "@minsky/shared/logger";
import type { CommandExecutionContext, InferParams } from "../../command-registry";

type SimilarParams = InferParams<typeof tasksSimilarParams>;

const degradedResponse = {
  results: [],
  backend: "lexical" as const,
  degraded: true,
  degradedReason: "test-degraded",
};

function buildCommand() {
  const cmd = new TasksSimilarCommand(
    () => ({}) as never,
    () => undefined as never
  );
  // Seam: bypass persistence/service construction; the gate under test only
  // needs a degraded response back from the service.
  (cmd as unknown as { createService: () => Promise<unknown> }).createService = async () => ({
    similarToTask: async () => degradedResponse,
  });
  return cmd;
}

const ctx = { interface: "test", format: "cli" } as CommandExecutionContext;

describe("tasks.similar quiet gate (mt#2795)", () => {
  const originalCliWarn = log.cliWarn;
  let warnSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    warnSpy = mock(() => void 0);
    (log as unknown as { cliWarn: unknown }).cliWarn = warnSpy;
  });

  afterEach(() => {
    (log as unknown as { cliWarn: unknown }).cliWarn = originalCliWarn;
  });

  test("declares quiet in the params map (parity with tasks.search)", () => {
    expect(Object.keys(tasksSimilarParams)).toContain("quiet");
  });

  test("warns on degraded search by default", async () => {
    const result = (await buildCommand().execute(
      { taskId: "mt#1", quiet: false, json: false } as SimilarParams,
      ctx
    )) as { degraded: boolean };
    expect(result.degraded).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("suppresses the degraded warning under quiet", async () => {
    const result = (await buildCommand().execute(
      { taskId: "mt#1", quiet: true, json: false } as SimilarParams,
      ctx
    )) as { degraded: boolean };
    expect(result.degraded).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("suppresses the degraded warning under json output", async () => {
    await buildCommand().execute(
      { taskId: "mt#1", quiet: false, json: true } as SimilarParams,
      ctx
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
