/**
 * Unit tests for redaction utilities (mt#1181).
 */
import { describe, test, expect } from "bun:test";
import { isSensitiveKey, redact, SENSITIVE_KEY_PATTERNS } from "./redaction";

describe("isSensitiveKey", () => {
  test("matches exact sensitive key names", () => {
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("secret")).toBe(true);
    expect(isSensitiveKey("connectionString")).toBe(true);
  });

  test("matches compound *Key and *_key suffix patterns", () => {
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("secretKey")).toBe(true);
    expect(isSensitiveKey("privateKey")).toBe(true);
    expect(isSensitiveKey("accessKey")).toBe(true);
    expect(isSensitiveKey("authKey")).toBe(true);
    expect(isSensitiveKey("signingKey")).toBe(true);
    expect(isSensitiveKey("encryptionKey")).toBe(true);
    expect(isSensitiveKey("private_key")).toBe(true);
    expect(isSensitiveKey("access_key")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
  });

  test("does NOT match benign keys that contain 'key' as a prefix or mid-word", () => {
    // These were false positives with the old bare 'key' substring match.
    expect(isSensitiveKey("monkey")).toBe(false);
    expect(isSensitiveKey("keyboard")).toBe(false);
    expect(isSensitiveKey("keyPath")).toBe(false);
    expect(isSensitiveKey("surveyKeyPath")).toBe(false);
  });

  test("does not match non-sensitive key names", () => {
    expect(isSensitiveKey("name")).toBe(false);
    expect(isSensitiveKey("value")).toBe(false);
    expect(isSensitiveKey("status")).toBe(false);
    expect(isSensitiveKey("count")).toBe(false);
    expect(isSensitiveKey("normal")).toBe(false);
  });

  test("case-insensitive matching: Token, API_KEY, ConnectionString all match", () => {
    expect(isSensitiveKey("Token")).toBe(true);
    expect(isSensitiveKey("TOKEN")).toBe(true);
    expect(isSensitiveKey("API_KEY")).toBe(true);
    expect(isSensitiveKey("ConnectionString")).toBe(true);
    expect(isSensitiveKey("CONNECTIONSTRING")).toBe(true);
    expect(isSensitiveKey("APIKEY")).toBe(true);
    expect(isSensitiveKey("apikey")).toBe(true);
  });

  test("SENSITIVE_KEY_PATTERNS is readonly and contains expected entries", () => {
    expect(SENSITIVE_KEY_PATTERNS).toContain("token");
    expect(SENSITIVE_KEY_PATTERNS).toContain("apiKey");
    expect(SENSITIVE_KEY_PATTERNS).toContain("password");
    expect(SENSITIVE_KEY_PATTERNS).toContain("secret");
    expect(SENSITIVE_KEY_PATTERNS).toContain("connectionString");
    // 'key' as a bare substring is intentionally absent — see SENSITIVE_KEY_REGEX
    expect(SENSITIVE_KEY_PATTERNS).not.toContain("key");
  });
});

describe("redact", () => {
  test("flat object: sensitive key is redacted, non-sensitive key passes through", () => {
    const input = { token: "secret-value", normal: "visible" };
    const result = redact(input);
    expect(result.token).toBe("[REDACTED]");
    expect(result.normal).toBe("visible");
  });

  test("nested object: inner.token redacted, inner.normal intact", () => {
    const input = { inner: { token: "x", normal: "y" }, outer: "ok" };
    const result = redact(input);
    expect(result.inner.token).toBe("[REDACTED]");
    expect(result.inner.normal).toBe("y");
    expect(result.outer).toBe("ok");
  });

  test("array of objects: each element redacted independently", () => {
    const input = [
      { token: "t1", name: "a" },
      { password: "p1", name: "b" },
    ];
    const result = redact(input);
    expect(result[0]?.token).toBe("[REDACTED]");
    expect(result[0]?.name).toBe("a");
    expect(result[1]?.password).toBe("[REDACTED]");
    expect(result[1]?.name).toBe("b");
  });

  test("null passes through without throwing", () => {
    expect(redact(null)).toBeNull();
  });

  test("undefined passes through without throwing", () => {
    expect(redact(undefined)).toBeUndefined();
  });

  test("primitive string passes through", () => {
    expect(redact("hello")).toBe("hello");
  });

  test("primitive number passes through", () => {
    expect(redact(42)).toBe(42);
  });

  test("primitive boolean passes through", () => {
    expect(redact(false)).toBe(false);
  });

  test("circular reference does not loop", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    // Should not throw; circular reference replaced with sentinel
    expect(() => redact(obj)).not.toThrow();
    const result = redact(obj);
    expect(result.self).toBe("[Circular]");
  });

  test("input object is not mutated after redact", () => {
    const input = { token: "original", normal: "value" };
    redact(input);
    expect(input.token).toBe("original");
    expect(input.normal).toBe("value");
  });

  test("apiKey is redacted regardless of value type", () => {
    const input: Record<string, unknown> = { apiKey: 12345, normal: true };
    const result = redact(input);
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.normal).toBe(true);
  });

  test("deeply nested sensitive key is redacted", () => {
    const input = { config: { ai: { providers: { openai: { apiKey: "sk-abc" } } } } };
    const result = redact(input);
    expect(result.config.ai.providers.openai.apiKey).toBe("[REDACTED]");
  });

  test("private_key and accessKey are redacted", () => {
    const input = { private_key: "pk-value", accessKey: "ak-value", normal: "ok" };
    const result = redact(input);
    expect(result.private_key).toBe("[REDACTED]");
    expect(result.accessKey).toBe("[REDACTED]");
    expect(result.normal).toBe("ok");
  });

  test("monkey, keyboard, keyPath are NOT redacted (false-positive guard)", () => {
    const input = { monkey: "banana", keyboard: "qwerty", keyPath: "/foo/bar" };
    const result = redact(input);
    expect(result.monkey).toBe("banana");
    expect(result.keyboard).toBe("qwerty");
    expect(result.keyPath).toBe("/foo/bar");
  });
});
