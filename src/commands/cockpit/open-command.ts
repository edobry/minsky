import { Command } from "commander";
import { spawnSync } from "child_process";
import { resolveRunningCockpit, type ResolvedCockpit } from "./url-command";

/**
 * How long to wait on the launcher process. `open`/`xdg-open` hand off to the OS
 * and return immediately; a bound here only guards against a wedged launcher
 * hanging the command that is supposed to be the FAST path (mt#3807).
 */
const LAUNCH_TIMEOUT_MS = 5_000;

/** What `cockpit open` should do, decided without touching the OS. */
export type OpenPlan =
  | { kind: "error"; message: string[] }
  | { kind: "open"; conversationId: string; targets: string[] };

export interface PlanDeps {
  /** The conversation id from the environment, when no explicit one is given. */
  envConversationId: string | undefined;
  /** The running cockpit serving this workspace, or null. */
  resolved: ResolvedCockpit | null;
}

/**
 * Decide which URLs to try, in order.
 *
 * `minsky://` first so the tray cockpit WINDOW fronts rather than a browser tab;
 * the browser URL is the fallback for a machine with no tray installed. Both are
 * planned up front so the launcher is a dumb loop and this function — the part
 * with the actual decisions in it — is testable without opening anything.
 */
export function buildOpenPlan(deps: PlanDeps): OpenPlan {
  const conversationId = deps.envConversationId?.trim();
  if (!conversationId) {
    return {
      kind: "error",
      message: [
        "CLAUDE_CODE_SESSION_ID is unset — cannot identify a conversation.",
        "Pass one explicitly: minsky cockpit open --conversation <id>",
      ],
    };
  }

  const targets = [`minsky://conversation/${encodeURIComponent(conversationId)}`];
  if (deps.resolved) {
    targets.push(`${deps.resolved.state.url}/conversation/${encodeURIComponent(conversationId)}`);
  }
  return { kind: "open", conversationId, targets };
}

/**
 * Launch a URL through the platform opener. `open` is macOS; `xdg-open` covers
 * Linux. The tray — and so the `minsky://` handler — is macOS-only, but the
 * browser fallback is not, so both go through one path.
 */
export function launchUrl(url: string): boolean {
  for (const opener of ["open", "xdg-open"]) {
    const result = spawnSync(opener, [url], { timeout: LAUNCH_TIMEOUT_MS, stdio: "ignore" });
    // ENOENT on the opener itself means "not this platform's launcher" — try the
    // next one. Any other failure is the launcher rejecting the URL (e.g. no
    // handler registered for the scheme), which is the fallback's cue.
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    if (!result.error && result.status === 0) return true;
    return false;
  }
  return false;
}

export function createOpenCommand(): Command {
  const cmd = new Command("open");
  cmd
    .description("Open a conversation in the cockpit's conversation view")
    .addHelpText(
      "after",
      [
        "",
        "Inside a Claude Code session, run it in bash mode so it costs no model turn:",
        "  !minsky cockpit open",
        "",
        "The /cockpit slash command does the same thing and is discoverable from the",
        "command list, but a slash command IS a prompt — it spends a model turn on a",
        "command that has no decision in it.",
      ].join("\n")
    )
    .option(
      "--conversation <id>",
      "Conversation (harness agent-session) id; defaults to $CLAUDE_CODE_SESSION_ID"
    )
    .action((options: { conversation?: string }) => {
      const plan = buildOpenPlan({
        envConversationId: options.conversation ?? process.env["CLAUDE_CODE_SESSION_ID"],
        resolved: resolveRunningCockpit(process.cwd()),
      });

      if (plan.kind === "error") {
        for (const line of plan.message) console.error(line);
        process.exit(1);
      }

      for (const target of plan.targets) {
        if (launchUrl(target)) {
          console.log(`OPENED ${target}`);
          return;
        }
      }

      console.error(`FAILED to open a cockpit view for ${plan.conversationId}.`);
      console.error(`  Tried: ${plan.targets.join(", ")}`);
      console.error("  Start a cockpit with `minsky cockpit start`, or install the tray app.");
      process.exit(1);
    });
  return cmd;
}
