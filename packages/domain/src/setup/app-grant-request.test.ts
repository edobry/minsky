/**
 * Tests for the App-grant request (mt#4693).
 *
 * Everything here is pure, so these exercise the real decision surface with no
 * database and no network. The three that carry the most weight:
 *
 *  - the ask body embeds a LINK when one is available (the `portal-no-link`
 *    discipline, and the whole reason this is not chat prose),
 *  - `hasOpenAppGrantRequest` is what stops a re-run of `minsky setup` filing a
 *    second ask,
 *  - `classifyAppGrantRequest` keeps `declined`, `unanswered` and
 *    `policy-closed` distinguishable — collapsing them is how an agent turns a
 *    refusal into a retry loop, or waits forever on an ask nobody saw.
 */
import { describe, it, expect } from "bun:test";

import type { Ask } from "../ask/types";
import {
  APP_GRANT_REQUEST_ASK_KIND,
  APP_GRANT_REQUEST_METADATA_KEY,
  APP_GRANT_REQUEST_RESPONDER,
  APP_GRANT_REQUEST_SHAPE,
  buildAppGrantRequestAsk,
  classifyAppGrantRequest,
  hasOpenAppGrantRequest,
  isPolicyResolved,
} from "./app-grant-request";

const REPO = "edobry/peezombie.me";
const SETTINGS_URL = "https://github.com/settings/installations/125403046";

function askWith(
  payload: Record<string, unknown> | null,
  overrides: Partial<Ask> = {},
  state: Ask["state"] = "suspended"
): Ask {
  return {
    id: "ask-1",
    kind: APP_GRANT_REQUEST_ASK_KIND,
    classifierVersion: "v1.0.0",
    state,
    requestor: "test",
    title: "t",
    question: "q",
    createdAt: new Date("2026-08-27T00:00:00Z"),
    metadata: payload ? { [APP_GRANT_REQUEST_METADATA_KEY]: payload } : {},
    ...overrides,
  } as unknown as Ask;
}

describe("buildAppGrantRequestAsk (mt#4693)", () => {
  it("files under the kind that actually reaches the operator inbox", () => {
    // D3: `capability.escalate` is semantically exact but routes to a subagent.
    const draft = buildAppGrantRequestAsk({ repo: REPO, role: "implementer", slug: "minsky-ai" });
    expect(draft.kind).toBe("authorization.approve");
  });

  it("embeds the settings link when one is available", () => {
    const draft = buildAppGrantRequestAsk({
      repo: REPO,
      role: "implementer",
      slug: "minsky-ai",
      settingsUrl: SETTINGS_URL,
    });
    expect(draft.question).toContain(SETTINGS_URL);
    expect(draft.title).toBe(`Grant minsky-ai access to ${REPO}`);
  });

  it("degrades to navigation prose rather than guessing a URL when the id is unknown", () => {
    // A wrong URL is worse than a correct path (mt#4695).
    const draft = buildAppGrantRequestAsk({ repo: REPO, role: "implementer", slug: "minsky-ai" });
    expect(draft.question).not.toContain("https://github.com/settings/installations");
    expect(draft.question).toContain("Repository access");
  });

  it("says what is actually blocked — the review loop, not just PR creation", () => {
    const draft = buildAppGrantRequestAsk({ repo: REPO, role: "implementer", slug: "minsky-ai" });
    expect(draft.question).toContain("reviewer bot");
  });

  it("reads as a chore, not an incident", () => {
    // An operator-only chore is not a severity event; both halves are required
    // for the severity marker and only one holds here.
    const draft = buildAppGrantRequestAsk({ repo: REPO, role: "implementer", slug: "minsky-ai" });
    expect(draft.question).toContain("Nothing is broken");
  });

  it("carries the payload, and the parent entry status only when there is a parent", () => {
    const withParent = buildAppGrantRequestAsk({
      repo: REPO,
      role: "reviewer",
      slug: "minsky-reviewer",
      parentTaskId: "mt#1",
      parentEntryStatus: "IN-PROGRESS",
    });
    expect(withParent.metadata[APP_GRANT_REQUEST_METADATA_KEY]).toEqual({
      repo: REPO,
      role: "reviewer",
      slug: "minsky-reviewer",
      parentEntryStatus: "IN-PROGRESS",
    });

    // A stray entry status with no parent would hand the resolver a task id it
    // does not have.
    const orphan = buildAppGrantRequestAsk({
      repo: REPO,
      role: "reviewer",
      slug: "minsky-reviewer",
      parentEntryStatus: "IN-PROGRESS",
    });
    expect(orphan.metadata[APP_GRANT_REQUEST_METADATA_KEY]).not.toHaveProperty("parentEntryStatus");
    expect(orphan).not.toHaveProperty("parentTaskId");
  });

  it("carries no field capable of holding a credential", () => {
    const draft = buildAppGrantRequestAsk({
      repo: REPO,
      role: "implementer",
      slug: "minsky-ai",
      settingsUrl: SETTINGS_URL,
    });
    const payload = draft.metadata[APP_GRANT_REQUEST_METADATA_KEY] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["repo", "role", "settingsUrl", "slug"]);
  });
});

describe("hasOpenAppGrantRequest (mt#4693 — idempotency)", () => {
  const open = askWith({ repo: REPO, role: "implementer", slug: "minsky-ai" });

  it("sees an existing open request for the same repo and role", () => {
    expect(hasOpenAppGrantRequest([open], { repo: REPO, role: "implementer" })).toBe(true);
  });

  it("does NOT see a request for the other role on the same repo", () => {
    // Each role needs its own grant, so each gets its own request.
    expect(hasOpenAppGrantRequest([open], { repo: REPO, role: "reviewer" })).toBe(false);
  });

  it("does not count a terminal request — a declined one must not block a re-ask", () => {
    const closed = askWith({ repo: REPO, role: "implementer", slug: "minsky-ai" }, {}, "closed");
    expect(hasOpenAppGrantRequest([closed], { repo: REPO, role: "implementer" })).toBe(false);
  });

  it("ignores asks that are not App-grant requests at all", () => {
    expect(hasOpenAppGrantRequest([askWith(null)], { repo: REPO, role: "implementer" })).toBe(
      false
    );
  });

  it("matches case-insensitively on the repo", () => {
    expect(hasOpenAppGrantRequest([open], { repo: REPO.toUpperCase(), role: "implementer" })).toBe(
      true
    );
  });
});

describe("classifyAppGrantRequest (mt#4693)", () => {
  const payload = { repo: REPO, role: "implementer", slug: "minsky-ai" };

  it("returns null for an ask that is not an App-grant request", () => {
    expect(classifyAppGrantRequest(askWith(null))).toBeNull();
    expect(classifyAppGrantRequest(null)).toBeNull();
  });

  it("reports pending while the request is still open", () => {
    expect(classifyAppGrantRequest(askWith(payload))).toEqual({
      status: "pending",
      repo: REPO,
      role: "implementer",
    });
  });

  it("reports satisfied when closed by coverage presence", () => {
    const ask = askWith(
      payload,
      {
        response: {
          responder: APP_GRANT_REQUEST_RESPONDER,
          payload: { detail: "installation now covers the repository" },
        },
      } as Partial<Ask>,
      "closed"
    );
    expect(classifyAppGrantRequest(ask)).toEqual({
      status: "satisfied",
      repo: REPO,
      role: "implementer",
      detail: "installation now covers the repository",
    });
  });

  it("distinguishes a DECLINE from an unanswered request", () => {
    const declined = askWith(
      payload,
      { response: { responder: "operator", payload: { reason: "not now" } } } as Partial<Ask>,
      "closed"
    );
    expect(classifyAppGrantRequest(declined)).toEqual({
      status: "declined",
      repo: REPO,
      role: "implementer",
      reason: "not now",
    });

    const expired = askWith(payload, {}, "expired");
    expect(classifyAppGrantRequest(expired)).toEqual({
      status: "unanswered",
      repo: REPO,
      role: "implementer",
      reason: "expired",
    });
  });

  it("distinguishes a POLICY close from a decline — nobody refused, and nobody saw it", () => {
    const policy = askWith(payload, { routingTarget: "policy" } as Partial<Ask>, "closed");
    expect(classifyAppGrantRequest(policy)).toEqual({
      status: "policy-closed",
      repo: REPO,
      role: "implementer",
    });
  });

  it("falls back to the shape's default detail when the close carried no status line", () => {
    const ask = askWith(
      payload,
      { response: { responder: APP_GRANT_REQUEST_RESPONDER, payload: {} } } as Partial<Ask>,
      "closed"
    );
    expect(classifyAppGrantRequest(ask)).toMatchObject({
      detail: APP_GRANT_REQUEST_SHAPE.defaultDetail,
    });
  });
});

describe("isPolicyResolved (mt#4693 D3)", () => {
  it("catches both the routing-target and the responder form", () => {
    expect(
      isPolicyResolved({ routingTarget: "policy" } as Pick<Ask, "routingTarget" | "response">)
    ).toBe(true);
    expect(
      isPolicyResolved({
        response: { responder: "policy" },
      } as Pick<Ask, "routingTarget" | "response">)
    ).toBe(true);
    expect(
      isPolicyResolved({ routingTarget: "operator" } as Pick<Ask, "routingTarget" | "response">)
    ).toBe(false);
  });
});
