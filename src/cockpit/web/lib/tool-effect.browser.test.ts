/**
 * The classification must be usable from the cockpit web bundle (mt#3847 AT7).
 *
 * This lives under `src/cockpit/web/**` on purpose: that is the tree
 * `custom/no-node-import-in-cockpit-web` polices, so a future edit that pulls a
 * server-only dependency into `tool-effect.ts` fails lint HERE, at the consumer,
 * rather than at runtime in the browser. The assertions below cover what lint
 * cannot: that the module resolves and answers from this tree, and that it has
 * no imports at all to go wrong.
 */
/* eslint-disable custom/no-real-fs-in-tests -- the second assertion is ABOUT the
   real module's source text (that it has no imports). A fake filesystem would
   assert a fixture and prove nothing about what the bundle would pull in. */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

import { classifyTool } from "@minsky/shared/tool-effect";

describe("tool-effect is reachable from the cockpit web bundle", () => {
  test("classifies from a cockpit-web module", () => {
    expect(classifyTool("mcp__minsky__tasks_spec_patch")).toBe("mutates");
    expect(classifyTool("mcp__minsky__tasks_get")).toBe("reads");
    expect(classifyTool("Write")).toBe("mutates");
  });

  test("the module imports nothing, so it can pull nothing server-only in", () => {
    // A zero-import module cannot reach `node:fs`, the DI container, or the
    // command registry — the properties the bundle needs — and this is cheaper
    // and more direct than asserting the bundle's contents after the fact.
    const source = String(readFileSync("packages/shared/src/tool-effect.ts", "utf8"));
    const imports = source.split("\n").filter((line) => /^\s*import\s/.test(line));
    expect(imports).toEqual([]);
  });
});
