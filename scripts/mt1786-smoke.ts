#!/usr/bin/env bun
// mt#1786 smoke: exercise the registered MCP handler the framework would invoke.
// Goes through the same shared-command-integration code path PR #1078 modified.
// Not a CI test — run manually from the session workspace.

import { registerSharedCommandsWithMcp } from "../src/adapters/mcp/shared-command-integration";
import { sharedCommandRegistry, CommandCategory } from "../src/adapters/shared/command-registry";
import { z } from "zod";

const id = "tasks.smoke_mt1786";
sharedCommandRegistry.registerCommand(
  {
    id,
    name: id,
    category: CommandCategory.TASKS,
    description: "smoke test",
    requiresSetup: false,
    parameters: {
      all: { schema: z.boolean(), description: "all", required: false },
      limit: { schema: z.number(), description: "limit", required: false },
    },
    execute: async (params: Record<string, unknown>) => ({ received: params }),
  },
  { allowOverwrite: true }
);

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
let capturedHandler: Handler | undefined;
const mapper = {
  addCommand: (cmd: { name: string; handler: Handler }) => {
    if (cmd.name === id) capturedHandler = cmd.handler;
  },
};

registerSharedCommandsWithMcp(mapper as never, {
  categories: [CommandCategory.TASKS],
  commandOverrides: {
    [id]: {
      argDefaults: {
        limit: (a: Record<string, unknown>) => (a.all === true ? undefined : 50),
      },
    },
  },
});

if (!capturedHandler) {
  console.error("FAIL: handler was not registered");
  process.exit(1);
}

const r1 = (await capturedHandler({})) as { received: Record<string, unknown> };
const r2 = (await capturedHandler({ all: true })) as { received: Record<string, unknown> };
const r3 = (await capturedHandler({ limit: 7 })) as { received: Record<string, unknown> };
const r4 = (await capturedHandler({ all: true, limit: 10 })) as {
  received: Record<string, unknown>;
};

console.log("default():", JSON.stringify(r1));
console.log("all=true:", JSON.stringify(r2));
console.log("limit=7:", JSON.stringify(r3));
console.log("all+limit:", JSON.stringify(r4));

let ok = 0;
let fail = 0;
const check = (cond: boolean, msg: string) => {
  if (cond) {
    console.log(`PASS: ${msg}`);
    ok++;
  } else {
    console.log(`FAIL: ${msg}`);
    fail++;
  }
};

check(r1.received.limit === 50, "default applies limit=50");
check(r2.received.limit === undefined && r2.received.all === true, "all=true skips limit default");
check(r3.received.limit === 7, "explicit limit wins");
check(r4.received.limit === 10 && r4.received.all === true, "all+limit both flow through");

console.log(`\n${ok} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
