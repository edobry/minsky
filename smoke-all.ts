import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { TasksListCommand, TasksGetCommand } from "./src/adapters/shared/commands/tasks/crud-commands";
import { SessionListCommand, SessionGetCommand } from "./src/adapters/shared/commands/session/basic-commands";
import { sharedCommandRegistry } from "./src/adapters/shared/command-registry";
import { registerRulesCommands } from "./src/adapters/shared/commands/rules";
import { createSessionPrListCommand, createSessionPrGetCommand } from "./src/adapters/shared/commands/session/pr-subcommand-commands";
import type { CommandExecutionContext } from "./src/adapters/shared/command-registry";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function main() {
  await withTimeout(
    initializeConfiguration(new CustomConfigFactory(), { skipValidation: true, enableCache: true }),
    6000,
    "initializeConfiguration"
  );

  const ctx: CommandExecutionContext = {
    interface: "cli",
    debug: false,
    format: "json",
    cliSpecificData: { command: undefined as any, rawArgs: [] },
  };

  // tasks.list and tasks.get
  const tasksCmd = new TasksListCommand();
  const tasksResult = await withTimeout(tasksCmd.execute({ json: true } as any, ctx), 6000, "tasks.list");
  const tasksCount = Array.isArray(tasksResult) ? tasksResult.length : 0;
  const firstTaskId = Array.isArray(tasksResult) && tasksResult[0] ? (tasksResult as any)[0].id : undefined;
  console.log(
    JSON.stringify(
      { command: "tasks.list", count: tasksCount, sample: Array.isArray(tasksResult) ? (tasksResult as any[]).slice(0, 1) : [] },
      null,
      2
    )
  );
  if (firstTaskId) {
    const tasksGet = new TasksGetCommand();
    const taskGetRes = await withTimeout(
      tasksGet.execute({ taskId: firstTaskId, json: true } as any, ctx),
      6000,
      "tasks.get"
    );
    console.log(JSON.stringify({ command: "tasks.get", ok: Boolean(taskGetRes), id: firstTaskId }, null, 2));
  }

  // session.list and session.get
  const sessionList = new SessionListCommand();
  const sessionListRes = await withTimeout(
    sessionList.execute({ json: true } as any, ctx),
    6000,
    "session.list"
  );
  const sCount = (sessionListRes as any)?.sessions?.length ?? 0;
  const firstSession = (sessionListRes as any)?.sessions?.[0];
  const firstSessionName = firstSession?.name ?? firstSession?.sessionName ?? firstSession?.id ?? undefined;
  console.log(JSON.stringify({ command: "session.list", count: sCount }, null, 2));
  if (firstSessionName) {
    const sessionGet = new SessionGetCommand();
    const sGetRes = await withTimeout(
      sessionGet.execute({ json: true, name: firstSessionName } as any, ctx),
      6000,
      "session.get"
    );
    console.log(
      JSON.stringify({ command: "session.get", ok: Boolean((sGetRes as any)?.session), name: firstSessionName }, null, 2)
    );
  }

  // rules.list via registry (time filters)
  registerRulesCommands(sharedCommandRegistry);
  const rulesCmd = sharedCommandRegistry.getCommand("rules.list")!;
  const rulesResult = await withTimeout(
    rulesCmd.execute({ json: true, since: "365d" } as any, ctx as any),
    6000,
    "rules.list"
  );
  console.log(JSON.stringify({ command: "rules.list", count: (rulesResult as any)?.rules?.length ?? 0 }, null, 2));

  // session.pr list/get via factory commands
  const prListCmd = createSessionPrListCommand();
  const prGetCmd = createSessionPrGetCommand();
  const prList = await withTimeout(prListCmd.execute({ json: true } as any, ctx as any), 6000, "session.pr list");
  const prCount = (prList as any)?.pullRequests?.length ?? 0;
  console.log(JSON.stringify({ command: "session.pr list", count: prCount }, null, 2));
  const candidates: any[] = ((prList as any)?.pullRequests || []) as any[];
  const withPr = candidates.find((p) => Boolean(p?.prNumber) || Boolean(p?.url)) || candidates[0];
  if (withPr?.sessionName) {
    try {
      const prGet = await withTimeout(
        prGetCmd.execute({ json: true, name: withPr.sessionName, content: false } as any, ctx as any),
        6000,
        "session.pr get"
      );
      console.log(
        JSON.stringify({ command: "session.pr get", ok: Boolean((prGet as any)?.pullRequest?.sessionName), name: withPr.sessionName }, null, 2)
      );
    } catch (err) {
      console.log(
        JSON.stringify(
          { command: "session.pr get", ok: false, name: withPr.sessionName, error: (err as any)?.message || String(err) },
          null,
          2
        )
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
