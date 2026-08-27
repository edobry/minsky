/**
 * `mcpHidden` — advertising-only omission of server-injected parameters (mt#4579).
 *
 * The defect this closes: `mcpHidden` was declared on the parameter contract in
 * two places and read by nothing, so `callerActorId` — which the server
 * overwrites on every call — was advertised in `tools/list` as a caller-passable
 * argument.
 *
 * **The load-bearing test here is the ACCEPTANCE one**, not the omission one.
 * Removing a parameter from the advertised schema is easy; doing it without also
 * removing it from `declaredParamKeys` is the part that can silently break,
 * because `getDeclaredParamKeys` derives its key set from the same Zod schema.
 * If the filter is applied to the schema instead of to the emitted JSON Schema,
 * the omission test still passes and the server's own injection starts getting
 * rejected as an undeclared parameter. `enforceDeclaredParams still accepts an
 * injected hidden parameter` is what fails in that case.
 */
import { describe, test, expect } from "bun:test";
import { z } from "zod";

import { omitAdvertisedParams, enforceDeclaredParams, CommandMapper } from "./command-mapper";
import {
  collectMcpHiddenParamKeys,
  convertParametersToZodSchema,
} from "../adapters/mcp/shared-command-integration";

/** The tool these cases register; named once so the three uses cannot drift. */
const TOOL_NAME = "tasks.claims.release";

const paramsWithHidden = {
  taskId: {
    schema: z.string(),
    description: "Task identifier",
    required: true,
  },
  callerActorId: {
    schema: z.string(),
    description: "Server-injected caller identity",
    required: false,
    cliHidden: true,
    mcpHidden: true,
  },
} as const;

describe("collectMcpHiddenParamKeys", () => {
  test("collects only the parameters flagged mcpHidden", () => {
    expect(collectMcpHiddenParamKeys(paramsWithHidden as never)).toEqual(["callerActorId"]);
  });

  test("returns an empty list when nothing is flagged", () => {
    const plain = { taskId: paramsWithHidden.taskId } as const;
    expect(collectMcpHiddenParamKeys(plain as never)).toEqual([]);
  });

  test("does NOT treat cliHidden as mcpHidden", () => {
    // The two flags are independent: `cliHidden` has governed the CLI surface
    // since long before this task, and inferring one from the other would hide
    // parameters on MCP that were only ever meant to be hidden on the CLI.
    const cliOnly = {
      taskId: paramsWithHidden.taskId,
      debugFlag: { schema: z.string(), description: "d", required: false, cliHidden: true },
    } as const;
    expect(collectMcpHiddenParamKeys(cliOnly as never)).toEqual([]);
  });
});

describe("omitAdvertisedParams", () => {
  const schema = {
    type: "object",
    properties: { taskId: { type: "string" }, callerActorId: { type: "string" } },
    required: ["taskId", "callerActorId"],
  };

  test("removes the hidden key from properties and required", () => {
    const out = omitAdvertisedParams(schema, ["callerActorId"]);
    expect(Object.keys(out.properties as object)).toEqual(["taskId"]);
    expect(out.required).toEqual(["taskId"]);
  });

  test("drops `required` entirely when every required key was hidden", () => {
    // A `required` array naming a property that is not advertised is malformed
    // JSON Schema — a validating client would demand a parameter it cannot see.
    const out = omitAdvertisedParams(
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      ["a"]
    );
    expect(out.required).toBeUndefined();
  });

  test("returns the input unchanged when there is nothing to hide", () => {
    expect(omitAdvertisedParams(schema, [])).toBe(schema);
    expect(omitAdvertisedParams(schema, undefined)).toBe(schema);
  });

  test("does not mutate the caller's schema", () => {
    const input = JSON.parse(JSON.stringify(schema));
    omitAdvertisedParams(input, ["callerActorId"]);
    expect(Object.keys(input.properties)).toEqual(["taskId", "callerActorId"]);
    expect(input.required).toEqual(["taskId", "callerActorId"]);
  });
});

describe("the advertised schema and the accepted key set are separate", () => {
  test("the registered tool does not advertise a hidden parameter", () => {
    const registered: Array<{ name: string; inputSchema: Record<string, unknown> }> = [];
    const mapper = new CommandMapper(
      {
        addTool: (tool: { name: string; inputSchema: Record<string, unknown> }) => {
          registered.push(tool);
        },
      } as never,
      { repositoryPath: "/mock/test-repo" }
    );

    mapper.addCommand({
      name: TOOL_NAME,
      description: "test",
      parameters: convertParametersToZodSchema(paramsWithHidden as never),
      mcpHiddenParamKeys: collectMcpHiddenParamKeys(paramsWithHidden as never),
      handler: async () => ({}),
    } as never);

    expect(registered.length).toBe(1);
    const properties = registered[0]?.inputSchema?.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toContain("taskId");
    expect(Object.keys(properties)).not.toContain("callerActorId");
  });

  test("enforceDeclaredParams still accepts an injected hidden parameter", () => {
    // THE regression guard. The schema stays full, so the key set derived from
    // it still contains `callerActorId` — which is what lets the server inject
    // the value without `enforceDeclaredParams` rejecting it as undeclared.
    // Filtering the Zod schema instead of the emitted JSON Schema would make
    // this throw while the advertisement test above still passed.
    const schema = convertParametersToZodSchema(paramsWithHidden as never);
    const declaredKeys = new Set(Object.keys(schema.shape));

    expect(declaredKeys).toContain("callerActorId");
    expect(() =>
      enforceDeclaredParams(
        TOOL_NAME,
        { taskId: "mt#4579", callerActorId: "com.anthropic.claude-code:conv:abc" },
        declaredKeys
      )
    ).not.toThrow();
  });

  test("a genuinely undeclared parameter is still rejected", () => {
    // Negative control for the test above: it must be capable of throwing, or
    // "does not throw" proves nothing about the hidden key specifically.
    const schema = convertParametersToZodSchema(paramsWithHidden as never);
    const declaredKeys = new Set(Object.keys(schema.shape));

    expect(() =>
      enforceDeclaredParams(TOOL_NAME, { taskId: "mt#4579", bogus: 1 }, declaredKeys)
    ).toThrow(/bogus/);
  });
});
