#!/usr/bin/env bun
/**
 * Measures the id-resolution cost `ingestAll` pays per session, on a real
 * `~/.claude/projects` corpus (mt#3288).
 *
 * Both paths still exist on the same binary, so this is a self-contained
 * before/after rather than a comparison against a checkout of main:
 *
 *   - BEFORE — `readSession(id)`: no path, so the source resolves the id by
 *     walking `discoverSessions()`. This is what `ingestSession` used to do for
 *     every session, making a sweep quadratic in corpus size.
 *   - AFTER  — `readSession(id, jsonlPath)`: uses the path the session was
 *     discovered at, which is what `ingestSession` now passes.
 *
 * Read-only: opens transcript files, touches no database and no network.
 *
 * Usage:  bun scripts/measure-transcript-discovery-cost.ts [--samples N]
 * Env:    MINSKY_CLAUDE_PROJECTS_DIR overrides the corpus root (default
 *         `~/.claude/projects`); the script SKIPs cleanly when it is absent.
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { ClaudeCodeTranscriptSource } from "@minsky/domain/transcripts/claude-code-transcript-source";
import type {
  AgentSessionId,
  DiscoveredSession,
} from "@minsky/domain/transcripts/transcript-source";

const DEFAULT_SAMPLES = 12;

function parseSamples(argv: string[]): number {
  const i = argv.indexOf("--samples");
  if (i === -1) return DEFAULT_SAMPLES;
  const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLES;
}

async function drain(iter: AsyncIterable<unknown>): Promise<number> {
  let n = 0;
  for await (const _ of iter) n++;
  return n;
}

async function main(): Promise<number> {
  const corpus = process.env.MINSKY_CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
  if (!existsSync(corpus)) {
    console.log(`SKIP: no transcript corpus at ${corpus}`);
    return 0;
  }

  const samples = parseSamples(process.argv.slice(2));
  const source = new ClaudeCodeTranscriptSource({ claudeProjectsDir: corpus });

  const discoverStart = performance.now();
  const sessions: DiscoveredSession[] = [];
  for await (const s of source.discoverSessions()) sessions.push(s);
  const discoverMs = performance.now() - discoverStart;

  if (sessions.length === 0) {
    console.log(`SKIP: corpus at ${corpus} contains no transcripts`);
    return 0;
  }

  // Sample evenly across discovery order — the old path's cost scales with a
  // session's POSITION in that order, so sampling only the head would flatter it.
  const picks: DiscoveredSession[] = [];
  const stride = Math.max(1, Math.floor(sessions.length / samples));
  for (let i = 0; i < sessions.length && picks.length < samples; i += stride) {
    const pick = sessions[i];
    if (pick) picks.push(pick);
  }

  let beforeMs = 0;
  let afterMs = 0;
  for (const s of picks) {
    let t = performance.now();
    await drain(source.readSession(s.agentSessionId as AgentSessionId));
    beforeMs += performance.now() - t;

    t = performance.now();
    await drain(source.readSession(s.agentSessionId as AgentSessionId, s.jsonlPath));
    afterMs += performance.now() - t;
  }

  const beforePer = beforeMs / picks.length;
  const afterPer = afterMs / picks.length;
  const sweepBefore = (beforePer * sessions.length) / 1000;
  const sweepAfter = (afterPer * sessions.length) / 1000;

  const result = {
    corpus,
    sessions: sessions.length,
    sampled: picks.length,
    discoverSessionsMs: Math.round(discoverMs),
    perSessionMs: { before: +beforePer.toFixed(1), after: +afterPer.toFixed(1) },
    projectedSweepSeconds: { before: +sweepBefore.toFixed(1), after: +sweepAfter.toFixed(1) },
    speedup: `${(beforePer / Math.max(afterPer, 0.001)).toFixed(0)}x`,
  };

  console.log(JSON.stringify(result, null, 2));

  // The whole point of the change: id-resolution must stop dominating a read.
  if (afterPer > beforePer) {
    console.error("FAIL: path-scoped read is not faster than id-resolution");
    return 1;
  }
  return 0;
}

process.exit(await main());
