/**
 * Tests for the event-category classification (mt#2340).
 *
 * The category map is the single source of truth that drives the activity
 * feed's read-scope filter. `eventTypesForCategory` is what `listEvents`
 * turns into a `WHERE event_type IN (...)` clause, so testing it here covers
 * the filter logic without needing a live DB.
 */
import { describe, test, expect } from "bun:test";
import {
  SYSTEM_EVENT_TYPE_VALUES,
  EVENT_CATEGORY_VALUES,
  eventCategory,
  eventTypesForCategory,
} from "../storage/schemas/system-events-schema";

describe("event category classification", () => {
  test("the 5 actionable types are classified actionable", () => {
    const actionable = eventTypesForCategory("actionable");
    expect(actionable.sort()).toEqual(
      [
        "ask.created",
        "task.auto_created",
        "pr.review_posted",
        "subagent.failed",
        "embeddings.provider_degraded",
      ].sort()
    );
  });

  test("the informational/trajectory types are classified informational", () => {
    const informational = eventTypesForCategory("informational");
    expect(informational.sort()).toEqual(
      [
        "task.status_changed",
        "pr.merged",
        "subagent.completed",
        "session.started",
        "memory.created",
        "ask.answered",
        "ask.policy_closed",
        "changeset.created",
        "hook.fired",
        "mcp.disconnect",
        "retrospective.fired",
        "deploy.build",
        "deploy.smoke",
        "deploy.live",
        "deploy.fail",
      ].sort()
    );
  });

  test("every type belongs to exactly one category, and the categories partition the type space", () => {
    const byCategory = EVENT_CATEGORY_VALUES.flatMap((c) => eventTypesForCategory(c));
    // No type appears in two categories, and every type is covered.
    expect(byCategory.sort()).toEqual([...SYSTEM_EVENT_TYPE_VALUES].sort());
  });

  test("eventCategory values are all valid categories", () => {
    for (const type of SYSTEM_EVENT_TYPE_VALUES) {
      expect(EVENT_CATEGORY_VALUES as readonly string[]).toContain(eventCategory[type]);
    }
  });
});
