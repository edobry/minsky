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

/**
 * The forwarding contract (mt#4314).
 *
 * Scoped to the CONTRACT rather than to `maxTokens`, deliberately. The defect was not that
 * one field was mistyped — it was that each of the three methods hand-assembles its own call
 * options and nothing asserted a declared request field reaches the SDK. Two of the three
 * forwarded `maxTokens`; `generateObject` did not, so two production callers' caps
 * (`unasked-direction-analyzer` at 2000, `authorship-judge` at 500) had never once been
 * applied. It typechecked, and there is no caller-visible signal of the actual value, so the
 * only way to learn it was to read this file.
 *
 * Pinning `maxTokens` alone would leave the same shape in place for the next field, so these
 * assert per-method that what the caller declares arrives — and that an UNSET field is
 * omitted rather than forwarded as `undefined`, which is mt#2733's separate lesson.
 */
describe("DefaultAICompletionService — request-field forwarding contract (mt#4314)", () => {
  const schema = z.object({ ok: z.boolean() });

  it("complete() forwards the caller's call settings to generateText", async () => {
    const generateText = fakeGenerateText();
    const service = makeService({ generateText });

    await service.complete({
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
      temperature: 0.5,
      maxTokens: 1234,
    });

    const callArgs = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.temperature).toBe(0.5);
    expect(callArgs.maxTokens).toBe(1234);
  });

  it("stream() forwards the caller's call settings to streamText", async () => {
    const streamText = fakeStreamText();
    const service = makeService({ streamText });

    const iterator = service.stream({
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
      temperature: 0.5,
      maxTokens: 1234,
    });
    for await (const _chunk of iterator) {
      // no-op — just draining so streamText is actually invoked
    }

    const callArgs = streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.temperature).toBe(0.5);
    expect(callArgs.maxTokens).toBe(1234);
  });

  it("generateObject() forwards the caller's call settings — the field that was dropped", async () => {
    const generateObject = fakeGenerateObject({ ok: true });
    const service = makeService({ generateObject });

    await service.generateObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      schema,
      temperature: 0.5,
      maxTokens: 1234,
    });

    const callArgs = generateObject.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.temperature).toBe(0.5);
    expect(callArgs.maxTokens).toBe(1234);
  });

  it("generateObject() forwards mode when the caller sets one", async () => {
    // mt#4317 added `mode` to select the structured-output strategy. It reaches the provider
    // only through this spread, and NO production caller currently sets it — so nothing else
    // in the codebase would notice if the forwarding silently stopped working. Same shape as
    // the `maxTokens` defect this file already pins (PR #3200 R3).
    const generateObject = fakeGenerateObject({ ok: true });
    const service = makeService({ generateObject });

    await service.generateObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      schema,
      mode: "tool",
    });

    const callArgs = generateObject.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.mode).toBe("tool");
  });

  it("generateObject() omits mode when the caller did not set one, so the SDK still picks", async () => {
    // The mt#2733 half again: forwarding `mode: undefined` would hand the SDK an explicit
    // value where it expects absence, which is how a default silently stops being a default.
    const generateObject = fakeGenerateObject({ ok: true });
    const service = makeService({ generateObject });

    await service.generateObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      schema,
    });

    const callArgs = generateObject.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(callArgs, "mode")).toBe(false);
  });

  it("generateObject() omits maxTokens when the caller did not set one", async () => {
    // The mt#2733 half: absent means absent, not `undefined` handed to the SDK.
    const generateObject = fakeGenerateObject({ ok: true });
    const service = makeService({ generateObject });

    await service.generateObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      schema,
    });

    const callArgs = generateObject.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(callArgs, "maxTokens")).toBe(false);
  });

  it("complete() omits maxTokens when the caller did not set one", async () => {
    // PR #3156 R1: this path SET the key unconditionally, so an unset cap arrived as
    // `maxTokens: undefined`. Fixing the omission on one method and leaving its siblings
    // is the class-not-instance miss the reviewer caught.
    const generateText = fakeGenerateText();
    const service = makeService({ generateText });

    await service.complete({ provider: "anthropic", model: "claude-sonnet-5", prompt: "hi" });

    const callArgs = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(callArgs, "maxTokens")).toBe(false);
  });

  it("stream() omits maxTokens when the caller did not set one", async () => {
    const streamText = fakeStreamText();
    const service = makeService({ streamText });

    for await (const _chunk of service.stream({
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    })) {
      // draining
    }

    const callArgs = streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(callArgs, "maxTokens")).toBe(false);
  });

  it("all three methods agree on omitting an unset maxTokens", async () => {
    // The contract stated once over all three, so the next method cannot diverge quietly
    // in EITHER direction — forwarding a set value, and omitting an unset one.
    const generateText = fakeGenerateText();
    const generateObject = fakeGenerateObject({ ok: true });
    const streamText = fakeStreamText();
    const service = makeService({ generateText, generateObject, streamText });

    await service.complete({ provider: "anthropic", model: "m", prompt: "hi" });
    await service.generateObject({
      provider: "anthropic",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      schema,
    });
    for await (const _chunk of service.stream({
      provider: "anthropic",
      model: "m",
      prompt: "hi",
    })) {
      // draining
    }

    const hasKey = [
      generateText.mock.calls[0]?.[0],
      generateObject.mock.calls[0]?.[0],
      streamText.mock.calls[0]?.[0],
    ].map((args) => Object.prototype.hasOwnProperty.call(args as object, "maxTokens"));

    expect(hasKey).toEqual([false, false, false]);
  });

  it("every method that accepts maxTokens actually forwards it", async () => {
    // The contract stated once, over all three, so adding a fourth method without
    // forwarding is a failing test rather than a silent drop.
    const generateText = fakeGenerateText();
    const generateObject = fakeGenerateObject({ ok: true });
    const streamText = fakeStreamText();
    const service = makeService({ generateText, generateObject, streamText });

    await service.complete({ provider: "anthropic", model: "m", prompt: "hi", maxTokens: 77 });
    await service.generateObject({
      provider: "anthropic",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      schema,
      maxTokens: 77,
    });
    for await (const _chunk of service.stream({
      provider: "anthropic",
      model: "m",
      prompt: "hi",
      maxTokens: 77,
    })) {
      // draining
    }

    const forwarded = [
      generateText.mock.calls[0]?.[0],
      generateObject.mock.calls[0]?.[0],
      streamText.mock.calls[0]?.[0],
    ].map((args) => (args as Record<string, unknown>).maxTokens);

    expect(forwarded).toEqual([77, 77, 77]);
  });
});
