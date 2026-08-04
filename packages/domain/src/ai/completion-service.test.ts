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
 * These tests inject fake `generateText` / `generateObject` / `streamText`
 * implementations through `DefaultAICompletionService`'s constructor `deps`
 * parameter (mt#3622) and assert on the literal call-argument object
 * completion-service.ts builds. This is deliberately NOT testing the AI
 * SDK's own internal normalization (Vercel AI SDK v4's `prepareCallSettings`
 * defaults an unset temperature to `0` before it reaches a provider's
 * `doGenerate` — a separate, upstream SDK behavior outside this file's
 * control) — it tests only what this codebase is responsible for: not
 * fabricating or forwarding an unset temperature into the call it makes.
 *
 * Prior to mt#3622 this suite used `spyOn` on the "ai" module's own export
 * object (`import * as aiModule from "ai"`), relying on Bun's ESM
 * live-binding semantics to make the spy visible to completion-service.ts's
 * named imports of the same functions. The constructor-injected `deps` seam
 * removes that dependency entirely: the fakes below are passed directly, so
 * there is no live-binding trick to reason about and no module-registry
 * mutation to restore between tests.
 */

import { describe, it, expect, mock } from "bun:test";
import { z } from "zod";
import { DefaultAICompletionService, type AICompletionServiceDeps } from "./completion-service";
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

function makeService(deps: Partial<AICompletionServiceDeps>): DefaultAICompletionService {
  return new DefaultAICompletionService(fakeConfigService, deps);
}

function fakeGenerateText() {
  return mock(async () => ({
    text: "ok",
    usage: {},
    toolCalls: undefined,
    steps: undefined,
    finishReason: "stop",
    experimental_providerMetadata: undefined,
  })) as unknown as AICompletionServiceDeps["generateText"] & {
    mock: { calls: unknown[][] };
  };
}

function fakeGenerateObject(returnedObject: unknown) {
  return mock(async () => ({
    object: returnedObject,
  })) as unknown as AICompletionServiceDeps["generateObject"] & {
    mock: { calls: unknown[][] };
  };
}

function fakeStreamText() {
  return mock(() => ({
    textStream: (async function* () {
      yield "ok";
    })(),
    text: Promise.resolve("ok"),
    usage: Promise.resolve({}),
    toolCalls: Promise.resolve(undefined),
    finishReason: Promise.resolve("stop"),
  })) as unknown as AICompletionServiceDeps["streamText"] & {
    mock: { calls: unknown[][] };
  };
}

describe("DefaultAICompletionService — temperature handling (mt#2733)", () => {
  describe("complete() -> generateText", () => {
    it("omits temperature from the generateText call when the caller did not set one", async () => {
      const generateText = fakeGenerateText();
      const service = makeService({ generateText });

      await service.complete({
        provider: "anthropic",
        model: "claude-sonnet-5",
        prompt: "hi",
      });

      expect(generateText).toHaveBeenCalledTimes(1);
      const callArgs = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(callArgs, "temperature")).toBe(false);
    });

    it("passes an explicit temperature: 0 through unchanged", async () => {
      const generateText = fakeGenerateText();
      const service = makeService({ generateText });

      await service.complete({
        provider: "anthropic",
        model: "claude-sonnet-5",
        prompt: "hi",
        temperature: 0,
      });

      expect(generateText).toHaveBeenCalledTimes(1);
      const callArgs = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.temperature).toBe(0);
    });

    it("passes an explicit non-zero temperature through unchanged", async () => {
      const generateText = fakeGenerateText();
      const service = makeService({ generateText });

      await service.complete({
        provider: "anthropic",
        model: "claude-sonnet-5",
        prompt: "hi",
        temperature: 0.7,
      });

      const callArgs = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.temperature).toBe(0.7);
    });
  });

  describe("generateObject()", () => {
    const schema = z.object({ ok: z.boolean() });

    it("omits temperature from the generateObject call when the caller did not set one (no 0.3 fabrication)", async () => {
      const generateObject = fakeGenerateObject({ ok: true });
      const service = makeService({ generateObject });

      await service.generateObject({
        provider: "anthropic",
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        schema,
      });

      expect(generateObject).toHaveBeenCalledTimes(1);
      const callArgs = generateObject.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(callArgs, "temperature")).toBe(false);
    });

    it("passes an explicit temperature: 0 through unchanged (not clobbered to 0.3)", async () => {
      const generateObject = fakeGenerateObject({ ok: true });
      const service = makeService({ generateObject });

      await service.generateObject({
        provider: "anthropic",
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        schema,
        temperature: 0,
      });

      const callArgs = generateObject.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.temperature).toBe(0);
    });

    it("passes an explicit non-zero temperature through unchanged", async () => {
      const generateObject = fakeGenerateObject({ ok: true });
      const service = makeService({ generateObject });

      await service.generateObject({
        provider: "anthropic",
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        schema,
        temperature: 0.5,
      });

      const callArgs = generateObject.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.temperature).toBe(0.5);
    });
  });

  describe("stream() -> streamText", () => {
    it("omits temperature from the streamText call when the caller did not set one", async () => {
      const streamText = fakeStreamText();
      const service = makeService({ streamText });

      const iterator = service.stream({
        provider: "anthropic",
        model: "claude-sonnet-5",
        prompt: "hi",
      });
      // Drain the async generator so streamText is actually invoked.
      for await (const _chunk of iterator) {
        // no-op — just draining
      }

      expect(streamText).toHaveBeenCalledTimes(1);
      const callArgs = streamText.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(callArgs, "temperature")).toBe(false);
    });
  });
});
