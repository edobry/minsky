/**
 * Tests for the tool-output credential scrubber (mt#2763).
 *
 * All credential values below are SYNTHETIC — shaped to match the regex
 * (correct prefix/length/charset) but not derived from, and unrelated to,
 * any real credential from any incident. Never paste a real leaked shape
 * into a test.
 */

import { describe, test, expect } from "bun:test";

import { CREDENTIAL_SHAPES, scrubText, scrubValueDeep } from "./credential-scrubber";

// ── Synthetic fixtures (fake, shape-matching only) ──────────────────────────

const FAKE_PULUMI_TOKEN = `pul-${"a1b2c3d4".repeat(5)}`; // 40 hex chars
const FAKE_OPENAI_KEY = `sk-${"x".repeat(48)}`;
const FAKE_GITHUB_PAT = `ghp_${"A".repeat(36)}`;
const FAKE_GITHUB_OAUTH = `gho_${"B".repeat(36)}`;
// Deliberately NOT shaped like a real Slack token's digit-group structure
// (xoxb-<digits>-<digits>-<alnum>) — a realistic-looking digit run tripped
// GitHub push protection's secret scanner even though this value is
// synthetic. Keeping the prefix + length-floor (what OUR regex matches) while
// avoiding GitHub's own detector's shape.
const FAKE_SLACK_TOKEN = "xoxb-FAKE-NOT-A-REAL-SLACK-TOKEN-TEST-ONLY";
const FAKE_AWS_KEY = "AKIAABCDEFGHIJKLMNOP"; // AKIA + 16 uppercase alnum
const FAKE_PEM_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtlZmFrZQ==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const FAKE_JWT = [`eyJ${"a".repeat(10)}`, `eyJ${"b".repeat(10)}`, `${"c".repeat(10)}`].join(".");
const FAKE_PG_URL = "postgresql://fakeuser:fakepassword@db.example.invalid:5432/mydb";

describe("credential-scrubber", () => {
  describe("CREDENTIAL_SHAPES", () => {
    test("every shape carries a non-empty precision basis", () => {
      for (const shape of CREDENTIAL_SHAPES) {
        expect(shape.precisionBasis.length).toBeGreaterThan(20);
        expect(shape.regex.global).toBe(true);
      }
    });

    test("shape names are unique", () => {
      const names = CREDENTIAL_SHAPES.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe("scrubText", () => {
    test("returns input unchanged when no credential shape matches", () => {
      const { text, redactions } = scrubText("just a normal sentence with no secrets in it");
      expect(text).toBe("just a normal sentence with no secrets in it");
      expect(redactions).toEqual([]);
    });

    test("handles empty string", () => {
      const { text, redactions } = scrubText("");
      expect(text).toBe("");
      expect(redactions).toEqual([]);
    });

    test("redacts a Pulumi token and retains an 8-char prefix", () => {
      const { text, redactions } = scrubText(`pulumi token present: ${FAKE_PULUMI_TOKEN}`);
      expect(text).not.toContain(FAKE_PULUMI_TOKEN);
      expect(text).toContain("[REDACTED:pulumi-token:");
      expect(text).toContain(FAKE_PULUMI_TOKEN.slice(0, 8));
      expect(redactions).toHaveLength(1);
      expect(redactions[0]?.shape).toBe("pulumi-token");
      expect(redactions[0]?.prefix8).toBe(FAKE_PULUMI_TOKEN.slice(0, 8));
    });

    test("redacts an OpenAI-shaped secret key", () => {
      const { text, redactions } = scrubText(`OPENAI_API_KEY=${FAKE_OPENAI_KEY}`);
      expect(text).not.toContain(FAKE_OPENAI_KEY);
      expect(text).toContain("[REDACTED:openai-style-secret-key:");
      expect(redactions[0]?.shape).toBe("openai-style-secret-key");
    });

    test("does NOT redact a short sk-prefixed identifier (precision floor)", () => {
      const { text, redactions } = scrubText("the sk-flag was set");
      expect(text).toBe("the sk-flag was set");
      expect(redactions).toEqual([]);
    });

    test("redacts GitHub personal-access and OAuth tokens", () => {
      const { text, redactions } = scrubText(`pat=${FAKE_GITHUB_PAT} oauth=${FAKE_GITHUB_OAUTH}`);
      expect(text).not.toContain(FAKE_GITHUB_PAT);
      expect(text).not.toContain(FAKE_GITHUB_OAUTH);
      expect(redactions).toHaveLength(2);
      expect(redactions.every((r) => r.shape === "github-token")).toBe(true);
    });

    test("redacts a Slack bot token", () => {
      const { text, redactions } = scrubText(`slack token: ${FAKE_SLACK_TOKEN}`);
      expect(text).not.toContain(FAKE_SLACK_TOKEN);
      expect(redactions[0]?.shape).toBe("slack-token");
    });

    test("redacts an AWS access key ID", () => {
      const { text, redactions } = scrubText(`AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}`);
      expect(text).not.toContain(FAKE_AWS_KEY);
      expect(redactions[0]?.shape).toBe("aws-access-key-id");
    });

    test("redacts a PEM private-key block in full (header through footer)", () => {
      const { text, redactions } = scrubText(`key follows:\n${FAKE_PEM_KEY}\ndone`);
      expect(text).not.toContain("ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtlZmFrZQ==");
      expect(text).toContain("[REDACTED:pem-private-key:");
      expect(redactions[0]?.shape).toBe("pem-private-key");
    });

    test("redacts a JWT (three-segment dotted structure)", () => {
      const { text, redactions } = scrubText(`Authorization: Bearer ${FAKE_JWT}`);
      expect(text).not.toContain(FAKE_JWT);
      expect(redactions[0]?.shape).toBe("jwt");
    });

    test("does NOT redact a bare eyJ fragment lacking the full three-segment structure", () => {
      const { text, redactions } = scrubText("the value started with eyJhbGci but nothing else");
      expect(text).toBe("the value started with eyJhbGci but nothing else");
      expect(redactions).toEqual([]);
    });

    test("redacts a postgres URL carrying inline credentials", () => {
      const { text, redactions } = scrubText(`DATABASE_URL=${FAKE_PG_URL}`);
      expect(text).not.toContain("fakepassword");
      expect(redactions[0]?.shape).toBe("postgres-url-credentials");
    });

    test("redacts multiple distinct credentials in one string", () => {
      const combined = `${FAKE_PULUMI_TOKEN} and also ${FAKE_AWS_KEY}`;
      const { text, redactions } = scrubText(combined);
      expect(text).not.toContain(FAKE_PULUMI_TOKEN);
      expect(text).not.toContain(FAKE_AWS_KEY);
      expect(redactions).toHaveLength(2);
    });

    test("redacts every occurrence of a repeated credential", () => {
      const { text, redactions } = scrubText(`${FAKE_AWS_KEY} ... ${FAKE_AWS_KEY}`);
      expect(text).not.toContain(FAKE_AWS_KEY);
      expect(redactions).toHaveLength(2);
    });
  });

  describe("scrubValueDeep", () => {
    test("scrubs string leaves nested inside objects and arrays", () => {
      const input = {
        type: "user",
        message: {
          content: [
            { type: "text", text: `here is my token: ${FAKE_AWS_KEY}` },
            { type: "tool_result", content: [{ type: "text", text: FAKE_PULUMI_TOKEN }] },
          ],
        },
      };

      const { value, redactions } = scrubValueDeep(input);

      expect(redactions).toHaveLength(2);
      const content = (value as typeof input).message.content;
      expect(content[0]?.text).not.toContain(FAKE_AWS_KEY);
      const toolResultContent = content[1]?.content as Array<{ text: string }>;
      expect(toolResultContent[0]?.text).not.toContain(FAKE_PULUMI_TOKEN);
    });

    test("leaves non-string leaves (numbers, booleans, null) untouched", () => {
      const input = { count: 3, active: true, missing: null, name: "plain text" };
      const { value, redactions } = scrubValueDeep(input);
      expect(value).toEqual(input);
      expect(redactions).toEqual([]);
    });

    test("does not mutate the input", () => {
      const input = { text: FAKE_AWS_KEY };
      const { value } = scrubValueDeep(input);
      expect(input.text).toBe(FAKE_AWS_KEY);
      expect((value as typeof input).text).not.toBe(FAKE_AWS_KEY);
    });

    test("handles a self-referential structure without infinite recursion", () => {
      const cyclic: Record<string, unknown> = { text: FAKE_AWS_KEY };
      cyclic.self = cyclic;
      const { value, redactions } = scrubValueDeep(cyclic);
      expect(redactions).toHaveLength(1);
      expect((value as Record<string, unknown>).text).not.toBe(FAKE_AWS_KEY);
    });

    test("returns clean input with zero redactions unchanged", () => {
      const input = { type: "assistant", message: { content: "hello world" } };
      const { value, redactions } = scrubValueDeep(input);
      expect(value).toEqual(input);
      expect(redactions).toEqual([]);
    });
  });
});
