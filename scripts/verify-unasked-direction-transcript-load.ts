#!/usr/bin/env bun
// Verification artifact for mt#3046 — does the repaired hook actually load a
// transcript now?
//
// `post-merge-unasked-direction-scan.ts`'s `loadTranscript` returned null on
// every invocation from the day it shipped until mt#3046: its dynamic import of
// the persistence factory threw `tsyringe requires a reflect polyfill` in a bare
// hook process, and its own `catch { return null }` swallowed the throw. The
// hook treats null as a no-op, so a permanently-dead scan was indistinguishable
// from "that session had no transcript" — and unlike mt#3019's instance there
// was no DB-row evidence, because the findings file was simply never written.
//
// This calls the REAL exported function (not a re-implementation of its import
// sequence), from a bare Bun process with no CLI or MCP boot ahead of it — the
// same conditions the hook runs under.
//
// Read-only: it loads a transcript and counts the messages. Nothing is written.
//
// SCOPE (mt#3066) — this script checks the BOOTSTRAP, not the lookup key.
// The default id below is a CONVERSATION id picked by hand because it is known
// to have a stored transcript. Production does not supply it: the hook used to
// pass a WORKSPACE session id out of the `session_pr_merge` payload, so this
// script passed while the scan was still dead — proving the repaired function
// works given an input the caller never provides. That gap is what mt#3066
// fixed. For the id-space check (does the hook resolve the id PRODUCTION
// supplies?) use `scripts/verify-unasked-direction-scan-lookup.ts`, which
// refuses to be handed a working id and builds a real payload instead.
//
// Usage:  bun scripts/verify-unasked-direction-transcript-load.ts [conversationId]
// Exit:   0 = pass (or SKIP with no DB configured), non-zero = fail.
//
// @see mt#3046 — this task; the lint rule that found the defect
// @see mt#3019 — the first instance of the same class
// @see mt#3066 — the id-space defect this script's own framing helped hide
// @see .minsky/hooks/domain-bootstrap.ts — the bootstrap under test

import { loadTranscript } from "../.minsky/hooks/post-merge-unasked-direction-scan";
import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";
import type { ConversationId } from "@minsky/domain/ids";

const hasDbConfig =
  Boolean(process.env.MINSKY_PERSISTENCE_POSTGRES_URL) ||
  Boolean(process.env.MINSKY_POSTGRES_URL) ||
  Boolean(process.env.DATABASE_URL);

// Skip cleanly when the environment cannot reach a database — an environment
// gap, not a defect in the code under test (mt#3019 §7a artifact contract).
const bootstrap = await ensureHookDomainBootstrap();
if (!bootstrap.ok && !hasDbConfig) {
  process.stdout.write(
    `SKIP: no Postgres configured — bootstrap cannot complete here: ${bootstrap.error}\n`
  );
  process.exit(0);
}

// A CONVERSATION id with a stored transcript — see the SCOPE note above; this
// is deliberately not the id production passes. Override via argv.
const conversationId = (process.argv[2] ??
  "6422032f-e798-4fb3-af68-fe9f981cb590") as ConversationId;

process.stdout.write(
  `Loading transcript for conversation ${conversationId} via the hook's own loadTranscript...\n`
);

const transcript = await loadTranscript(conversationId);

if (transcript === null) {
  process.stdout.write(
    "FAIL  loadTranscript returned null — this is the exact pre-mt#3046 symptom.\n" +
      "      Either the bootstrap is missing again, or this conversation genuinely has no\n" +
      "      stored transcript (try another conversation id as argv[1]).\n"
  );
  process.exit(1);
}

if (!Array.isArray(transcript) || transcript.length === 0) {
  process.stdout.write(
    `FAIL  loadTranscript returned a non-null but empty result (${JSON.stringify(transcript).slice(0, 80)}).\n`
  );
  process.exit(1);
}

const roles = new Set(transcript.map((m) => (m as { role?: string }).role).filter(Boolean));
process.stdout.write(
  `PASS  loadTranscript returned ${transcript.length} messages (roles: ${[...roles].join(", ") || "n/a"}).\n` +
    `      Before mt#3046 this call returned null for every session, always.\n`
);
process.exit(0);
