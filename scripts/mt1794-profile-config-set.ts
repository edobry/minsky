#!/usr/bin/env bun
/**
 * mt#1794 Issue 2 — profile config-set latency in-process so bun startup is
 * factored out. Measures: (a) ensure-dir, (b) load existing config,
 * (c) backup copy, (d) schema validation, (e) YAML serialize+write.
 *
 * Usage: bun scripts/mt1794-profile-config-set.ts
 */
import "reflect-metadata";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createConfigWriter } from "@minsky/domain/configuration/config-writer";
import { configurationSchema } from "@minsky/domain/configuration/schemas";
import * as YAML from "yaml";

const N = 10;

function ms(start: bigint): number {
  return Number((process.hrtime.bigint() - start) / 1_000n) / 1000;
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "mt1794-profile-"));
  process.env.XDG_CONFIG_HOME = tmp;

  const writer = createConfigWriter({
    createBackup: true,
    format: "yaml",
    validate: true,
  });

  console.log(`temp config dir: ${tmp}`);
  console.log(`N=${N} runs per phase\n`);

  // Phase A: end-to-end setConfigValue (cold per iteration).
  // The writer recreates tmp/minsky/ via mkdir -p on each call, so rmSync
  // before the writer call is the cold-state setup.
  const e2e: number[] = [];
  for (let i = 0; i < N; i++) {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const start = process.hrtime.bigint();
    const result = await writer.setConfigValue(
      "observability.providers.braintrust.apiKey",
      `sk-test-${i}`
    );
    e2e.push(ms(start));
    if (!result.success) {
      console.error(`run ${i}: ${result.error}`);
      process.exit(1);
    }
  }

  // Phase B: just schema validation against a representative config
  const sampleConfig = {
    version: 1,
    backendConfig: {},
    persistence: {},
    observability: {
      providers: {
        braintrust: { apiKey: "sk-test" },
      },
    },
  };
  const valid: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = process.hrtime.bigint();
    configurationSchema.safeParse(sampleConfig);
    valid.push(ms(start));
  }

  // Phase C: YAML serialize+write only. Ensure tmp exists — Phase A may have
  // left it removed if its last iteration's writer call errored before
  // recreating the directory.
  mkdirSync(tmp, { recursive: true });
  const yamlWrite: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = process.hrtime.bigint();
    writeFileSync(join(tmp, `out-${i}.yaml`), YAML.stringify(sampleConfig));
    yamlWrite.push(ms(start));
  }

  rmSync(tmp, { recursive: true, force: true });

  const stats = (label: string, arr: number[]): void => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];
    console.log(
      `${label.padEnd(28)} mean=${mean.toFixed(1)}ms  p50=${p50.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  max=${max.toFixed(1)}ms`
    );
  };

  console.log("RESULTS");
  console.log("-------");
  stats("end-to-end setConfigValue", e2e);
  stats("schema validation only", valid);
  stats("YAML serialize+write only", yamlWrite);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
