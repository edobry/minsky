/**
 * Tests for GuidedWizardProvisioner.
 *
 * Hermetic: injects a mock prompts implementation via constructor (no
 * mock.module). Mocks global fetch for the PEM-validation step.
 *
 * @see mt#1087
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { setupTestMocks } from "../../../utils/test-utils/mocking";
import { GuidedWizardProvisioner, type WizardPrompts } from "./guided-wizard-provisioner";
import { BrowserCancelledError } from "./provisioner";
import type { AppManifestSpec } from "./types";

setupTestMocks();

const SAMPLE_SPEC: AppManifestSpec = {
  name: "test-app",
  repo: "owner/repo",
  owner: "owner",
  permissions: { pull_requests: "write" },
  events: [],
  inactive: true,
};

const TEST_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu
KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm
o3qGy0t6z09AIJtH+5OeRV1be+N4cDYJKffGzDa88vQENZiRm0GRq6a+HPGQMd2k
TQIhAKMSvzIBnni7ot/OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBCUEaRQnMnbp7
9mxDXDf6AU0cN/RPBjb9qSHDcWZHGzUCIG2Es59z8ugGrDY+pxLQnwfotadxd+Uy
v/Ow5T0q5gIJAiEAyS4RaI9YG8EWx/2w0T67ZUVAw8eOMB6BIUg0Xcu+3okCIBOs
/5OiPgoTdSy7bcF9IGpSE8ZgGKzgYQVZeN97YE00
-----END RSA PRIVATE KEY-----
`;

const CANCEL = Symbol.for("clack.cancel");

interface PromptScript {
  texts: (string | typeof CANCEL)[];
  confirms: (boolean | typeof CANCEL)[];
}

function makePrompts(script: PromptScript): WizardPrompts {
  let textIdx = 0;
  let confirmIdx = 0;
  return {
    text: async (_opts) => script.texts[textIdx++],
    confirm: async (_opts) => script.confirms[confirmIdx++],
    note: () => {
      /* no-op */
    },
    cancel: () => {
      /* no-op */
    },
    isCancel: (v) => v === CANCEL,
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GuidedWizardProvisioner", () => {
  test("happy path: walks all prompts, validates PEM, returns credentials", async () => {
    const prompts = makePrompts({
      texts: ["12345", "test-app", "Iv1.abc123", "shh-secret", TEST_PEM, "98765"],
      confirms: [true],
    });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ html_url: "https://github.com/apps/test-app" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const provisioner = new GuidedWizardProvisioner(prompts);
    const creds = await provisioner.provision(SAMPLE_SPEC);

    expect(creds.appId).toBe(12345);
    expect(creds.slug).toBe("test-app");
    expect(creds.clientId).toBe("Iv1.abc123");
    expect(creds.clientSecret).toBe("shh-secret");
    expect(creds.installationId).toBe(98765);
    expect(creds.htmlUrl).toBe("https://github.com/apps/test-app");
  });

  test("user cancel at App ID prompt → BrowserCancelledError", async () => {
    const prompts = makePrompts({ texts: [CANCEL], confirms: [] });
    const provisioner = new GuidedWizardProvisioner(prompts);
    await expect(provisioner.provision(SAMPLE_SPEC)).rejects.toBeInstanceOf(BrowserCancelledError);
  });

  test("user cancel at PEM prompt → BrowserCancelledError", async () => {
    const prompts = makePrompts({
      texts: ["12345", "test-app", "Iv1.abc", "shh", CANCEL],
      confirms: [],
    });
    const provisioner = new GuidedWizardProvisioner(prompts);
    await expect(provisioner.provision(SAMPLE_SPEC)).rejects.toBeInstanceOf(BrowserCancelledError);
  });

  test("PEM validation against /app rejecting (401) surfaces as a thrown error", async () => {
    const prompts = makePrompts({
      texts: ["12345", "test-app", "Iv1.abc", "shh", TEST_PEM, ""],
      confirms: [true],
    });

    globalThis.fetch = (async () =>
      new Response("Bad credentials", { status: 401 })) as unknown as typeof fetch;

    const provisioner = new GuidedWizardProvisioner(prompts);
    await expect(provisioner.provision(SAMPLE_SPEC)).rejects.toThrow(/PEM validation failed/);
  });

  test("skipping validation (confirm=false) returns credentials without calling /app", async () => {
    const prompts = makePrompts({
      texts: ["12345", "test-app", "Iv1.abc", "shh", TEST_PEM, ""],
      confirms: [false],
    });

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const provisioner = new GuidedWizardProvisioner(prompts);
    const creds = await provisioner.provision(SAMPLE_SPEC);

    expect(creds.appId).toBe(12345);
    expect(fetchCalled).toBe(false);
    expect(creds.installationId).toBeUndefined();
  });
});
