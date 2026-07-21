#!/usr/bin/env bun
/**
 * Throwaway probe (mt#3016 investigation) — NOT part of the deliverable.
 * Reproduces, outside the test harness, what happens to a FRESH (never
 * previously called) getContextInspectorDb() after initializeConfiguration()
 * has already been called once in-process (mirroring what
 * session-auto-task-creation.test.ts's beforeEach does before
 * task-list.test.ts's widget makes its own first call), to confirm/refute
 * the "leaked configuration singleton unlocks a real persistence backend"
 * hypothesis.
 *
 * Run with CONFIG_FIRST=1 to call initializeConfiguration() BEFORE the
 * (only) getContextInspectorDb() call -- this is the actual failure-order
 * scenario. Without it, this just confirms the baseline (config never
 * initialized -> null).
 */
import "reflect-metadata";
import { initializeConfiguration, CustomConfigFactory } from "../packages/domain/src/configuration";
import { getContextInspectorDb } from "../src/cockpit/db-providers";

if (process.env.CONFIG_FIRST === "1") {
  const factory = new CustomConfigFactory();
  await initializeConfiguration(factory, { workingDirectory: "/mock/workspace" });
  console.log("initializeConfiguration() called FIRST (workingDirectory: /mock/workspace)");
} else {
  console.log("initializeConfiguration() NOT called (baseline)");
}

const db = await getContextInspectorDb();
console.log("getContextInspectorDb() ->", db === null ? "null" : `NON-NULL: ${JSON.stringify(db)}`);
process.exit(0);
