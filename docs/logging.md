# Minsky Logging System

Minsky uses a structured logging system that is environment-aware, providing appropriate log formats based on the execution context.

## Logging Modes

Minsky supports two primary logging modes:

- **HUMAN** (default for CLI usage): Clean, human-readable logs only
- **STRUCTURED** (for CI/CD, integrations): Full JSON logs for machine consumption

## Configuration

### Environment Variables

The logging system can be configured using these environment variables:

| Variable            | Description                     | Default | Example                  |
| ------------------- | ------------------------------- | ------- | ------------------------ |
| `MINSKY_LOG_MODE`   | Sets the logging mode           | `HUMAN` | `MINSKY_LOG_MODE=HUMAN`  |
| `LOGLEVEL`          | Sets the logging level          | `info`  | `LOGLEVEL=debug`         |
| `ENABLE_AGENT_LOGS` | Enables JSON logs in HUMAN mode | `false` | `ENABLE_AGENT_LOGS=true` |

The level variable is `LOGLEVEL`, with no underscore. The config system additionally accepts
`LOG_LEVEL` and `MINSKY_LOG_LEVEL` as aliases for `logger.level`, but `@minsky/shared/logger` reads
its own environment directly — deliberately, to avoid a circular import — and that read looks only
at `LOGLEVEL`. Setting `LOG_LEVEL` alone therefore does not change the shared logger's level.

### Mode is not auto-detected (mt#2464)

**The mode does not vary by TTY.** Unset, `MINSKY_LOG_MODE` resolves to `HUMAN` everywhere —
terminal, pipe, container, CI alike. Set it to `STRUCTURED` to get JSON on stdout.

This paragraph used to claim the opposite, and the gap was load-bearing: `STRUCTURED` is what puts
domain logs on stdout, so anyone reasoning about a deployed service from these docs concluded that
its `log.info` output was already going somewhere. It was not. `infra/index.ts` carries the
workaround that resulted — a hand-set `MINSKY_LOG_MODE: "STRUCTURED"` on `minsky-ops` alone, added
when that service came up silent.

Auto-detection was not added because `STRUCTURED` writes to **stdout**, which two consumers already
own: a piped CLI payload, and the MCP stdio transport's JSON-RPC stream. Flipping the mode by TTY
would corrupt both. What varies by terminal instead is the diagnostic sink below, which writes to
stderr and collides with neither.

### Where `log.debug` / `log.info` / `log.warn` go

In `STRUCTURED` mode, or with `ENABLE_AGENT_LOGS=true`, all three go to the JSON agent logger on
stdout. In `HUMAN` mode the destination depends on whether a person is positioned to read them,
which is a question about **stderr**:

| stderr         | Destination              | Rationale                                                                                                                                                  |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a terminal     | dropped                  | An operator running a command should not have domain diagnostics printed at them. This is the long-standing CLI behavior.                                  |
| a pipe or file | plain text on **stderr** | A container, CI job, supervised daemon, or MCP stdio child. Something is capturing stderr, so discarding is pure loss — and stdout stays clean either way. |

…unless the process has declared itself a **one-shot command**, which discards regardless. A CLI
invocation run from a script also has captured stderr, and its streams belong to the command:
`minsky security check-credentials --quiet` documents that it prints nothing on any path, and the
bootstrap chatter that runs before any command handler would break that.

`src/cli.ts` declares `setProcessRole("one-shot-command")` before configuration setup. The `start`
subcommands that are themselves long-running servers declare their way back — `mcp start` directly,
and the cockpit daemon inside `installDaemonFileLogging()`, so a future caller of that function
inherits it. The default is `long-running-service`: an entry point that declares nothing ends up
visible, because silence-by-default is the failure this design removes. An explicit
`MINSKY_LOG_MODE=STRUCTURED` outranks the role.

Railway files everything on stderr as `level.error` and colours it red, per
[its logging docs](https://docs.railway.com/observability/logs) — which is why each line here
carries a `warn:` / `info:` prefix, and why `STRUCTURED` (single-line JSON, whose `level` field
Railway reads) is the option to reach for when per-line severity matters more than readability.
Note also Railway's 500 log-lines-per-second-per-replica limit: a service that emits a large burst
can have lines dropped.

Before mt#2464 the second row also dropped the line, which meant a deployed service wrote its boot
diagnostics nowhere at all. The symptom looked like a platform ingest problem (a Railway deploy log
containing nothing but `Starting Container`); the cause was that nothing was ever written.

The test is on stderr rather than stdout on purpose. Under `minsky ... | jq`, stdout is a pipe but
the operator is still watching stderr — keying on stdout would start printing boot chatter at a
command that is silent today.

`log.error` is unaffected: it has always fallen back to stderr in `HUMAN` mode, which is why an
error and a warning emitted side by side during the same boot used to behave differently.

`scripts/verify-diagnostic-sink.ts` asserts both rows against real file descriptors.

## Log Types

Minsky makes a distinction between two types of logs:

1. **Agent Logs** (JSON format to stdout):

   - Structured data for machine consumption
   - Detailed context and metadata
   - Used for system events, debug information, and machine-readable output
   - Disabled by default in HUMAN mode unless `ENABLE_AGENT_LOGS=true`

2. **Program Logs** (plain text to stderr):
   - Human-readable messages
   - Clean, concise output
   - Used for user-facing CLI feedback and error messages
   - Always enabled in both HUMAN and STRUCTURED modes

## Using the Logger

For developers, Minsky provides a consistent logging API through the `log` object. Import it from
**`@minsky/shared/logger`** — the canonical implementation. `packages/domain/src/utils/logger.ts`
still re-exports the same symbols so older domain-internal import sites keep working, but new code
should name the shared package directly.

```typescript
import { log } from "@minsky/shared/logger";

// Agent logs (JSON to stdout)
log.agent("Operation completed", { userId: "123" }); // info level
log.debug("Debug information", { data: someObject }); // Silenced in HUMAN mode, enabled in STRUCTURED mode
log.warn("Warning condition", { code: 100 });
log.error("Error occurred", new Error("Something went wrong"));

// Program logs (plain text to stderr)
log.cli("User-facing message");
log.cliWarn("User-facing warning");
log.cliError("User-facing error");
log.cliDebug("Debug message for CLI"); // Only shown when LOG_LEVEL=debug
log.systemDebug("System debug message"); // Always shows in stderr when debug level is enabled, regardless of mode
```

### Mode-Aware Methods

- `log.debug()`: routed by the sink table above — JSON on stdout in STRUCTURED mode (or with `ENABLE_AGENT_LOGS=true`), dropped at a terminal, plain text on stderr when stderr is captured. Level filtering applies on top of that, so at the default `info` level it emits nothing regardless of sink.

- `log.systemDebug()`: This method always logs to stderr using programLogger regardless of the current mode. Use it for important system debugging information that should always be visible when debug level is enabled.

### Checking Current Mode

You can check the current logging mode using:

```typescript
import { isHumanMode, isStructuredMode } from "@minsky/shared/logger";

if (isHumanMode()) {
  // Behavior specific to HUMAN mode
}

if (isStructuredMode()) {
  // Behavior specific to STRUCTURED mode
}
```

## Best Practices

1. **Choose the appropriate log type**:

   - Use agent logs (`log.agent`, `log.debug`, etc.) for internal events and structured data
   - Use program logs (`log.cli`, `log.cliDebug`, etc.) for user-facing output
   - Use `log.systemDebug` for critical system debugging in any mode

2. **Set appropriate log levels**:

   - Use `debug` for verbose information useful for debugging
   - Use `info` for standard operational information
   - Use `warn` for concerning but non-error conditions
   - Use `error` for failure conditions

3. **Provide context**:

   - Always add relevant context objects to agent logs
   - Keep human-readable messages concise but informative

4. **Handle errors properly**:

   - Use `log.cliError()` for user-facing error messages
   - Use `log.error()` for detailed error logging

5. **Test in both modes**:
   - Test your implementation in both HUMAN and STRUCTURED modes
   - Verify the output is appropriate for each context

## Debug Logging Guidelines

When adding debug logs, follow these guidelines:

1. For general system debugging that should be visible in both modes when debug is enabled:

   ```typescript
   log.systemDebug("Important system information", { context });
   ```

2. For detailed internal debugging that should only appear in STRUCTURED mode (or when explicitly enabled):

   ```typescript
   log.debug("Internal system event", { detailedContext });
   ```

3. For CLI-specific debugging that should always go to stderr:
   ```typescript
   log.cliDebug("CLI-related debug info");
   ```

This ensures that debug logs don't clutter terminal output but are available when needed for troubleshooting.

## Log files on disk (cockpit daemon)

The cockpit daemon persists logs under `~/.local/state/minsky/logs/`; every
family is size-bounded:

| File(s)                                                  | Writer                                                             | Rotation                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `cockpit-daemon.log` (+`1..4`)                           | winston File transport (`src/cockpit/daemon-file-log.ts`, mt#2894) | built-in `maxsize`/`maxFiles`: 20 MB x 5                                                                 |
| `cockpit-stdout.log` / `cockpit-stderr.log` (+`.1`/`.2`) | supervisor stdio redirect (tray `open_log()` / launchd plist)      | in-daemon copytruncate sweep (`src/cockpit/stdio-log-rotation.ts`, mt#3298): 50 MB cap, 2 retained, 60 s |
| `cockpit-build.log`                                      | tray web-bundle build watcher                                      | none (small; revisit if it grows)                                                                        |

Mechanism detail and the rotation-policy rationale live in
`docs/architecture/cockpit.md` (search "Stdio-redirect log rotation").
