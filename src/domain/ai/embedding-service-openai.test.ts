import { describe, it, expect } from "bun:test";
import { OpenAIEmbeddingService } from "./embedding-service-openai";

function mockFetchOnce(status: number, statusText: string, body: any) {
  // @ts-ignore
  globalThis.fetch = async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body);
      },
      async json() {
        return typeof body === "string" ? JSON.parse(body) : body;
      },
    } as any;
  };
}

describe("OpenAIEmbeddingService error formatting", () => {
  it("formats 400 errors with provider code/message details when JSON provided", async () => {
    const svc = new OpenAIEmbeddingService(
      "test-key",
      "https://api.example.test/v1",
      "text-embedding-3-small"
    );
    mockFetchOnce(400, "Bad Request", {
      error: {
        type: "invalid_request_error",
        code: "content_policy_violation",
        message: "Input too long for model",
      },
    });

    let err: any = null;
    try {
      await svc.generateEmbedding("x".repeat(200000));
    } catch (e) {
      err = e;
    }

    expect(err).toBeTruthy();
    const msg = String(err?.message || err);
    expect(msg).toContain("Embedding request failed: 400 Bad Request");
    expect(msg).toContain("content_policy_violation");
    expect(msg).toContain("Input too long for model");
  });
});
