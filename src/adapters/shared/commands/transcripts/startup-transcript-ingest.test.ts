import { describe, it, expect, mock } from "bun:test";
import { triggerStartupTranscriptIngest } from "./startup-transcript-ingest";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";

describe("triggerStartupTranscriptIngest", () => {
  it("returns early when persistence provider lacks sql capability", async () => {
    const getDatabaseConnection = mock(() => Promise.resolve({}));
    const provider = {
      capabilities: { sql: false },
      getDatabaseConnection,
    } as unknown as BasePersistenceProvider;

    await triggerStartupTranscriptIngest(provider);
    expect(getDatabaseConnection).not.toHaveBeenCalled();
  });

  it("returns early when getDatabaseConnection is not available", async () => {
    const provider = {
      capabilities: { sql: true },
    } as unknown as BasePersistenceProvider;

    await triggerStartupTranscriptIngest(provider);
  });

  it("retries once when getDatabaseConnection returns null", async () => {
    const getDatabaseConnection = mock(() => Promise.resolve(null));
    const provider = {
      capabilities: { sql: true },
      getDatabaseConnection,
    } as unknown as BasePersistenceProvider;

    // mt#2980: inject a near-zero retry delay in place of the real 5s
    // INIT_RETRY_DELAY_MS — this test only asserts the retry-once behavior,
    // not the actual production delay duration.
    await triggerStartupTranscriptIngest(provider, { initRetryDelayMs: 0 });
    expect(getDatabaseConnection).toHaveBeenCalledTimes(2);
  });
});
