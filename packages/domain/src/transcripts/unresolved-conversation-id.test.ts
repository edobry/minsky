/**
 * Tests for the workspace-id -> conversation-id stand-in and the id-space
 * contract it exists to make visible.
 *
 * Reference: mt#3066 §Acceptance Tests (AT3 — "a unit test pins the id-space
 * contract so a workspace id can no longer be passed where a conversation id
 * is required").
 */

import { describe, it, expect } from "bun:test";

import type { ConversationId } from "../ids";
import {
  resetUnresolvedConversationIdWarnings,
  unresolvedWorkspaceIdAsConversationId,
} from "./unresolved-conversation-id";

const WORKSPACE_ID = "9cf73c7f-6070-4b37-8109-cfc292a96398";
const CALL_SITE = "test:call-site";
const OTHER_CALL_SITE = "test:other-call-site";

describe("unresolvedWorkspaceIdAsConversationId", () => {
  it("returns the id unchanged — it re-labels, it does not resolve", () => {
    resetUnresolvedConversationIdWarnings();
    const warnings: string[] = [];

    const result = unresolvedWorkspaceIdAsConversationId(WORKSPACE_ID, CALL_SITE, (m) =>
      warnings.push(m)
    );

    expect(result).toBe(WORKSPACE_ID as ConversationId);
  });

  it("warns naming the call site and the tracking task", () => {
    resetUnresolvedConversationIdWarnings();
    const warnings: string[] = [];

    unresolvedWorkspaceIdAsConversationId(WORKSPACE_ID, CALL_SITE, (m) => warnings.push(m));

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(CALL_SITE);
    expect(warnings[0]).toContain("mt#3101");
  });

  it("warns once per call site per process, not once per invocation", () => {
    resetUnresolvedConversationIdWarnings();
    const warnings: string[] = [];
    const sink = (m: string): number => warnings.push(m);

    // The recomputeTiers caller runs this in a loop over ~1,300 records.
    for (let i = 0; i < 50; i++) {
      unresolvedWorkspaceIdAsConversationId(`${WORKSPACE_ID}-${i}`, CALL_SITE, sink);
    }

    expect(warnings.length).toBe(1);
  });

  it("warns separately for each distinct call site", () => {
    resetUnresolvedConversationIdWarnings();
    const warnings: string[] = [];
    const sink = (m: string): number => warnings.push(m);

    unresolvedWorkspaceIdAsConversationId(WORKSPACE_ID, CALL_SITE, sink);
    unresolvedWorkspaceIdAsConversationId(WORKSPACE_ID, OTHER_CALL_SITE, sink);

    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain(CALL_SITE);
    expect(warnings[1]).toContain(OTHER_CALL_SITE);
  });
});

// The id-space contract itself (AT3 — "a workspace id can no longer be passed
// where a conversation id is required") is pinned by the compile-time lock at
// the bottom of `unresolved-conversation-id.ts`, NOT here. A `@ts-expect-error`
// written in this file would never be evaluated: `packages/**/*.test.ts` is in
// no typecheck program (root `tsconfig.json` includes `src`/`types`/`tests`,
// and files under `packages/` enter the program only via imports from `src/`).
// Verified by negative control — see mt#3102 for the coverage gap itself.
