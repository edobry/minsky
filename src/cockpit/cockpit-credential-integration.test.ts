/**
 * Cockpit credential integration tests (mt#2146)
 *
 * Tests the credential add/remove flow with real domain modules — specifically
 * the ConfigWriter + Zod schema validation path that the mock-based tests in
 * cockpit.test.ts bypass. Uses a temp config directory for filesystem isolation.
 *
 * Originating incident: mt#2138 — the Zod config schema was missing the
 * `railway` block, so `POST /api/credentials/add` with provider=railway
 * failed with a schema validation error. The mock-based tests never exercised
 * this path because `makeCredentialModuleStub()` returns hardcoded success
 * without calling the real ConfigWriter.
 */
/* eslint-disable custom/no-real-fs-in-tests -- integration test: exercises real ConfigWriter + Zod schema against temp dirs */
import { describe, test, expect } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createConfigWriter } from "@minsky/domain/configuration/config-writer";
import { KNOWN_PROVIDER_IDS, getCredentialProvider } from "@minsky/domain/credentials";
import { createCockpitServer } from "./server";
import type { CredentialModuleOverride } from "./server";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "minsky-cred-test-"));
}

async function startTestServer(
  opts?: Parameters<typeof createCockpitServer>[0]
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createCockpitServer(opts);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  const url = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return { url, close };
}

/**
 * Build a CredentialModuleOverride that uses the REAL ConfigWriter (with
 * temp configDir) but stubs out the external API calls (validate/test).
 * This tests: server route -> credential module -> ConfigWriter -> Zod schema.
 */
function makeRealWriterOverride(configDir: string): CredentialModuleOverride {
  return {
    getCredentialProvider: (id: string) => {
      const provider = getCredentialProvider(id);
      if (!provider) return undefined;
      return {
        validate: async (_token: string) => ({ ok: true, detail: "stub-ok" }),
      };
    },
    addCredential: async (providerId: string, token: string) => {
      const provider = getCredentialProvider(providerId);
      if (!provider) {
        throw new Error(`Unknown credential provider: ${providerId}`);
      }

      const writer = createConfigWriter({
        validate: true,
        configDir,
        format: "yaml",
        createBackup: false,
      });
      const writeResult = await writer.setConfigValue(provider.configPath, token);
      if (!writeResult.success) {
        throw new Error(`Failed to persist credential: ${writeResult.error}`);
      }

      return {
        provider: provider.id,
        validate: { ok: true, detail: "stub-ok" },
        stored: { configFilePath: writeResult.filePath },
        test: { ok: true, detail: "stub-smoke-ok" },
      };
    },
    listCredentials: async () => [],
    removeCredential: async (_provider: string) => ({ removed: true }),
  };
}

// ---------------------------------------------------------------------------
// 1. Schema-level integration: ConfigWriter + Zod for every provider
// ---------------------------------------------------------------------------

describe("Credential schema integration", () => {
  test("provider registry is non-empty", () => {
    expect(KNOWN_PROVIDER_IDS.length).toBeGreaterThan(0);
  });

  test("all registered provider configPaths pass Zod schema validation", async () => {
    expect(KNOWN_PROVIDER_IDS.length).toBeGreaterThan(0);

    const tempDir = makeTempConfigDir();
    try {
      for (const providerId of KNOWN_PROVIDER_IDS) {
        const provider = getCredentialProvider(providerId);
        if (!provider) throw new Error(`Provider '${providerId}' not found in registry`);

        const writer = createConfigWriter({
          validate: true,
          configDir: tempDir,
          format: "yaml",
          createBackup: false,
        });
        const result = await writer.setConfigValue(provider.configPath, "test-token-value");

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const providerId of KNOWN_PROVIDER_IDS) {
    test(`provider '${providerId}' configPath writes and validates individually`, async () => {
      const tempDir = makeTempConfigDir();
      try {
        const provider = getCredentialProvider(providerId);
        if (!provider) throw new Error(`Provider '${providerId}' not found in registry`);
        const writer = createConfigWriter({
          validate: true,
          configDir: tempDir,
          format: "yaml",
          createBackup: false,
        });

        const result = await writer.setConfigValue(provider.configPath, "test-token");
        expect(result.success).toBe(true);
        expect(result.filePath).toContain(tempDir);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  test("unknown top-level key is rejected by strictObject schema", async () => {
    const tempDir = makeTempConfigDir();
    try {
      const writer = createConfigWriter({
        validate: true,
        configDir: tempDir,
        format: "yaml",
        createBackup: false,
      });
      const result = await writer.setConfigValue("bogusTopLevel.key", "value");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Server-route integration: POST /api/credentials/add with real ConfigWriter
// ---------------------------------------------------------------------------

describe("Credential server-route integration", () => {
  for (const providerId of KNOWN_PROVIDER_IDS) {
    test(`POST /api/credentials/add succeeds for provider '${providerId}'`, async () => {
      const tempDir = makeTempConfigDir();
      const { url, close } = await startTestServer({
        overrideConfig: { widgets: [] },
        overrideCredentialModule: makeRealWriterOverride(tempDir),
      });
      try {
        const res = await fetch(`${url}/api/credentials/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: providerId, token: "test-token-value" }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          provider: string;
          validate: { ok: boolean };
          stored?: { configFilePath: string };
        };
        expect(body.provider).toBe(providerId);
        expect(body.validate.ok).toBe(true);
        expect(body.stored).toBeDefined();
        if (!body.stored) throw new Error("stored should be defined");
        expect(body.stored.configFilePath).toContain(tempDir);
      } finally {
        await close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  test("POST /api/credentials/add rejects unknown provider", async () => {
    const tempDir = makeTempConfigDir();
    const { url, close } = await startTestServer({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: makeRealWriterOverride(tempDir),
    });
    try {
      const res = await fetch(`${url}/api/credentials/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "nonexistent", token: "test-token" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("unknown_provider");
    } finally {
      await close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
