/**
 * Tests for the App-grant request payload contract (mt#4693).
 *
 * The load-bearing one is the ROUND-TRIP test. `readAppGrantRequest` constructs
 * a fresh object field by field, so a payload field added to the interface and
 * not added to the reader is dropped silently — no error, no missing key, just a
 * value that reads as absent everywhere. That is the hazard the sibling
 * credential reader's own docblock warns about; here it is pinned by a test.
 */
import { describe, it, expect } from "bun:test";
import {
  APP_GRANT_REQUEST_METADATA_KEY,
  appGrantRequestKey,
  readAppGrantRequest,
  type AppGrantRequestPayload,
} from "./app-grant-request";

/** Every optional field populated, so a dropped one is visible. */
const FULL_PAYLOAD: AppGrantRequestPayload = {
  repo: "edobry/peezombie.me",
  role: "reviewer",
  slug: "minsky-reviewer",
  settingsUrl: "https://github.com/settings/installations/987654321",
  parentEntryStatus: "IN-PROGRESS",
};

function askWith(payload: unknown) {
  return { metadata: { [APP_GRANT_REQUEST_METADATA_KEY]: payload } };
}

describe("readAppGrantRequest (mt#4693)", () => {
  it("round-trips EVERY field — the guard against a silently dropped payload field", () => {
    // If a field is added to AppGrantRequestPayload and not lifted in the
    // reader, this fails here rather than reading as absent in production.
    expect(readAppGrantRequest(askWith(FULL_PAYLOAD))).toEqual(FULL_PAYLOAD);
  });

  it("returns null for an ask that is not an App-grant request", () => {
    expect(readAppGrantRequest({ metadata: { somethingElse: { repo: "x" } } })).toBeNull();
    expect(readAppGrantRequest({ metadata: {} })).toBeNull();
    expect(readAppGrantRequest({ metadata: null })).toBeNull();
    expect(readAppGrantRequest(null)).toBeNull();
    expect(readAppGrantRequest(undefined)).toBeNull();
  });

  it("returns null when a required field is missing or the wrong type", () => {
    expect(readAppGrantRequest(askWith({ role: "implementer", slug: "minsky-ai" }))).toBeNull();
    expect(readAppGrantRequest(askWith({ repo: "a/b", slug: "minsky-ai" }))).toBeNull();
    expect(readAppGrantRequest(askWith({ repo: "a/b", role: "implementer" }))).toBeNull();
    expect(readAppGrantRequest(askWith({ repo: 42, role: "implementer", slug: "s" }))).toBeNull();
    expect(readAppGrantRequest(askWith({ repo: "", role: "implementer", slug: "s" }))).toBeNull();
    expect(readAppGrantRequest(askWith("not-an-object"))).toBeNull();
  });

  it("omits the optional fields rather than emitting empty strings", () => {
    const result = readAppGrantRequest(
      askWith({ repo: "a/b", role: "implementer", slug: "minsky-ai", settingsUrl: "" })
    );
    expect(result).toEqual({ repo: "a/b", role: "implementer", slug: "minsky-ai" });
    expect(result).not.toHaveProperty("settingsUrl");
  });
});

describe("appGrantRequestKey (mt#4693 — idempotency)", () => {
  it("is stable across repeated onboarding runs of the same repo and role", () => {
    const key = appGrantRequestKey({ repo: "edobry/minsky", role: "implementer" });
    expect(appGrantRequestKey({ repo: "edobry/minsky", role: "implementer" })).toBe(key);
  });

  it("matches case-insensitively on the repo, as GitHub treats owner/repo names", () => {
    expect(appGrantRequestKey({ repo: "EDOBRY/Minsky", role: "implementer" })).toBe(
      appGrantRequestKey({ repo: "edobry/minsky", role: "implementer" })
    );
  });

  it("separates the two roles on the same repo — each needs its own grant", () => {
    expect(appGrantRequestKey({ repo: "edobry/minsky", role: "implementer" })).not.toBe(
      appGrantRequestKey({ repo: "edobry/minsky", role: "reviewer" })
    );
  });

  it("does not collide across repos whose names concatenate ambiguously", () => {
    expect(appGrantRequestKey({ repo: "a/b", role: "c::d" })).not.toBe(
      appGrantRequestKey({ repo: "a/b::c", role: "d" })
    );
  });
});
