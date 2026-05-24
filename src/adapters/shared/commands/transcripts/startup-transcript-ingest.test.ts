import { describe, it, expect, mock } from "bun:test";
import { triggerStartupTranscriptIngest } from "./startup-transcript-ingest";
import type { BasePersistenceProvider } from "../../../../domain/persistence/types";

describe("triggerStartupTranscriptIngest", () => {
  it("returns early when persistence provider lacks sql capability", async () => {
    const provider = {
      capabilities: { sql: false },
    } as unknown as BasePersistenceProvider;

    await triggerStartupTranscriptIngest(provider);
  });

  it("returns early when getDatabaseConnection is not available", async () => {
    const provider = {
      capabilities: { sql: true },
    } as unknown as BasePersistenceProvider;

    await triggerStartupTranscriptIngest(provider);
  });

  it("returns early when getDatabaseConnection returns null", async () => {
    const getDatabaseConnection = mock(() => Promise.resolve(null));
    const provider = {
      capabilities: { sql: true },
      getDatabaseConnection,
    } as unknown as BasePersistenceProvider;

    await triggerStartupTranscriptIngest(provider);
    expect(getDatabaseConnection).toHaveBeenCalledTimes(1);
  });
});
