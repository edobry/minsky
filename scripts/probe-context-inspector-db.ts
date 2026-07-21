#!/usr/bin/env bun
/**
 * Throwaway probe (mt#3016 investigation) — NOT part of the deliverable.
 * Confirms whether getContextInspectorDb() can resolve to a real (non-null)
 * DB handle in this environment, outside of any test harness.
 */
import { getContextInspectorDb } from "../src/cockpit/db-providers";

const db = await getContextInspectorDb();
console.log(
  "getContextInspectorDb() resolved to:",
  db === null ? "null" : "NON-NULL (real db handle)"
);
process.exit(0);
