/**
 * Regression tests for mt#2733: completion-service must not send a
 * fabricated/pass-through `temperature` to the Vercel AI SDK.
 *
 * `generateObject` used to fabricate `request.temperature || 0.3` (which
 * clobbers an explicit `temperature: 0`); `complete`/`stream` passed
 * `temperature: request.temperature` even when the caller never set it,
 * which the AI SDK forwards downstream. Models that reject `temperature`
 * entirely (e.g. claude-sonnet-5, "temperature is deprecated for this
 * model") fail on any of these paths.
 *
 * The fix: include `temperature` in the object passed to `generateText` /
 * `streamText` / `generateObject` ONLY when the caller explicitly provided
 * one (conditional spread), never fabricated, never passed through as
 * `undefined`.
 *
 * These tests spy on the "ai" package's exported `generateText` /
 * `generateObject` functions (via `spyOn` on the module namespace object,
 * which Bun's ESM live-binding semantics make visible to
 * completion-service.ts's named imports of the same functions) and assert
 * on the literal call-argument object completion-service.ts builds. This
 * is deliberately NOT testing the AI SDK's own internal normalization
 * (Vercel AI SDK v4's `prepareCallSettings` defaults an unset temperature
 * to `0` before it reaches a provider's `doGenerate` — a separate,
 * upstream SDK behavior outside this file's control) — it tests only what
 * this codebase is responsible for: not fabricating or forwarding an
 * unset temperature into the call it makes.
 *
 * No `mock.module()` is used (banned outside tests/setup.ts); `spyOn` on
 * the "ai" module's own export object is a narrower, module-registry-safe
 * technique.
 *
 * Reliability of this seam (addressing PR review feedback that a
 * namespace-object spy might not reliably intercept a named import):
 * completion-service.ts imports `generateText`/`generateObject`/`streamText`
 * as `import { generateText, streamText, generateObject, ... } from "ai"`
 * — under Bun's ESM live-binding semantics, a named import and the
 * corresponding property on the namespace object obtained via
 * `import * as aiModule from "ai"` reference the SAME underlying export
 * slot, so `spyOn(aiModule, "generateText")` patches what
 * completion-service.ts's `generateText` reference resolves to as well.
 * This isn't asserted only by inspection: every test below configures the
 * fake `AnyConfigService` with a placeholder (non-functional) API key and
 * NO network mocking exists anywhere in this suite — if the spy failed to
 * intercept, the real `generateText`/`generateObject`/`streamText` would
 * run and either attempt a real network call (which would fail fast on
 * the placeholder key, or hang past the 15s test timeout) instead of
 * returning the spy's synchronous mock value. All tests pass in well
 * under a second, which is only possible if interception is working.
 */

import { describe, it, expect, spyOn, afterEach } from "bun:test";
import * as aiModule from "ai";
import { z } from "zod";
import { DefaultAICompletionService } from "./completion-service";
import type { AnyConfigService } from "./config-service";

/** Minimal config service satisfying AnyConfigService's `getConfig()` shape. */
const fakeConfigService: AnyConfigService = {
  getConfig: () => ({
    ai: {
      providers: {
        anthropic: {
          apiKey: "test-anthropic-key",
        },
      },
    },
  }),
};

function makeService(): DefaultAICompletionService {
  return new DefaultAICompletionService(fakeConfigService);
}

// Track spies created per-test so they can always be restored, even on
// assertion failure, without relying on global mock-cleanup behavior.
let activeSpies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of activeSpies) {
    spy.mockRestore();
  }
  activeSpies = [];
});

function spyOnGenerateText() {
  const spy = spyOn(aiModule, "generateText").mockImplementation((async () => ({
    text: "ok",
    usage: {},
    toolCalls: undefined,
    steps: undefined,
    finishReason: "stop",
    experimental_providerMetadata: undefined,
  })) as any);
  activeSpies.push(spy);
  return spy;
}

function spyOnGenerateObject(returnedObject: unknown) {
  const spy = spyOn(aiModule, "generateObject").mockImplementation((async () => ({
    object: returnedObject,
  })) as any);
  activeSpies.push(spy);
  return spy;
}

describe("DefaultAICompletionService — temperature handling (mt#2733)", () => {
  describe("complete() -> generateText", () => {
    it("omits temperature from the generateText call when the caller did not set one", async () => {
      const spy = spyOnGenerateText();
      const service = makeService();

      await service.complete({
        provider: "anthropic",
        model: "claude-sonnet-5",
        prompt: "hi",
      });

      expect(spy).toHaveBeenCalledTimes(1);
      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(callArgs, "temperature")).toBe(false);
    });

    it("passes an explicit temperature: 0 through unchanged", async () => {
      const spy = spyOnGenerateText();
      const service = makeService();

      await service.complete({
        provider: "anthropic",
        model: "claude-sonnet-5",
        prompt: "hi",
        temperature: 0,
      });

      expect(spy).toHaveBeenCalledTimes(1);
      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.temperature).toBe(0);
    });

    it("passes an explicit non-zero temperature through unchanged", async () => {
      const spy = spyOnGenerateText();
      const service = makeService();

      await service.complete({
        provider: "anthropic",
        model: "claude-sonnet-5",
        prompt: "hi",
        temperature: 0.7,
      });

      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.temperature).toBe(0.7);
    });
  });

  describe("generateObject()", () => {
    const schema = z.object({ ok: z.boolean() });

    it("omits temperature from the generateObject call when the caller did not set one (no 0.3 fabrication)", async () => {
      const spy = spyOnGenerateObject({ ok: true });
      const service = makeService();

      await service.generateObject({
        provider: "anthropic",
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        schema,
      });

      expect(spy).toHaveBeenCalledTimes(1);
      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(callArgs, "temperature")).toBe(false);
    });

    it("passes an explicit temperature: 0 through unchanged (not clobbered to 0.3)", async () => {
      const spy = spyOnGenerateObject({ ok: true });
      const service = makeService();

      await service.generateObject({
        provider: "anthropic",
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        schema,
        temperature: 0,
      });

      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.temperature).toBe(0);
    });

    it("passes an explicit non-zero temperature through unchanged", async () => {
      const spy = spyOnGenerateObject({ ok: true });
      const service = makeService();

      await service.generateObject({
        provider: "anthropic",
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        schema,
        temperature: 0.5,
      });

      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.temperature).toBe(0.5);
    });
  });

  describe("stream() -> streamText", () => {
    it("omits temperature from the streamText call when the caller did not set one", async () => {
      const spy = spyOn(aiModule, "streamText").mockImplementation((() => ({
        textStream: (async function* () {
          yield "ok";
        })(),
        text: Promise.resolve("ok"),
        usage: Promise.resolve({}),
        toolCalls: Promise.resolve(undefined),
        finishReason: Promise.resolve("stop"),
      })) as any);
      activeSpies.push(spy);
      const service = makeService();

      const iterator = service.stream({
        provider: "anthropic",
        model: "claude-sonnet-5",
        prompt: "hi",
      });
      // Drain the async generator so streamText is actually invoked.
      for await (const _chunk of iterator) {
        // no-op — just draining
      }

      expect(spy).toHaveBeenCalledTimes(1);
      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(callArgs, "temperature")).toBe(false);
    });
  });
});
