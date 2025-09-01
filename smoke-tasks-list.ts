import { TasksListCommand } from "./src/adapters/shared/commands/tasks/crud-commands";
import type { CommandExecutionContext } from "./src/adapters/shared/commands/command-registry";

async function main() {
  const cmd = new TasksListCommand();
  const ctx: CommandExecutionContext = {
    interface: "cli",
    debug: false,
    format: "json",
    cliSpecificData: { command: undefined as any, rawArgs: [] },
  };
  const result = await cmd.execute({ json: true } as any, ctx);
  console.log(JSON.stringify({ ok: true, count: Array.isArray(result) ? result.length : (result as any)?.count, sample: Array.isArray(result) ? (result as any[]).slice(0,1) : undefined }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
