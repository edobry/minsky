import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { TasksListCommand } from "./src/adapters/shared/commands/tasks/crud-commands";
import { SessionListCommand } from "./src/adapters/shared/commands/session/basic-commands";
import { sharedCommandRegistry } from "./src/adapters/shared/command-registry";
import { registerRulesCommands } from "./src/adapters/shared/commands/rules";
import type { CommandExecutionContext } from "./src/adapters/shared/command-registry";

async function main() {
  await initializeConfiguration(new CustomConfigFactory(), { skipValidation: true, enableCache: true });

  const ctx: CommandExecutionContext = {
    interface: "cli",
    debug: false,
    format: "json",
    cliSpecificData: { command: undefined as any, rawArgs: [] },
  };

  // tasks.list
  const tasksCmd = new TasksListCommand();
  const tasks = await tasksCmd.execute({ json: true } as any, ctx as any);
  console.log(JSON.stringify({ command: "tasks.list", count: Array.isArray(tasks) ? tasks.length : (tasks as any)?.count, sample: Array.isArray(tasks) ? tasks.slice(0, 1) : undefined }, null, 2));

  // session.list with since/until
  const sessionCmd = new SessionListCommand();
  const sessionsResult = await sessionCmd.executeCommand({ json: true, since: "365d" } as any, ctx);
  console.log(JSON.stringify({ command: "session.list", count: (sessionsResult as any)?.data?.sessions?.length ?? (sessionsResult as any)?.sessions?.length ?? 0 }, null, 2));

  // rules.list via registry
  registerRulesCommands(sharedCommandRegistry);
  const rulesCmd = sharedCommandRegistry.getCommand("rules.list")!;
  const rulesResult = await rulesCmd.execute({ json: true, since: "365d" } as any, ctx as any);
  console.log(JSON.stringify({ command: "rules.list", count: (rulesResult as any)?.rules?.length ?? 0 }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });