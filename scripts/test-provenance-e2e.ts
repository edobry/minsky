/**
 * End-to-end verification for mt#1081.
 *
 * Runs the AuthorshipJudge against a real Claude Code JSONL transcript
 * using the Anthropic API to prove `generateObject` survives the full
 * Zod-v4 → JSON-Schema → Anthropic → Zod-parse round-trip.
 *
 * Usage:
 *   bun scripts/test-provenance-e2e.ts [path/to/transcript.jsonl]
 *
 * If no path is given, falls back to the author's default transcript.
 *
 * Requires:
 *   - Anthropic API key in Minsky config (minsky config get ai.anthropic.apiKey)
 *   - A provenance record with a session_id in the provenance table
 *   - A readable JSONL transcript file
 *
 * Not part of the test suite because it makes a real paid API call.
 */

import "reflect-metadata";
import { setupConfiguration } from "../src/config-setup";
await setupConfiguration();

import { getConfiguration } from "../src/domain/configuration/index";
import { PersistenceService } from "../src/domain/persistence/service";
import {
  ProvenanceService,
  AgentTranscriptService,
  AuthorshipJudge,
} from "../src/domain/provenance";
import { createCompletionService } from "../src/domain/ai/service-factory";
import type { ResolvedConfig } from "../src/domain/configuration/types";
import { eq } from "drizzle-orm";
import { provenanceTable } from "../src/domain/storage/schemas/provenance-schema";

const persistence = new PersistenceService();
await persistence.initialize();
const provider = persistence.getProvider();
const db = await provider.getDatabaseConnection();
if (!db) throw new Error("No database connection");

const rows = await db
  .select()
  .from(provenanceTable)
  .where(eq(provenanceTable.artifactType, "pr"))
  .limit(1);
const record = rows[0];
if (!record) {
  console.log("No PR provenance records found");
  process.exit(0);
}
console.log(`Testing with artifact_id=${record.artifactId} session_id=${record.sessionId}`);

if (!record.sessionId) {
  console.log("Record has no session_id");
  process.exit(0);
}

const transcriptService = new AgentTranscriptService(db);
const defaultJsonlPath =
  "/Users/edobry/.claude/projects/-Users-edobry-Projects-minsky/f7dd3fee-977d-40f2-bcdc-a26f573b2117.jsonl";
const jsonlPath = process.argv[2] ?? defaultJsonlPath;
console.log(`Ingesting ${jsonlPath} as session ${record.sessionId}...`);
const stats = await transcriptService.ingestTranscript(record.sessionId, jsonlPath);
console.log(`Ingested: ${JSON.stringify(stats)}`);

const config = getConfiguration() as ResolvedConfig;
const completionService = createCompletionService(config);
const judge = new AuthorshipJudge(completionService);
const transcript = await transcriptService.getTranscript(record.sessionId);
if (!transcript) throw new Error("Transcript not retrievable after ingest");
console.log(`Judging transcript with ${transcript.length} messages...`);
const judgment = await judge.evaluateTranscript(transcript, {
  taskOrigin: record.taskOrigin as "human" | undefined,
  specAuthorship: record.specAuthorship as "mixed" | undefined,
  initiationMode: record.initiationMode as "dispatched" | undefined,
});
console.log(`Judgment: tier=${judgment.tier}, rationale="${judgment.rationale.slice(0, 200)}..."`);
console.log(`  substantiveHumanInput: ${judgment.substantiveHumanInput.slice(0, 150)}...`);
console.log(`  trajectoryChanges: ${judgment.trajectoryChanges.length} items`);

const provenanceService = new ProvenanceService(db);
await provenanceService.updateWithJudgment(record.artifactId, "pr", judgment);
console.log(
  `✅ Updated provenance record for PR ${record.artifactId} with judged tier ${judgment.tier}`
);

await provider.close();
