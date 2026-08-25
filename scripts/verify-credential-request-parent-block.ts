#!/usr/bin/env bun
/**
 * Live verification for mt#4486 SC5 — a credential request blocks its parent
 * task, and satisfying the credential returns it.
 *
 * The hermetic tests drive `blockParentTask` / `releaseParentTask` against
 * injected deps, so they assert the DECISIONS. Nothing in them proves the wiring:
 * that `credentials.request` reaches a task service through the container, that
 * the entry status survives a round trip through the ask's jsonb payload, or
 * that the sweep's resolver finds the row and releases it. This runs the real
 * command, the real repository, the real task service and the real resolution
 * tick, and reads the task status back out of the database at each step.
 *
 * SC5 is what it is named for, but the same run is also the live half of SC1
 * (the request blocks the parent), SC2 (a satisfied request releases it, to the
 * status the entry status maps to), SC3 (the blocked task renders with its
 * blocking ask attached) and SC4 (a request with no `parentTaskId` is untouched
 * by any of it) — each of those was previously established by reading code, and
 * reading code cannot show a wire.
 *
 * ## What makes this a check rather than a demonstration
 *
 * A release step alone proves almost nothing: a `releaseParent` that ran
 * unconditionally would pass it. So the run is bracketed by a NEGATIVE CONTROL —
 * one full resolution tick with the credential still absent, after which the ask
 * must still be open and the parent must still read BLOCKED. Only then is the
 * credential made present and the tick run again.
 *
 * The control also covers this script's own worst failure mode.
 * `runCredentialRequestResolutionTick` swallows its errors by design (it rides a
 * sweep and must not take it down), so a resolver that throws on every call is
 * indistinguishable from one that correctly finds nothing — for the control step.
 * It is NOT indistinguishable at the release step, where the ask must come back
 * CLOSED. A silently broken tick therefore fails this script rather than passing
 * it twice.
 *
 * ## How the credential is made to arrive, and why not through the real config
 *
 * `listCredentials()` resolves its config directory through
 * `getUserConfigDir()`, which reads `XDG_CONFIG_HOME` at every call. This
 * redirects that variable at a scratch directory for the duration of the run:
 * first empty (credential absent), then holding a config.yaml with a placeholder
 * at the provider's own `configPath` (credential present). The presence signal is
 * produced by the real `listCredentials()` reading a real YAML file — only the
 * directory is redirected.
 *
 * Two things that buys, both deliberate:
 *
 * - **The operator's `~/.config/minsky/config.yaml` is never written.** Adding a
 *   real credential is not possible (there is nothing to add), and writing a fake
 *   one into the file that holds the live ones is not a trade worth making for a
 *   verification.
 * - **No other process can satisfy the request out from under the control step.**
 *   A local cockpit runs this same resolution tick against the REAL config on its
 *   own timer. Requesting a provider that is configured there would let that
 *   sweep close the ask mid-run — a race whose symptom is an unexplained failure
 *   at the control step. Hence the precondition below: the provider must be one
 *   the real config does NOT have.
 *
 * The placeholder is never read by anything — presence is the whole signal
 * (`hasNestedValue` tests for a non-empty value and the resolver never looks at
 * it) — and the scratch directory is removed before exit.
 *
 * ## What it writes, and what it puts back
 *
 * Two asks — one bound to the task, one deliberately unbound for SC4, both
 * closed by the exercise itself and cancelled by cleanup if the run does not get
 * that far — and two status transitions on the task you name. The task is
 * restored to its entry status on the way out; when the release was lossy
 * (IN-PROGRESS / IN-REVIEW have no edge back) the restore is reported as
 * impossible rather than forced.
 *
 * Usage:
 *   bun scripts/verify-credential-request-parent-block.ts --task mt#NNNN
 *   bun scripts/verify-credential-request-parent-block.ts --task mt#NNNN --provider supabase-service-role
 *
 * `--task` is required and has no default: this blocks and releases whatever you
 * name, so naming it is the caller's decision. It must be in a status the kind's
 * workflow allows `→ BLOCKED` from (a TODO task cannot be blocked at all).
 *
 * Exit codes:
 *   0 — checked, consistent
 *   1 — checked, INCONSISTENT (an assertion about observed state failed)
 *   2 — the check did not complete (bad arguments, unmet precondition, bootstrap
 *       error) — never conflated with a pass
 *
 * @see mt#4486
 * @see packages/domain/src/credentials/parent-task-gate.ts
 */

import "reflect-metadata";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify } from "yaml";

/** Written at the provider's configPath to make presence true. Never read. */
const PLACEHOLDER = "mt4486-verification-placeholder-not-a-credential";

/** Registered provider with no value in the real config — see the docblock. */
const DEFAULT_PROVIDER = "supabase-service-role";

const REASON =
  "Verification exercise for mt#4486 (SC5), filed by " +
  "scripts/verify-credential-request-parent-block.ts. It resolves itself within seconds. " +
  "No action needed — do not enter a credential for it.";

interface Args {
  taskId: string;
  provider: string;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  let taskId: string | undefined;
  let provider = DEFAULT_PROVIDER;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--task") taskId = argv[++i];
    else if (arg === "--provider") provider = argv[++i] ?? provider;
    else return { error: `unrecognized argument: ${arg}` };
  }
  if (!taskId) return { error: "--task <taskId> is required" };
  return { taskId, provider };
}

/** `a.b.c` + value → `{ a: { b: { c: value } } }`, for the scratch config.yaml. */
function nestAtPath(path: string, value: string): Record<string, unknown> {
  const parts = path.split(".");
  const root: Record<string, unknown> = {};
  let cursor = root;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = value;
      return;
    }
    const next: Record<string, unknown> = {};
    cursor[part] = next;
    cursor = next;
  });
  return root;
}

interface Finding {
  step: string;
  expected: string;
  observed: string;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`verify-credential-request-parent-block: ${parsed.error}`);
    return 2;
  }

  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { getCredentialProvider, listCredentials } = await import("@minsky/domain/credentials");
  const { decideParentBlock, decideParentRelease } = await import(
    "@minsky/domain/credentials/parent-task-block"
  );
  const { CREDENTIAL_REQUEST_RESPONDER } = await import(
    "@minsky/domain/credentials/request-resolver"
  );
  const { readCredentialRequest } = await import("@minsky/shared/credential-request");
  const { getOpenAsksByTaskIds } = await import("@minsky/domain/ask/queries");
  const { formatBlockedStatus } = await import("@minsky/domain/ask/blocked-subtype");
  const { requireAskRepository } = await import("../src/adapters/shared/commands/asks");
  const { createCredentialRequestRegistration } = await import(
    "../src/adapters/shared/commands/config/credential-request-command"
  );
  const { runCredentialRequestResolutionTick } = await import(
    "../src/cockpit/credential-request-sweep"
  );

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  if (!container.has("taskService")) {
    console.error("verify-credential-request-parent-block: no taskService in the container.");
    return 2;
  }
  const taskService = container.get("taskService");
  const gate = {
    async readTask(taskId: string) {
      const task = await taskService.getTask(taskId);
      if (!task) return null;
      return { status: task.status, kind: (task as { kind?: string | null }).kind ?? null };
    },
    async setStatus(taskId: string, status: string) {
      await taskService.setTaskStatus(taskId, status);
    },
  };

  const repo = await requireAskRepository(container, "verify-credential-request-parent-block");

  // Every read below happens BEFORE the config directory is redirected, so the
  // database connection and the ask repository are warm and nothing has to
  // re-resolve configuration while XDG_CONFIG_HOME points somewhere else.
  const entry = await gate.readTask(parsed.taskId);
  if (!entry) {
    console.error(`verify-credential-request-parent-block: task ${parsed.taskId} not found.`);
    return 2;
  }

  const blockDecision = decideParentBlock(entry);
  if (!blockDecision.block) {
    console.error(
      `verify-credential-request-parent-block: ${parsed.taskId} is ${entry.status} ` +
        `(kind ${blockDecision.kind}) and cannot be blocked — ${blockDecision.reason}. ` +
        `That is correct behaviour, not a failure; this exercise needs a blockable parent.`
    );
    return 2;
  }

  const provider = getCredentialProvider(parsed.provider);
  if (!provider) {
    console.error(
      `verify-credential-request-parent-block: no provider registered as "${parsed.provider}".`
    );
    return 2;
  }

  const realListing = await listCredentials();
  if (realListing.find((row) => row.provider === parsed.provider)?.configured) {
    console.error(
      `verify-credential-request-parent-block: "${parsed.provider}" IS configured in the real ` +
        `config, so a cockpit sweep running against it could satisfy this request mid-run and ` +
        `the negative control would fail for the wrong reason. Pick an unconfigured provider.`
    );
    return 2;
  }

  const findings: Finding[] = [];
  const expect = (step: string, expected: string, observed: string) => {
    if (expected !== observed) findings.push({ step, expected, observed });
  };

  const scratchRoot = mkdtempSync(join(tmpdir(), "mt4486-credential-"));
  const scratchConfigDir = join(scratchRoot, "minsky");
  mkdirSync(scratchConfigDir, { recursive: true });
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = scratchRoot;

  const record: Record<string, unknown> = {
    task: parsed.taskId,
    provider: parsed.provider,
    entryStatus: entry.status,
    expectedReleaseTarget: decideParentRelease(entry.status),
  };
  const filedRequestIds: string[] = [];

  try {
    // The redirect must actually be what the presence read follows. Absent here
    // is uninformative on its own (this provider is absent in both configs) —
    // the flip to present after the write is what proves it.
    const absent = await listCredentials();
    expect(
      "redirected config reports the provider absent",
      "false",
      String(absent.find((row) => row.provider === parsed.provider)?.configured ?? false)
    );

    const registration = createCredentialRequestRegistration(container);
    const requested = (await registration.execute(
      { provider: parsed.provider, reason: REASON, parentTaskId: parsed.taskId, json: true },
      undefined as never
    )) as {
      requestId: string;
      shortId?: string;
      state: string;
      parentBlocked?: boolean;
      parentBlockOutcome?: string;
    };
    filedRequestIds.push(requested.requestId);
    record.request = {
      requestId: requested.requestId,
      shortId: requested.shortId,
      askState: requested.state,
      parentBlocked: requested.parentBlocked,
      parentBlockOutcome: requested.parentBlockOutcome,
    };
    expect(
      "credentials.request reports the parent blocked",
      "blocked",
      String(requested.parentBlockOutcome)
    );

    // READ 1 — the task status, out of the database, after the request.
    const afterRequest = await gate.readTask(parsed.taskId);
    record.readAfterRequest = afterRequest;
    expect("task status after the request", "BLOCKED", String(afterRequest?.status));

    const askAfterRequest = await repo.getById(requested.requestId);
    const payload = readCredentialRequest(askAfterRequest);
    record.payloadAfterRequest = payload;
    expect("ask carries the parent task id", parsed.taskId, String(askAfterRequest?.parentTaskId));
    expect("ask records the entry status", entry.status, String(payload?.parentEntryStatus));

    // SC3 — the consumer check, run while the task is actually BLOCKED.
    //
    // Planning verified this by READING the code: `authorization.approve` maps
    // to the `authorization` subtype, so a blocked parent renders
    // `BLOCKED(authorization)` with the ask attached. That inference has a step
    // it cannot see — `findOpenByTaskIds` decides what counts as OPEN, and a
    // credential request sits in `suspended`, not `routed`. If suspended were
    // excluded, every task this feature blocks would render a bare BLOCKED with
    // no explanation, which is the one outcome SC3 exists to rule out.
    const enrichment = (await getOpenAsksByTaskIds(repo, [parsed.taskId])).get(parsed.taskId);
    record.blockedEnrichment = {
      askId: enrichment?.id,
      shortId: enrichment?.shortId,
      kind: enrichment?.kind,
      rendered: formatBlockedStatus(enrichment ?? null),
    };
    expect(
      "the BLOCKED task's enrichment finds THIS request",
      requested.requestId,
      String(enrichment?.id)
    );
    expect(
      "the BLOCKED task renders with its subtype",
      "BLOCKED(authorization)",
      formatBlockedStatus(enrichment ?? null)
    );

    // SC4 — the parameter must still be optional. Filed in the SAME run rather
    // than a separate one so it rides the same arrival: a second request, no
    // `parentTaskId`, which must succeed, report no parent fields at all, and
    // resolve normally. It also exercises the resolver's own `if
    // (!ask.parentTaskId) return` guard against a real row, which is the path a
    // release that ran unconditionally would trip over.
    const unparented = (await registration.execute(
      {
        provider: parsed.provider,
        reason: `${REASON} (SC4 control: no parent task)`,
        // Explicit `undefined`, not an omitted key: the command reads the VALUE,
        // and an omitted optional field is exactly what zod parses to undefined,
        // so this is what a caller who left it out actually hands the execute.
        parentTaskId: undefined,
        json: true,
      },
      undefined as never
    )) as Record<string, unknown>;
    filedRequestIds.push(unparented.requestId as string);
    const unparentedAsk = await repo.getById(unparented.requestId as string);
    record.unparentedRequest = {
      requestId: unparented.requestId,
      shortId: unparented.shortId,
      parentFieldsReported: Object.keys(unparented).filter((key) => key.startsWith("parent")),
      askParentTaskId: unparentedAsk?.parentTaskId ?? null,
    };
    expect("a request with no parent task succeeds", "true", String(unparented.success === true));
    expect(
      "a request with no parent task reports no parent fields",
      "",
      Object.keys(unparented)
        .filter((key) => key.startsWith("parent"))
        .join(",")
    );
    expect(
      "a request with no parent task binds no task",
      "null",
      String(unparentedAsk?.parentTaskId ?? null)
    );

    // NEGATIVE CONTROL — a full production tick with the credential still absent.
    await runCredentialRequestResolutionTick(repo, gate);
    const askAfterControl = await repo.getById(requested.requestId);
    const afterControl = await gate.readTask(parsed.taskId);
    record.controlTick = { askState: askAfterControl?.state, task: afterControl };
    expect(
      "ask is still open after the control tick",
      "false",
      String(askAfterControl?.state === "closed")
    );
    expect("task is still BLOCKED after the control tick", "BLOCKED", String(afterControl?.status));

    // ARRIVAL — the credential becomes present, out of band, exactly as it would
    // if the principal had entered it in the cockpit form or a terminal.
    writeFileSync(
      join(scratchConfigDir, "config.yaml"),
      stringify(nestAtPath(provider.configPath, PLACEHOLDER)),
      { mode: 0o600 }
    );
    const present = await listCredentials();
    if (!present.find((row) => row.provider === parsed.provider)?.configured) {
      // Not a finding: the exercise never reached the behaviour under test.
      console.error(
        `verify-credential-request-parent-block: the credential did not read as present after ` +
          `writing ${provider.configPath} into the scratch config — the redirect is not what ` +
          `listCredentials() follows for this provider, so the release step would prove nothing.`
      );
      return 2;
    }

    await runCredentialRequestResolutionTick(repo, gate);

    // READ 2 — the same status read, after the credential arrived.
    const askAfterRelease = await repo.getById(requested.requestId);
    const afterRelease = await gate.readTask(parsed.taskId);
    record.readAfterRelease = afterRelease;
    record.releaseTick = {
      askState: askAfterRelease?.state,
      responder: (askAfterRelease?.response as { responder?: string } | null | undefined)
        ?.responder,
    };
    expect("ask is closed after the credential arrived", "closed", String(askAfterRelease?.state));
    expect(
      "ask closed as credential-satisfied",
      CREDENTIAL_REQUEST_RESPONDER,
      String((askAfterRelease?.response as { responder?: string } | null | undefined)?.responder)
    );
    expect(
      "task status after the release",
      decideParentRelease(entry.status).target,
      String(afterRelease?.status)
    );

    // The unparented request resolves on the same arrival — the release path
    // steps over it rather than failing on it.
    const unparentedAfterRelease = await repo.getById(unparented.requestId as string);
    expect(
      "the request with no parent task also closed",
      "closed",
      String(unparentedAfterRelease?.state)
    );
  } finally {
    process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    rmSync(scratchRoot, { recursive: true, force: true });

    const cleanup: string[] = [];

    for (const id of filedRequestIds) {
      const ask = await repo.getById(id);
      if (ask && ask.state !== "closed" && ask.state !== "cancelled" && ask.state !== "expired") {
        try {
          await repo.transition(id, "cancelled");
          cleanup.push(`cancelled the open request ${id}`);
        } catch (err) {
          cleanup.push(`could not cancel ${id}: ${String(err)}`);
        }
      }
    }

    const finalTask = await gate.readTask(parsed.taskId);
    if (finalTask && finalTask.status !== entry.status) {
      try {
        await gate.setStatus(parsed.taskId, entry.status);
        cleanup.push(`restored ${parsed.taskId} to ${entry.status}`);
      } catch (err) {
        // Expected when the release was lossy: BLOCKED has no edge back to
        // IN-PROGRESS or IN-REVIEW, so the entry status is unreachable from
        // where the task now sits. Reported rather than forced.
        cleanup.push(
          `left ${parsed.taskId} at ${finalTask.status} — no legal transition back to ` +
            `${entry.status}: ${String(err)}`
        );
      }
    }

    record.cleanup = cleanup;
    record.verdict = findings.length === 0 ? "consistent" : "INCONSISTENT";
    record.findings = findings;
    console.log(JSON.stringify(record, null, 2));
  }

  return findings.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Exit 2, never 1: "the check did not run" must not read as "the check failed".
    console.error("verify-credential-request-parent-block: check did not complete —", err);
    process.exit(2);
  });
