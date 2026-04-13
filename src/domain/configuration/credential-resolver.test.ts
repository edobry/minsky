/**
 * Tests for DefaultCredentialResolver
 *
 * Verifies that all valid CredentialSource values are handled correctly
 * and that the resolver aligns with config-validator's accepted values.
 */

import { describe, expect, test } from "bun:test";
import { DefaultCredentialResolver } from "./credential-resolver";
import type { CredentialConfig } from "./credential-resolver";

describe("DefaultCredentialResolver.resolveCredentialFromConfig", () => {
  const resolver = new DefaultCredentialResolver();

  describe('source: "env"', () => {
    test("returns token when provided", async () => {
      const config: CredentialConfig = { source: "env", token: "my-token" };
      const result = await resolver.resolveCredentialFromConfig(config);
      expect(result).toBe("my-token");
    });

    test("returns api_key when token is absent", async () => {
      const config: CredentialConfig = { source: "env", api_key: "my-api-key" };
      const result = await resolver.resolveCredentialFromConfig(config);
      expect(result).toBe("my-api-key");
    });

    test("returns undefined when neither token nor api_key is set", async () => {
      const config: CredentialConfig = { source: "env" };
      const result = await resolver.resolveCredentialFromConfig(config);
      expect(result).toBeUndefined();
    });
  });

  describe('source: "file"', () => {
    test("returns token when present (skips file lookup)", async () => {
      const config: CredentialConfig = { source: "file", token: "direct-token" };
      const result = await resolver.resolveCredentialFromConfig(config);
      expect(result).toBe("direct-token");
    });

    test("returns undefined when token_file path does not exist", async () => {
      const config: CredentialConfig = {
        source: "file",
        token_file: "/nonexistent/path/token.txt",
      };
      const result = await resolver.resolveCredentialFromConfig(config);
      expect(result).toBeUndefined();
    });

    test("returns undefined when no token, api_key, token_file, or api_key_file is set", async () => {
      const config: CredentialConfig = { source: "file" };
      const result = await resolver.resolveCredentialFromConfig(config);
      expect(result).toBeUndefined();
    });
  });

  describe('source: "keychain"', () => {
    test("throws not-implemented error", async () => {
      const config: CredentialConfig = { source: "keychain" };
      await expect(resolver.resolveCredentialFromConfig(config)).rejects.toThrow(
        "System keychain credential resolution not yet implemented"
      );
    });
  });

  describe('source: "manual"', () => {
    test("throws not-implemented error", async () => {
      const config: CredentialConfig = { source: "manual" };
      await expect(resolver.resolveCredentialFromConfig(config)).rejects.toThrow(
        "Interactive credential prompting not yet implemented"
      );
    });
  });
});
