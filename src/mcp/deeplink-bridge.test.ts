import { describe, expect, test } from "bun:test";

import { ROUTABLE_ENTITY_TYPES } from "../cockpit/web/lib/entity-codec";
import { resolveDeeplinkBridge } from "./deeplink-bridge";

/** A valid sample id per entity type — changeset ids are digits-only by codec rule. */
const SAMPLE_IDS: Record<(typeof ROUTABLE_ENTITY_TYPES)[number], string> = {
  task: "mt#2865",
  ask: "85a24250-4fc6-4b5f-a36f-0cd5cadafac1",
  session: "870c7f9a-0045-477a-98ea-bd6d3f92aca8",
  memory: "bed551ef-b493-484a-9363-6e088ca82bee",
  changeset: "2033",
  conversation: "00d461ab-1234-4cde-9f00-aaaaaaaaaaaa",
  interceptor: "block-secret-file-read",
};

describe("resolveDeeplinkBridge", () => {
  test("task id round-trips into the interstitial with the # percent-encoded", () => {
    const result = resolveDeeplinkBridge("task", "mt#2865");
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/html");
    // The canonical URI appears in all three handoff positions: meta refresh,
    // script literal, and the visible anchor.
    expect(result.body).toContain('content="0;url=minsky://task/mt%232865"');
    expect(result.body).toContain('location.replace("minsky://task/mt%232865")');
    expect(result.body).toContain('href="minsky://task/mt%232865"');
    // The label stays the readable ref.
    expect(result.body).toContain("<h1>mt#2865</h1>");
  });

  test("every routable entity type is accepted", () => {
    for (const type of ROUTABLE_ENTITY_TYPES) {
      const result = resolveDeeplinkBridge(type, SAMPLE_IDS[type]);
      expect(result.status).toBe(200);
      expect(result.body).toContain(`minsky://${type}/`);
    }
  });

  test("unknown type is a plain-text 404", () => {
    const result = resolveDeeplinkBridge("bogus", "mt#2865");
    expect(result.status).toBe(404);
    expect(result.contentType).toBe("text/plain");
  });

  test("every response carries the no-store cache contract", () => {
    // Public, un-authed route: the no-store posture is part of the result type
    // so an intermediary can never cache what a future edit emits (PR #3362 R1).
    expect(resolveDeeplinkBridge("task", "mt#2865").cacheControl).toBe("no-store");
    expect(resolveDeeplinkBridge("bogus", "x").cacheControl).toBe("no-store");
  });

  test("empty id is a 404", () => {
    expect(resolveDeeplinkBridge("task", "").status).toBe(404);
  });

  test("non-numeric changeset id is refused, inheriting the codec rule", () => {
    expect(resolveDeeplinkBridge("changeset", "abc").status).toBe(404);
    expect(resolveDeeplinkBridge("changeset", "2033").status).toBe(200);
  });

  test("an id the parser would normalize is refused rather than silently rewritten", () => {
    // parseMinskyUri strips trailing prose punctuation; handing off a URI that
    // parses to a DIFFERENT id than requested would open the wrong entity.
    expect(resolveDeeplinkBridge("task", "mt#2865)").status).toBe(404);
  });

  test("markup in the id cannot escape into the page", () => {
    const result = resolveDeeplinkBridge("memory", 'x"><script>alert(1)</script>');
    // Accepted or not, no raw markup may appear.
    expect(result.body).not.toContain("<script>alert");
    expect(result.body).not.toContain('"><');
  });

  test("the page embeds no host of its own — only the minsky:// URI", () => {
    const result = resolveDeeplinkBridge("task", "mt#2865");
    expect(result.body).not.toContain("http://");
    expect(result.body).not.toContain("https://");
  });
});
