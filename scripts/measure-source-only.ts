#!/usr/bin/env bun
/**
 * Quick source-path-only cold-start measurement for mt#1792.
 * Uses Bun.spawn for reliable subprocess control.
 */

const PACKAGE_ROOT =
  "/Users/edobry/.local/state/minsky/sessions/27e1c22c-11fc-4cde-805c-7467687f9c7d";
const SOURCE_PATH = `${PACKAGE_ROOT}/src/cli.ts`;
const N = parseInt(process.env.MEASURE_ITERATIONS ?? "5");

const INIT_REQUEST = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mt1792-bench", version: "1" },
  },
})}\n`;

async function measureOne(): Promise<Map<string, number> | null> {
  const checkpoints = new Map<string, number>();

  const proc = Bun.spawn(["bun", "run", SOURCE_PATH, "mcp", "start"], {
    cwd: PACKAGE_ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MINSKY_MCP_PROFILE: "1" },
  });

  // Send initialize request
  proc.stdin.write(INIT_REQUEST);
  proc.stdin.flush();

  // Collect stderr for checkpoints
  const stderrReader = proc.stderr.getReader();
  let stderrBuf = "";
  const stderrDone = (async () => {
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      stderrBuf += new TextDecoder().decode(value);
      for (const line of stderrBuf.split("\n")) {
        const m = line.match(/\[profile\] checkpoint=(\S+) t=(\d+(?:\.\d+)?)/);
        if (m && m[1] && m[2]) checkpoints.set(m[1], parseFloat(m[2]));
      }
    }
  })();

  // Read stdout until we get the initialize response
  const stdoutReader = proc.stdout.getReader();
  let stdoutBuf = "";
  let gotResponse = false;

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const readPromise = stdoutReader.read();
    const timeoutPromise = new Promise<null>((r) => setTimeout(() => r(null), 500));
    const raceResult = await Promise.race([readPromise, timeoutPromise]);

    if (raceResult === null) {
      // timeout tick — check if we already have enough
    } else {
      const { done, value } = raceResult as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      stdoutBuf += new TextDecoder().decode(value);
    }

    if (stdoutBuf.includes('"protocolVersion"')) {
      gotResponse = true;
      break;
    }
  }

  proc.kill();
  await stderrDone.catch(() => {});

  // Re-parse all checkpoints from accumulated stderr
  checkpoints.clear();
  for (const line of stderrBuf.split("\n")) {
    const m = line.match(/\[profile\] checkpoint=(\S+) t=(\d+(?:\.\d+)?)/);
    if (m && m[1] && m[2]) checkpoints.set(m[1], parseFloat(m[2]));
  }

  return gotResponse ? checkpoints : null;
}

const allCheckpoints: Map<string, number[]> = new Map();

console.log(`Running ${N} iterations (source path only)...`);

for (let i = 0; i < N; i++) {
  process.stdout.write(`  iteration ${i + 1}/${N}... `);
  const cps = await measureOne();
  if (cps && cps.size > 0) {
    for (const [k, v] of cps) {
      if (!allCheckpoints.has(k)) allCheckpoints.set(k, []);
      const bucket = allCheckpoints.get(k);
      if (bucket) bucket.push(v);
    }
    process.stdout.write(`ok (${cps.size} checkpoints)\n`);
  } else {
    process.stdout.write("TIMEOUT or no checkpoints\n");
  }
  await new Promise((r) => setTimeout(r, 500));
}

const keys = ["before_mcp_command_load", "mcp_command_module_loaded", "tools_registered"];

console.log("\nCheckpoint medians:");
const medians: Record<string, number> = {};
for (const key of keys) {
  const vals = allCheckpoints.get(key);
  if (vals && vals.length > 0) {
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    medians[key] = median;
    console.log(`  ${key}: ${median.toFixed(1)}ms  (n=${vals.length})`);
  }
}

const before = medians["before_mcp_command_load"];
const after = medians["mcp_command_module_loaded"];
if (before !== undefined && after !== undefined) {
  const delta = after - before;
  const baseline = 51.3; // pre-mt#1792 measurement from mcp-start-cold-start-results.json
  const reduction = ((baseline - delta) / baseline) * 100;
  console.log(`\nmcp_command_module_loaded stage delta: ${delta.toFixed(1)}ms`);
  console.log(`Baseline (pre-mt#1792): ${baseline}ms`);
  console.log(
    `Reduction: ${reduction.toFixed(1)}% (target: >=30% => <=${(baseline * 0.7).toFixed(1)}ms)`
  );
  console.log(reduction >= 30 ? "PASS (>=30% reduction)" : "FAIL (<30% reduction)");
} else {
  console.log("\nCould not compute delta — missing checkpoints.");
  console.log("Available keys:", [...allCheckpoints.keys()].join(", "));
}
