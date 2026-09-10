// Tests for the fire-log instrumentation ruling (mt#5081, mt#4606 amendment 3).
//
// The canary-disposition half of this module is asserted against the real
// corpus in `scripts/build-interceptor-catalog.test.ts` (mt#5079). This file
// covers the OTHER axis it carries: the per-entity ruling on why an entity has,
// or does not have, a fire-log — and, for the ones ruled `instrumented`, that
// the source actually carries the call. That last check is what makes the
// ruling falsifiable: a map entry saying "instrumented by mt#5081" over a
// source that never calls `recordFireLogEntry` would be exactly the
// declared-but-uninstrumented shape this task exists to close, one level up.
//
/* eslint-disable custom/no-real-fs-in-tests -- this file's purpose is checking
 * the REAL guard sources against a committed ruling: an entry that says
 * "instrumented" over a source with no recording call is the exact
 * declared-but-silent shape mt#5081 closes. An in-memory fs fake would assert
 * the ruling against a fixture the fixture's author chose, and a fixture cannot
 * drift. Same justification as `hook-module-inventory.test.ts`. */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CANARY_DISPOSITIONS, FIRE_LOG_INSTRUMENTATION } from "./canary-dispositions";

const HOOKS_DIR = import.meta.dir;

/** The three recording paths, as measured in mt#4606's planning audit. */
const DIRECT_CALL = /recordFireLogEntry\s*\(/;
const MERGE_GATE_WRAPPER = /from ["'][./]*merge-gate-fire-log["']/;

function sourceOf(guardName: string): string | null {
  const path = join(HOOKS_DIR, `${guardName}.ts`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

describe("fire-log instrumentation ruling (mt#5081)", () => {
  const entries = [...FIRE_LOG_INSTRUMENTATION.entries()];
  const instrumented = entries.filter(([, r]) => r.status === "instrumented");
  const notEnforcement = entries.filter(([, r]) => r.status === "not-an-enforcement-point");

  test("rules on exactly the measured population of 29", () => {
    // The population is a MEASUREMENT (zero `guard_events` rows on
    // 2026-09-10), so the count is pinned deliberately: a change here means
    // either the measurement was redone or an entry was dropped, and both
    // deserve a diff a reviewer sees.
    expect(entries.length).toBe(29);
    expect(instrumented.length + notEnforcement.length).toBe(29);
  });

  test("every ruled entity is one mt#5079 also ruled on the canary axis", () => {
    // The two axes describe the same population; an entity on one and not the
    // other is a stale key, not a new finding. All 29 are standalone, so each
    // has a per-entity canary ruling rather than a stratum-level one.
    const orphans = entries.map(([name]) => name).filter((name) => !CANARY_DISPOSITIONS.has(name));
    expect(orphans).toEqual([]);
  });

  // THE falsifier. An `instrumented` ruling over a source that does not record
  // is the declared-but-silent shape one level up from the one this task
  // closes — so the ruling is checked against the source, not taken on faith.
  test("every entity ruled `instrumented` carries the recording path its ruling names", () => {
    const silent = instrumented
      .filter(([name, r]) => {
        if (r.status !== "instrumented") return false;
        const src = sourceOf(name) ?? "";
        if (r.path === "direct") return !DIRECT_CALL.test(src);
        if (r.path === "merge-gate-wrapper") return !MERGE_GATE_WRAPPER.test(src);
        return false; // dispatcher-routed is recorded by the dispatcher, not the source
      })
      .map(([name]) => name);
    expect(silent).toEqual([]);
  });

  test("every `instrumented` entity has a source file to instrument", () => {
    const missing = instrumented.filter(([name]) => sourceOf(name) === null).map(([name]) => name);
    expect(missing).toEqual([]);
  });

  test("no entity ruled `not-an-enforcement-point` was instrumented anyway", () => {
    // The inverse: if a recorder grows a fire-log call, this ruling is stale
    // and must move to `instrumented` rather than silently disagreeing with
    // the source. Dispatcher entry points are exempt from the check — they
    // legitimately import the dispatcher, which is what records.
    const contradicted = notEnforcement
      .filter(([name]) => !name.startsWith("dispatch-"))
      .filter(([name]) => {
        const src = sourceOf(name) ?? "";
        return DIRECT_CALL.test(src) || MERGE_GATE_WRAPPER.test(src);
      })
      .map(([name]) => name);
    expect(contradicted).toEqual([]);
  });

  test("every `not-an-enforcement-point` ruling carries a substantive reason", () => {
    const thin = notEnforcement
      .filter(([, r]) => r.status === "not-an-enforcement-point" && r.reason.trim().length < 40)
      .map(([name]) => name);
    expect(thin).toEqual([]);
  });

  test("every `instrumented` ruling names the task that added it", () => {
    const unowned = instrumented
      .filter(([, r]) => r.status === "instrumented" && !/^mt#\d+$/.test(r.task))
      .map(([name]) => name);
    expect(unowned).toEqual([]);
  });
});
