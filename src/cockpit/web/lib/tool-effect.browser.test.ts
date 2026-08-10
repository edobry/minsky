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

  test("the module imports nothing the browser cannot have", () => {
    // PR #2789 R1: this asserted ZERO imports, which coupled the test to an
    // implementation detail — importing a sibling browser-safe type would have
    // failed it for no reason. What actually matters is the CLASS of import:
    // anything Node-only or server-side breaks the bundle, anything else does
    // not. Checked here as well as by `custom/no-node-import-in-cockpit-web`,
    // because that rule polices this tree and the module lives in another.
    const source = String(readFileSync("packages/shared/src/tool-effect.ts", "utf8"));
    const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1] as string
    );
    const serverOnly = specifiers.filter((s) =>
      /^node:|^(fs|path|os|child_process|crypto|http|https|net)$|@minsky\/domain|drizzle|tsyringe/.test(
        s
      )
    );
    expect(serverOnly).toEqual([]);
  });
});
