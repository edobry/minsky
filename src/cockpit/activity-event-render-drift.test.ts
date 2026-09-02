/**
 * Client/server drift for the activity feed's event renderer (mt#4775).
 *
 * **Why it lives here and not in `enum-drift.test.ts`.** That file owns the
 * server's own drift axes — the enum against the pgEnum, and the enum against
 * the migration SQL — and the first draft of this check was added there. PR
 * #3577 R1 called that BLOCKING and was right: `packages/domain` is the lower
 * layer, so a domain test reaching up into `src/cockpit` inverts the dependency
 * (and did it through a five-level relative path). The comparison itself is
 * sound; it just belongs on the consuming side. `src/cockpit` already imports
 * `@minsky/domain` throughout, so here the direction is the ordinary one.
 *
 * **What it guards.** `ActivityPage` carried a 9-member event-type union while
 * the server enum had 30, so 21 types rendered as `Unknown event (…)`. Nothing
 * caught it: the page's `const _exhaustive: never` guards were sound over the
 * union they were given and silent about the other 21, and every other drift
 * axis compares the server to itself. This is the first check that compares the
 * enum to what the cockpit actually DISPLAYS.
 *
 * Deliberately asserts on the rendered WORDING rather than on union membership,
 * so a 31st event type passes on the day it lands — the derived default covers
 * it, which is the design.
 */

import { describe, test, expect } from "bun:test";
import { SYSTEM_EVENT_TYPE_VALUES } from "@minsky/domain/storage/schemas/system-events-schema";
import { eventStyle, eventSummary } from "./web/lib/activity-event-render";

describe("Activity renderer — client/server drift (mt#4775)", () => {
  test("every SYSTEM_EVENT_TYPE_VALUES member renders a real label", () => {
    for (const eventType of SYSTEM_EVENT_TYPE_VALUES) {
      const { label } = eventStyle(eventType);
      expect(label.length).toBeGreaterThan(0);
      expect(label.toLowerCase()).not.toContain("unknown");
    }
  });

  test("every SYSTEM_EVENT_TYPE_VALUES member renders a summary, payload or not", () => {
    for (const eventType of SYSTEM_EVENT_TYPE_VALUES) {
      const summary = eventSummary({ eventType, payload: {} });
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).not.toContain("Unknown event");
    }
  });

  test("an event type NOT in the enum still renders rather than falling through", () => {
    // The guard against a regression to per-type `case` arms: a hypothetical
    // 31st type must render its own name and payload, not a placeholder.
    expect(eventStyle("deploy.rolled_back").label).toBe("Deploy rolled back");
    expect(
      eventSummary({ eventType: "deploy.rolled_back", payload: { service: "minsky-mcp", from: 7 } })
    ).toBe("service=minsky-mcp · from=7");
  });

  test("an acronym domain is not sentence-cased into a word (PR #3577 R1)", () => {
    // `mcp.disconnect` is in the enum and has no bespoke entry, so it reaches
    // the derived label — where naive sentence-casing rendered it "Mcp
    // disconnect". Asserted on a live enum member, not a hypothetical.
    expect(SYSTEM_EVENT_TYPE_VALUES as readonly string[]).toContain("mcp.disconnect");
    expect(eventStyle("mcp.disconnect").label).toBe("MCP disconnect");
    expect(eventStyle("pr.checks_completed").label).toBe("PR checks completed");
  });
});
