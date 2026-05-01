/**
 * Tests for LocalConfigCredentialStore.
 *
 * Hermetic: uses an in-memory CredentialFs mock (no real filesystem touches).
 *
 * @see mt#1087
 */

import { describe, test, expect } from "bun:test";
import { setupTestMocks } from "../../../utils/test-utils/mocking";
import { LocalConfigCredentialStore, type CredentialFs } from "./local-config-credential-store";
import type { AppCredentials } from "./types";

setupTestMocks();

const SAMPLE_CREDS: AppCredentials = {
  appId: 12345,
  slug: "my-test-app",
  clientId: "Iv1.abc123def456",
  clientSecret: "super-secret-value",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n",
  htmlUrl: "https://github.com/apps/my-test-app",
  installationId: 98765,
};

interface MockFsState {
  files: Map<string, string>;
  dirs: Set<string>;
  modes: Map<string, number>;
}

function createMockCredentialFs(): { fs: CredentialFs; state: MockFsState } {
  const state: MockFsState = {
    files: new Map(),
    dirs: new Set(),
    modes: new Map(),
  };
  const fs: CredentialFs = {
    existsSync: (p: string) => state.files.has(p) || state.dirs.has(p),
    readFileSync: ((p: string, _enc?: unknown) => {
      const v = state.files.get(p);
      if (v === undefined) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      }
      return v;
    }) as CredentialFs["readFileSync"],
    writeFileSync: (p: string, data: string) => {
      state.files.set(p, data);
    },
    mkdirSync: (p: string, options?: { recursive?: boolean }) => {
      state.dirs.add(p);
      if (options?.recursive) {
        const parts = p.split("/");
        for (let i = 1; i <= parts.length; i++) state.dirs.add(parts.slice(0, i).join("/"));
      }
      return undefined;
    },
    statSync: (p: string) => {
      if (state.files.has(p)) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: state.files.get(p)?.length ?? 0,
          mtime: new Date(),
        };
      }
      if (state.dirs.has(p)) {
        return {
          isFile: () => false,
          isDirectory: () => true,
          size: 0,
          mtime: new Date(),
        };
      }
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    },
    readdirSync: (_p: string) => [],
    chmodSync: (p: string, mode: number) => {
      state.modes.set(p, mode);
    },
  };
  return { fs, state };
}

describe("LocalConfigCredentialStore", () => {
  test("round-trip: write → exists → read returns same credentials", async () => {
    const { fs } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    await store.write("my-test-app", SAMPLE_CREDS);
    expect(await store.exists("my-test-app")).toBe(true);

    const read = await store.read("my-test-app");
    expect(read).not.toBeNull();
    if (read) {
      expect(read.appId).toBe(SAMPLE_CREDS.appId);
      expect(read.slug).toBe(SAMPLE_CREDS.slug);
      expect(read.clientId).toBe(SAMPLE_CREDS.clientId);
      expect(read.clientSecret).toBe(SAMPLE_CREDS.clientSecret);
      expect(read.pem).toBe(SAMPLE_CREDS.pem);
      expect(read.htmlUrl).toBe(SAMPLE_CREDS.htmlUrl);
      expect(read.installationId).toBe(98765);
    }
  });

  test("PEM file written with 0600 permissions", async () => {
    const { fs, state } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    await store.write("my-test-app", SAMPLE_CREDS);

    const pemPath = "/test/dir/my-test-app.pem";
    expect(state.modes.get(pemPath)).toBe(0o600);
  });

  test("JSON metadata file written with 0600 permissions (clientSecret protection)", async () => {
    const { fs, state } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    await store.write("my-test-app", SAMPLE_CREDS);

    const jsonPath = "/test/dir/my-test-app.json";
    expect(state.modes.get(jsonPath)).toBe(0o600);
  });

  test("output directory locked to 0700 on write", async () => {
    const { fs, state } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    await store.write("my-test-app", SAMPLE_CREDS);

    expect(state.modes.get("/test/dir")).toBe(0o700);
  });

  test("read() of missing credentials returns null", async () => {
    const { fs } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    const result = await store.read("nonexistent");
    expect(result).toBeNull();
  });

  test("exists() returns false when both files are absent", async () => {
    const { fs } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    expect(await store.exists("nonexistent")).toBe(false);
  });

  test("exists() returns false when only PEM is present", async () => {
    const { fs, state } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    await store.write("my-test-app", SAMPLE_CREDS);
    state.files.delete("/test/dir/my-test-app.json");

    expect(await store.exists("my-test-app")).toBe(false);
  });

  test("exists() returns false when only JSON is present", async () => {
    const { fs, state } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    await store.write("my-test-app", SAMPLE_CREDS);
    state.files.delete("/test/dir/my-test-app.pem");

    expect(await store.exists("my-test-app")).toBe(false);
  });

  test("exists() returns true when both PEM and JSON are present", async () => {
    const { fs } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    await store.write("my-test-app", SAMPLE_CREDS);
    expect(await store.exists("my-test-app")).toBe(true);
  });

  test("credentials without installationId round-trip correctly", async () => {
    const { fs } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    const credsNoInstall: AppCredentials = { ...SAMPLE_CREDS, installationId: undefined };
    await store.write("no-install", credsNoInstall);

    const read = await store.read("no-install");
    expect(read).not.toBeNull();
    if (read) expect(read.installationId).toBeUndefined();
  });

  test("write() creates the output directory recursively", async () => {
    const { fs, state } = createMockCredentialFs();
    const store = new LocalConfigCredentialStore("/test/dir", fs);

    await store.write("my-test-app", SAMPLE_CREDS);
    expect(state.dirs.has("/test/dir")).toBe(true);
  });
});
